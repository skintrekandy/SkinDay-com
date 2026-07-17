// Netlify BACKGROUND Function: /.netlify/functions/generate-visualization-background
// Place in netlify/functions/ alongside prompts.js.
//
// The '-background' suffix makes Netlify run this asynchronously with a
// 15-minute budget (vs the 10-26s synchronous limit). It reads the stashed job
// from Netlify Blobs, runs the SAME gpt-image-1 edit as the original
// synchronous function, and writes the result back to Blobs for the poller.
//
// HYBRID MASKING (added): if the job carries a `maskB64`, it is passed to
// images.edit as the edit mask. gpt-image-1 then edits ONLY the transparent
// areas of the mask and leaves everything else pixel-identical to the original.
// This is what physically prevents the global beautification leak: with a mask
// the model cannot smooth skin, soften the under-eye, or slim the jaw outside
// the treated region, no matter what the prompt does. No mask = today's exact
// full-image behavior (backward compatible).
//
// M11 UPDATE: the reference system was rewritten.
//
//   The old scope rule fired references only for "Enhanced" (isStrongPass)
//   Sculptra. Enhanced no longer exists, so that gate never opened: the clinic
//   library, the gold refs, and every reference path were unreachable dead code.
//   The old lookup also queried columns that no longer exist (treatment_area,
//   approved, sex, sort_order) in a bucket that no longer exists
//   (reference-cases), and used billing.userId as the clinic id.
//
//   The gate is now CLINIC CONTEXT, which is what actually separates the two
//   products:
//     Consumer Visualize (skinday.com) sends NO clinic context. No reference is
//       used. A pay-as-you-go simulation is never grounded in any clinic's
//       private patient imagery, even when the signed-in user owns a clinic.
//     Clinic Visualize (clinic portal) sends clinicId EXPLICITLY. The worker
//       verifies that claim against clinic_memberships, then grounds in that
//       clinic's own approved, consented cases.
//
//   Gold references are REMOVED. A clinic with no approved cases gets no
//   reference rather than a stranger's outcome standing in for their house
//   style. VISUALIZE_GOLD_REF_FRONTAL / _R45 / _L45 are now unused.
//
//   References come through get_clinic_visualize_references, which returns a
//   case ONLY if it is visualize_approved and carries active 'store' and
//   'visualize' consent. A patient who withdraws visualize consent drops out of
//   the reference set immediately. Images are downloaded server-side from
//   clinic-cases-private with the service role; no signed URL to a private
//   patient photo is ever minted.
//
//   REQUIRED WIRING: the clinic Visualize entry point must include clinicId in
//   the job fields. Without it, every generation is consumer-mode.
//
// CLINIC LIBRARY: reference-guided generation (Sculptra only).
//   Reference lookup fires only for a verified clinic context. There are exactly
//   two outcomes:
//     1. The clinic's own approved, consented case matching treatment and angle
//        (phenotype match preferred). Passed as image[1] alongside the patient
//        photo (image[0]).
//     2. No reference. Used for every consumer generation, and for a clinic that
//        has no usable case. There is no third-party fallback.
//   The model uses the reference for visual grammar (volume character, lighting,
//   skin character) only; it does NOT copy the reference face, because image[0]
//   is the patient photo and the prompt explicitly locks identity.
//   referenceMode in the generation log records which branch fired:
//   'clinic_case' or null.
//
// Required env: OPENAI_API_KEY, BETA_ACCESS_PASSWORD
// Required for the clinic library:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already present for billing)
// Required packages: openai, @netlify/blobs   (npm i openai @netlify/blobs)

const OpenAI = require('openai');
const { getStore, connectLambda } = require('@netlify/blobs');
const { buildCorePrompt, CHIN_JAW_SAFETY, usesChinJawSafety, buildScenarioPrompt, buildPlanPrompt } = require('./prompts');
const { logGeneration } = require('./log-generation');

// === VERBATIM from generate-visualization.js. Do not diverge this copy in isolation. ===
const SERVER_SAFETY =
  " CRITICAL: this is a medical consultation photograph, not a beauty image. Apply ONLY the single localized change described above and change nothing else. " +
  "Do NOT smooth or retouch skin, remove or soften wrinkles, even out skin tone, brighten the image, raise contrast, slim the face or jaw, " +
  "enlarge the eyes, lift the brows, change the hairstyle, or apply any beautifying, younger-looking, or filter-like effect. " +
  "Keep the apparent age and ALL age-appropriate skin texture (pores, fine lines, folds) exactly as in the original. " +
  "Preserve unchanged: identity, ethnicity and ethnic features, bone structure, hair, clothing, jewellery, expression, head angle and pose, " +
  "camera framing and crop, and lighting and background. The result must read as the SAME photograph with only the treated area subtly adjusted. " +
  "Do not add text, labels, or watermarks.";

// DRIFT FLAG (resolved below): SERVER_SAFETY is still applied to filler and hdr,
// but NOT to Sculptra by default. For a masked Sculptra run the mask contains the
// folds, so the model is allowed to soften them spatially, while the SERVER_SAFETY
// text said "do NOT soften wrinkles" and "do not slim the face or jaw" - which also
// fights the v10.1 lateral-lift design. buildSculptraPrompt is Sculptra's own, more
// specific safety base, so the generic tail is dropped for it. The [safety:server]
// note hook re-appends it for staging A/B. See the prompt-assembly block below.

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false;
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

// M8: refund reserved credits when a metered generation fails (errors and
// moderation rejections alike). The `<jobId>:billing` blob is written by
// start-visualization and outlives the job payload. Idempotent end to end:
// the visualize_refund_credits RPC refuses a second refund for the same job,
// so retries and double invocations are safe. Beta-key jobs have no billing
// blob and are untouched. When the Supabase env vars are absent (beta-only
// deploy), this is a clean no-op.
async function refundIfBilled(store, jobId, note) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  try {
    const billing = await store.get(jobId + ':billing', { type: 'json' });
    if (!billing || !billing.userId || !(billing.cost > 0)) return;
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/visualize_refund_credits', {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: billing.userId, p_cost: billing.cost, p_job: jobId, p_note: note || 'generation failed' })
    });
    if (!res.ok) console.error('refund RPC failed: HTTP ' + res.status, (await res.text()).slice(0, 200));
    else console.log('refunded ' + billing.cost + ' credit(s) for job ' + jobId + ' (' + (note || 'generation failed') + ')');
  } catch (e) {
    console.error('refundIfBilled failed:', (e && e.message) || e);
  }
}

// M12: map the angle field (r45, l45, frontal, oblique_right, oblique_left, oblique)
// to the canonical three-token set used by the reference lookup and gold-ref env vars.
function canonicalAngle(raw) {
  const a = String(raw || '').toLowerCase().trim();
  if (a === 'r45' || a === 'right45' || a === 'oblique_right') return 'oblique_right';
  if (a === 'l45' || a === 'left45'  || a === 'oblique_left')  return 'oblique_left';
  return 'frontal'; // default
}

// Injected into the prompt whenever a reference image is passed.
// CRITICAL: gpt-image-1 requires explicit indexing when multiple images are
// provided -- it will ignore image[1] unless the prompt references it directly.
// The identity lock is equally critical: the reference is for treatment pattern
// only, never identity, skin, age, or ethnicity.
//
// The reference clause is now per treatment category, because "what to look at
// in the reference" is completely different across treatments. Telling the model
// to read cheek volume from a neurotoxin reference, or skin texture from a
// filler reference, points it at the wrong signal and produces a worse result
// than no reference at all.
const REFERENCE_WHAT_TO_READ = {
  biostim:
    'the degree of cheek volume, midface support, lateral lift, and soft-tissue re-inflation',
  filler:
    'the degree of projection, contour definition, and structural support in the treated area, and how restrained or pronounced the shaping is',
  tox:
    'the degree of dynamic line softening and muscle relaxation, and how much natural movement and expression is preserved',
  laser:
    'the degree of change in skin tone, texture, pigmentation, redness, and pore quality, and how much natural skin character is retained'
};

const TREATMENT_NAME = {
  biostim: 'biostimulator',
  filler:  'hyaluronic acid filler',
  tox:     'neurotoxin',
  laser:   'energy-based skin'
};

function referenceIdentityLock(type) {
  const what = REFERENCE_WHAT_TO_READ[type] || REFERENCE_WHAT_TO_READ.biostim;
  const name = TREATMENT_NAME[type] || TREATMENT_NAME.biostim;
  return (
    ' TWO IMAGES ARE PROVIDED. Image 1 is the patient to treat. Image 2 is a clinical reference showing a successful ' + name + ' result.' +
    ' Use Image 2 ONLY to understand the visual character of the treatment result: ' + what + '.' +
    ' Apply that same degree and character of change to Image 1 (the patient).' +
    ' Do NOT copy, borrow, or be influenced by the reference patient\'s identity, face shape, skin tone, ethnicity, age, skin texture, pigmentation, hair, expression, lighting, or any personal feature.' +
    ' The output must show Image 1 (the actual patient) with the ' + name + ' treatment applied at the visual intensity shown in Image 2.' +
    ' Image 2 is a style and intensity guide only -- never an identity donor.'
  );
}

// M11: verify an EXPLICIT clinic context.
//
// Clinic grounding is never inferred from who the user happens to be. The two
// products are separate entry points and must stay that way:
//
//   Consumer Visualize (skinday.com)  sends no clinic context. Pay-as-you-go,
//     the user's own credits, gold reference only. Even if that user owns a
//     clinic, no clinic's private patient imagery grounds their simulation.
//
//   Clinic Visualize (via the clinic portal) sends clinicId explicitly. Only
//     then is the clinic's own case library used.
//
// Inferring the clinic from membership would mean one account silently behaving
// two different ways with nothing on screen to explain it. Explicit wins.
//
// A clinic id arriving in a request is a CLAIM, not a fact, so it is verified
// against clinic_memberships here before anything is grounded in that clinic's
// patient photos. An unverified claim returns null and falls through to gold.
async function verifyClinicContext(userId, clinicId) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !userId || !clinicId) return null;
  try {
    const qs = new URLSearchParams({
      select:     'clinic_id',
      user_id:    'eq.' + userId,
      clinic_id:  'eq.' + clinicId,
      status:     'eq.active',
      revoked_at: 'is.null',
      limit:      '1'
    });
    const res = await fetch(SUPABASE_URL + '/rest/v1/clinic_memberships?' + qs.toString(), {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!res.ok) {
      console.warn('[M11] membership verification failed: HTTP ' + res.status);
      return null;
    }
    const rows = await res.json();
    if (!rows || !rows.length) {
      console.warn('[M11] clinic context REFUSED: user ' + userId
        + ' is not an active member of clinic ' + clinicId);
      return null;
    }
    console.log('[M11] clinic context verified: clinic ' + clinicId);
    return rows[0].clinic_id;
  } catch (e) {
    console.warn('[M11] verifyClinicContext error:', (e && e.message) || e);
    return null;
  }
}

// M12: WHAT A CROP CAN GROUND.
//
// Studio crops to a preset, and the preset is now recorded on the case. That
// matters here because a reference image only teaches the model anything if the
// treated region is actually in it. A lower-face crop shows a temple filler
// simulation nothing at all: there are no temples in the photograph. Passing it
// anyway is worse than passing nothing, because the model will still try to read
// treatment signal out of it and will read the wrong signal.
//
// Four bands, drawn to match the geometry in Studio's lmToBaseBox rather than to
// match anatomy textbooks, because what matters is what is inside the crop box:
//
//   forehead     forehead, temples, glabella
//   periorbital  brows, eyes, tear trough
//   midface      cheeks, nose, nasolabial folds
//   lowerface    lips, chin, jawline, masseter, marionette, neck
//
// The rule is coverage, not equality: a reference is usable when its crop
// contains EVERY region the treatment changes. Full face therefore grounds
// everything, and Body grounds nothing facial.
//
// This map lives here and not in SQL on purpose. The rule depends on the subtype
// vocabulary, which already lives here, and splitting one rule across two
// languages is how the two drift apart while nothing errors.
const CROP_COVERS = {
  full:  ['forehead', 'periorbital', 'midface', 'lowerface'],
  upper: ['forehead', 'periorbital'],
  eyes:  ['periorbital'],
  lower: ['midface', 'lowerface'],
  body:  []
};

// The regions a generation actually changes. Filler subtypes can name more than
// one area ('chin,jawline'), so the requirement is the union of them.
const FILLER_AREA_REGION = {
  chin: 'lowerface',
  jawline: 'lowerface',
  lips: 'lowerface',
  nasolabial_folds: 'midface',
  cheeks: 'midface',
  nose: 'midface',
  temple: 'forehead',
  tear_trough: 'periorbital'
};

function treatmentRegions(treatment, subtype) {
  if (treatment === 'filler') {
    const areas = String(subtype || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const regions = [];
    areas.forEach((a) => {
      const r = FILLER_AREA_REGION[a];
      if (r && regions.indexOf(r) === -1) regions.push(r);
    });
    // An unknown area is a vocabulary drift, not a licence to guess. Require the
    // whole face, which in practice means only a full-face case will ground it.
    return regions.length ? regions : ['forehead', 'periorbital', 'midface', 'lowerface'];
  }
  // Masseter slimming and the Nefertiti lift are both jaw and neck work.
  if (treatment === 'tox') return ['lowerface'];
  // Biostimulators and energy-based tightening are global volume and skin-quality
  // treatments across the middle and lower thirds. A crop that shows only the jaw
  // cannot demonstrate what they do to a cheek.
  if (treatment === 'biostim') return ['midface', 'lowerface'];
  if (treatment === 'laser')   return ['midface', 'lowerface'];
  return ['midface', 'lowerface'];
}

// null crop means the case predates M12. It is not excluded: punishing old work
// for a column that did not exist when it was saved would be a worse failure than
// the one this prevents, and those cases were almost all shot full face anyway.
function cropCanGround(crop, regions) {
  if (!crop) return true;
  const covers = CROP_COVERS[crop];
  if (!covers) return false;
  return regions.every((r) => covers.indexOf(r) !== -1);
}

// M11: look up the best approved clinic reference case for this generation.
// Returns { caseId, beforePath, afterPath } or null.
//
// This calls get_clinic_visualize_references rather than querying the table
// directly. That RPC is the ONLY place the consent rules live: it returns a
// case only when it is visualize_approved AND carries an active 'store' consent
// AND an active 'visualize' consent AND is not soft-deleted. A revoked consent
// therefore drops the case out of the model's reference set immediately, with
// no code here needing to know about it.
//
// Match priority within the returned set: phenotype match > untagged > any.
// (The old sex-based priority is gone: the M11 schema does not store sex, and
// adding a sex column to patient records is a data-minimization decision, not
// an incidental one.)
async function fetchClinicReferenceCase(clinicId, treatment, subtype, angle, phenotype, timelineMonths) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !clinicId) return null;

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_clinic_visualize_references', {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_clinic_id:       clinicId,
        p_treatment:       treatment || null,
        p_subtype:         subtype || null,
        p_angle:           angle || null,
        // The timeline the clinician asked for. The lookup prefers the case whose
        // interval is closest to it, so a 3-month simulation is grounded in
        // 3-month outcomes rather than 12-month ones. Grounding a 3-month
        // projection in a 12-month result would overpromise, which is exactly the
        // failure this architecture exists to prevent.
        p_timeline_months: timelineMonths,
        p_limit:           10
      })
    });
    if (!res.ok) {
      console.warn('[M11] clinic reference lookup failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
      return null;
    }
    const rows = await res.json();
    if (!rows || !rows.length) {
      console.log('[M11] no approved+consented references for clinic ' + clinicId
        + ' (treatment=' + treatment + ', angle=' + angle + ')');
      return null;
    }

    // M12: drop any case whose crop does not contain the region being treated.
    // A hard exclude, not a demotion. A reference that does not show the treated
    // area is not a weaker reference, it is a misleading one, and the honest
    // outcome is an ungrounded generation rather than a confidently wrong one.
    //
    // Deliberately NOT re-ranked afterwards. The rows arrive ordered by interval
    // closeness, which is the axis that makes a 3-month simulation look like
    // three months rather than twelve, and that is the stronger claim. Among the
    // crops that survive, all of them contain the treated region, so preferring
    // one over another would be taste dressed up as a rule.
    const regions = treatmentRegions(treatment, subtype);
    const usable = rows.filter(r => cropCanGround(r.crop, regions));

    if (!usable.length) {
      console.log('[M12] clinic ' + clinicId + ' has ' + rows.length + ' approved '
        + treatment + '/' + subtype + ' case(s) at ' + angle
        + ' but none whose crop contains [' + regions.join(',') + ']: no reference used'
        + ' (crops present: ' + rows.map(r => r.crop || 'none').join(',') + ')');
      return null;
    }
    if (usable.length < rows.length) {
      console.log('[M12] crop filter dropped ' + (rows.length - usable.length)
        + ' of ' + rows.length + ' candidate reference(s) for [' + regions.join(',') + ']');
    }

    const chosen =
      usable.find(r => phenotype && r.phenotype === phenotype) ||
      usable.find(r => !r.phenotype) ||
      usable[0];

    console.log('[M11] clinic reference chosen: case=' + chosen.case_id
      + ' phenotype=' + (chosen.phenotype || 'any')
      + ' angle=' + (chosen.angle || 'any')
      + ' crop=' + (chosen.crop || 'none'));
    return {
      caseId:         chosen.case_id,
      intervalMonths: chosen.interval_months,
      crop:           chosen.crop || null,
      beforePath:     chosen.before_path,
      afterPath:      chosen.after_path
    };
  } catch (e) {
    console.warn('[M11] fetchClinicReferenceCase error:', (e && e.message) || e);
    return null;
  }
}

// M11: download a private clinic case object with the service role and hand it
// to OpenAI as a file. No signed URL is minted, so no URL to a patient's
// private photo exists even briefly. The bytes go straight from Storage into
// the generation request, server-side, and are never persisted here.
async function fetchPrivateCaseFile(path, filename) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !path) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + '/storage/v1/object/clinic-cases-private/' + path,
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) {
      console.warn('[M11] private case fetch failed: HTTP ' + res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct  = res.headers.get('content-type') || 'image/jpeg';
    return await OpenAI.toFile(buf, filename || 'clinic_reference.jpg', { type: ct });
  } catch (e) {
    console.warn('[M11] fetchPrivateCaseFile error:', (e && e.message) || e);
    return null;
  }
}



// Resolve the reference image for a generation.
// Returns { refFile, referenceMode, referenceCaseIds }.
// referenceMode values: 'clinic_case' | null
//
// M13: referenceCaseIds is the provenance link. It says WHICH of the clinic's
// cases grounded this generation, not merely that one did. It is an array from
// the outset, because passing a matched set of references is coming and changing
// the shape later is worse than over-shaping it now. It is always present, empty
// when nothing grounded the generation, so no caller has to branch on its
// absence.
//
// This is server-side and authoritative. It is never client-supplied, which is
// what a field that records whose photograph shaped whose simulation has to be.
//
// SCOPE RULE. The old rule fired references only for "Enhanced" (isStrongPass)
// Sculptra. Enhanced no longer exists, which made this branch unreachable.
//
// The gate is now CLINIC CONTEXT, which is what actually separates the two
// products:
//
//   No clinic context (consumer Visualize on skinday.com)
//     -> no reference. A pay-as-you-go simulation is never grounded in any
//        clinic's private patient imagery.
//
//   Verified clinic context (clinic Studio / Visualize)
//     -> grounded in THAT clinic's own approved, consented cases.
//
// References now work across ALL treatment categories, not just Sculptra. The
// case's treatment must match the generation's treatment: a filler case never
// grounds a laser simulation. A mismatched reference is worse than none, since
// it points the model at the wrong visual signal entirely.
//
// There is no third-party fallback. A clinic with no matching approved case gets
// no reference rather than a stranger's outcome standing in for their own work.
async function resolveReference(f, billing) {
  // Canonical treatment key, shared with what the clinic stores on a case.
  const treatment = canonicalTreatment(f);
  if (!treatment) return { refFile: null, referenceMode: null, referenceCaseIds: [] };

  const userId            = billing ? billing.userId : null;
  const requestedClinicId = f.clinicId || f.clinic_id || null;

  if (!requestedClinicId) {
    console.log('[M11] no clinic context: consumer route, no reference');
    return { refFile: null, referenceMode: null, referenceCaseIds: [] };
  }

  // A clinic id in a job is a CLAIM. start-visualization already verified it;
  // it is verified again here because the worker must not depend on an upstream
  // caller having done so.
  const clinicId = await verifyClinicContext(userId, String(requestedClinicId));
  if (!clinicId) {
    console.warn('[M11] clinic context not verified: no reference used');
    return { refFile: null, referenceMode: null, referenceCaseIds: [] };
  }

  const angle     = canonicalAngle(f.angle || f.view);
  const phenotype = f.phenotype || f.sculptraPhenotype || null;
  const subtype   = canonicalSubtype(f, treatment);

  const timelineMonths = parseInt(f.timeline, 10);
  const caseRow = await fetchClinicReferenceCase(
    clinicId, treatment, subtype, angle, phenotype,
    Number.isFinite(timelineMonths) ? timelineMonths : null
  );
  if (caseRow) {
    const refFile = await fetchPrivateCaseFile(caseRow.afterPath, 'clinic_ref_after.jpg');
    if (refFile) {
      console.log('[M11] reference mode: clinic_case (clinic=' + clinicId
        + ' treatment=' + treatment + ' subtype=' + subtype + ' angle=' + angle
        + ' crop=' + (caseRow.crop || 'none')
        + ' asked=' + timelineMonths + 'mo got=' + caseRow.intervalMonths + 'mo)');
      return { refFile, referenceMode: 'clinic_case', referenceCaseIds: [caseRow.caseId] };
    }
  }

  console.log('[M11] clinic ' + clinicId + ' has no approved ' + treatment
    + '/' + subtype + ' case at ' + angle + ': no reference used');
  return { refFile: null, referenceMode: null, referenceCaseIds: [] };
}

// The canonical treatment key. This is the SAME vocabulary Studio and the clinic
// portal store on a case, so a generation and a case can be matched.
//   biostim  biostimulation
//   filler   HA filler
//   tox      neurotoxin
//   laser    energy-based devices (RF / HIFU)
function canonicalTreatment(f) {
  const t = (f && f.type) ? String(f.type) : '';
  if (t === 'biostim' || t === 'filler' || t === 'tox' || t === 'laser') return t;
  return null;
}

// The second matching axis. A chin filler case must not ground a lip filler
// simulation, a PLLA case must not ground a CaHA one, and RF must not ground
// HIFU. Studio stores exactly these values on a case.
//
// KEEP IN LOCKSTEP with Studio's dropdowns. If the two vocabularies drift, no
// reference ever matches and nothing indicates why: the simulation just comes
// back ungrounded.
function canonicalSubtype(f, treatment) {
  if (!f || !treatment) return null;
  if (treatment === 'biostim') return f.product ? String(f.product) : null;
  if (treatment === 'filler')  return f.areas ? String(f.areas) : null;
  if (treatment === 'tox')     return f.toxMode ? String(f.toxMode) : null;
  if (treatment === 'laser')   return f.laserType ? String(f.laserType) : null;
  return null;
}

// M12.5: SCENARIO PLANNER
// Analyzes both the original photo and the Visualize baseline using a vision
// text model, then returns a case-specific image generation prompt tailored
// to this patient's anatomy and the selected scenario.
//
// The planner looks at the actual face and decides what this specific case
// needs -- the same judgment an experienced injector makes. This replaces the
// static scenario templates for the listed scenarios and is the key quality
// improvement that bridges the gap between a fixed prompt library and adaptive
// clinical reasoning.
//
// Provider abstraction: SCENARIO_PLANNER_PROVIDER env var controls which model
// runs the planner (default 'openai', future option 'anthropic'). Currently
// only 'openai' is implemented; the abstraction makes A/B testing easy later.
//
// The planner prompt is careful to:
//   - Lead with what MUST be preserved (identity, skin, lighting, features)
//   - Analyze what the baseline already achieved
//   - Describe only the additional change this scenario adds
//   - Return a compact, specific image prompt rather than a long generic one
//
// Falls back to the static scenario prompt on any failure.

const SCULPTRA_EMPHASIS_SYSTEM = `You are an internal clinical prompt-composer for an aesthetic medicine AI tool.

Return exactly one short patient-specific emphasis sentence for a biostimulator 6-month scenario.
Do not return JSON. Do not return markdown. Do not write a full image prompt.
Format exactly:
Patient-specific emphasis: [priority zone]. Avoid: [specific risk].

Keep it under 40 words.`;

const SCENARIO_PLANNER_SYSTEM = `You are an internal clinical prompt-composer for an aesthetic medicine AI tool. You are NOT a patient-facing assistant. You do not produce medical advice or claims.

Your only job is to write a controlled image-editing prompt that tells an image model exactly what structural change to make and what must not change.

ABSOLUTE RULES you must follow:
- You are not trying to make the patient prettier, younger, or more attractive. You are writing a clinical simulation prompt.
- The output image must show the exact same person: same identity, same skin tone, same apparent age, same skin texture, same pores, same asymmetry, same hair, same clothing, same expression, same head angle, same lighting, same background.
- Never allow: skin smoothing, skin brightening, contrast increase, eye enlargement, brow lift, lip change, nose change, hair change, lighting change, or global beautification.
- Describe only the specific structural change the scenario adds. Be precise about location and magnitude.
- If the choice is between too much change and too little, always choose too little.
- The image prompt you write must be under 300 words. Shorter and more precise is better.

You must return valid JSON and nothing else. No preamble, no explanation, no markdown fences. The JSON must have exactly these four fields:
{
  "caseSummary": "1-2 sentences describing this patient's relevant anatomy and what the baseline already achieved",
  "scenarioStrategy": "1-2 sentences describing what this specific scenario should add for this patient",
  "imagePrompt": "the complete image-editing prompt to send to the image model, under 300 words",
  "riskFlags": ["list of specific risks to prohibit for this patient, e.g. avoid skin brightening, avoid anterior cheek fill, avoid chin over-projection"]
}`;

const SCENARIO_PLANNER_USER = {
  // M15: stronger_sculptra planner returns a SHORT patient-specific emphasis line only,
  // appended to the fixed incremental base prompt (which intensifies the baseline).
  // The planner must NOT rewrite the treatment description -- it overthinks and
  // produces cautious language. Its output is appended, never a replacement.
  stronger_sculptra: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (a moderate biostimulator response; THIS is the photo the image model will intensify).
Image 2 = the original pre-treatment photo (reference showing where this patient started).

YOUR JOB: Compare the two images and return ONE SHORT patient-specific emphasis sentence only.
Do NOT write a full image prompt. Do NOT describe the treatment. The base prompt is already fixed.
You are adding one sentence of patient-specific anatomical guidance for intensifying the response further.

Analyze:
- Where this patient STILL shows hollowing, descent, or lateral support loss in the baseline (Image 1)
- What specific zone needs the most additional emphasis (lateral cheek, preauricular, submalar, temple, prejowl)
- What to avoid for this specific face (e.g. do not add anterior cheek volume if the face is already round centrally)

Return ONLY this format (under 40 words):
"Patient-specific emphasis: [zone/priority for this patient]. Avoid: [specific risk for this patient's anatomy]."

Example: "Patient-specific emphasis: prioritize preauricular and lateral cheek support; submalar hollowing is the dominant remaining concern. Avoid: anterior cheek fill, do not make the face rounder centrally."`,

  add_chin_jaw_filler: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Write an image-editing prompt for the image model that tells it to edit Image 2 (the original photo) to show Sculptra baseline support PLUS chin and jawline HA filler together.

Analyze:
- Patient's lower-face anatomy in the original: chin projection, mandibular border, prejowl hollow, jowl
- Patient's sex (critical: male = wide squared chin, female = tapered defined oval lower third)
- The Sculptra lateral support the baseline already shows

Write the imagePrompt to simulate: the Sculptra lateral scaffold (at baseline level) PLUS chin projection and jawline definition from 2 syringes HA filler. Lower-face change must be visible in the silhouette. Everything above the lower third unchanged.`,

  add_temple_support: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Write an image-editing prompt for the image model that tells it to edit Image 2 (the original photo) to show Sculptra baseline support PLUS focused temple volume.

Analyze:
- Whether this patient shows temporal hollowing or flat temple contour in the original
- How much the baseline already improved the temple-to-cheek transition
- What additional temple support would be clinically visible

Write the imagePrompt to simulate: the Sculptra lateral scaffold (at baseline level) PLUS temporal hollow fill so the forehead-to-cheek arc reads more continuous. No change below the zygomatic arch, no change to eyes, brows, or eyelid.`,

  add_tear_trough: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Write an image-editing prompt for the image model that tells it to edit Image 2 (the original photo) to show the baseline support PLUS under-eye (tear trough) hyaluronic acid correction.

Analyze:
- The depth and shape of this patient's tear trough hollow and lid-cheek junction in the original
- Whether the under-eye darkness is from a true hollow (shadow cast by depression, correctable with filler) versus pigmentation (NOT correctable, must not be erased)
- How much support the upper medial cheek needs to smooth the transition

Write the imagePrompt to simulate: the tear trough hollow filled and supported from beneath so the lid-cheek junction reads smooth and the shadow softens naturally. Subtle and natural, never puffy or over-filled. Do not change eye shape/size/lid/lashes, do not brighten or erase pigmentation, do not touch the lower face, lips, nose, or brows.`,

  add_nose_filler: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Write an image-editing prompt for the image model that tells it to edit Image 2 (the original photo) to show the baseline support PLUS a subtle nasal HA filler result (liquid rhinoplasty).

Analyze:
- This patient's nasal profile in the original: is there a dorsal hump, tip ptosis, tip definition, nasal asymmetry?
- What ONE or TWO nasal refinements would be most clinically visible and appropriate
- The ethnicity and face shape (East Asian noses have different filler targets than Caucasian)

Write the imagePrompt to simulate: the specific nasal change(s) this face needs -- smooth the dorsal hump if present, refine and slightly lift the tip if drooping, correct minor asymmetry if visible. Choose only what this nose actually needs. The result must look like a subtle, skilled injector result: the same nose, slightly more refined. Never a dramatic reshape, never a surgical result. Do not narrow nostrils, do not change nose width from the front, do not touch lips, chin, eyes, cheeks, or any other zone.`,

  combination_plan: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Write an image-editing prompt for the image model that tells it to edit Image 2 (the original photo) to show a full multi-modality combination treatment result.

Analyze:
- What the baseline (Image 1) already achieved vs the original
- This patient's three most prominent anatomical concerns in the original (hollowing, descent, lower-face imbalance, temple, etc.)
- Patient sex for correct chin geometry
- What combination of Sculptra support + chin/jaw filler + temple volume would create the strongest clinical impression for THIS face

Write the imagePrompt to simulate: strong lateral Sculptra scaffold + chin/jaw HA filler + temple volume -- all from the original photo in one pass. Three localized changes, anatomically precise, proportional to what this face needs. Must read as same person, comprehensively supported.`
};

async function runScenarioPlanner({ client, scenarioKey, view, sex, angle, baselineB64, baseMime, originalB64, origMime, staticFallback, provider }) {
  const userTemplate = SCENARIO_PLANNER_USER[scenarioKey];
  if (!userTemplate) {
    console.warn('[M12.5] no planner template for scenarioKey=' + scenarioKey + ', using static fallback');
    return staticFallback;
  }

  const isOblique = (view === 'oblique_left' || view === 'oblique_right' || view === 'l45' || view === 'r45' || view === 'oblique');
  const viewNote = isOblique
    ? '\n\nVIEW: Three-quarter oblique. Preserve exact head angle, crop, and perspective. Do not rotate toward frontal.'
    : '\n\nVIEW: Frontal. Preserve exact frontal pose and head position.';
  const sexNote = sex ? ('\n\nPATIENT SEX: ' + sex + '. This affects chin shape goals significantly.') : '';

  const userContent = [
    { type: 'text', text: userTemplate + viewNote + sexNote }
  ];

  // Attach baseline image first (Image 1 = context: what Sculptra already achieved)
  userContent.push({
    type: 'image_url',
    image_url: { url: 'data:' + (baseMime || 'image/jpeg') + ';base64,' + baselineB64, detail: 'high' }
  });

  // Attach original photo second (Image 2 = the photo the image model will actually edit)
  if (originalB64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: 'data:' + (origMime || 'image/jpeg') + ';base64,' + originalB64, detail: 'high' }
    });
  }

  if (provider !== 'openai') {
    console.warn('[M12.5] provider=' + provider + ' not implemented, falling back to openai');
  }

  const plannerModel = process.env.SCENARIO_PLANNER_MODEL || 'gpt-4o';
  const plannerTimeoutMs = parseInt(process.env.SCENARIO_PLANNER_TIMEOUT_MS || '8000', 10);
  const isSculptraEmphasis = (scenarioKey === 'stronger_sculptra');

  // stronger_sculptra: plain text (one emphasis line appended to fixed base)
  // all others: JSON object with imagePrompt + riskFlags
  const responseFormat = isSculptraEmphasis
    ? undefined
    : { type: 'json_object' };

  // Race the planner call against a timeout so a slow model never blocks generation.
  const plannerCallPromise = client.chat.completions.create({
    model: plannerModel,
    max_tokens: 600,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    messages: [
      { role: 'system', content: isSculptraEmphasis ? SCULPTRA_EMPHASIS_SYSTEM : SCENARIO_PLANNER_SYSTEM },
      { role: 'user', content: userContent }
    ]
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('planner timeout after ' + plannerTimeoutMs + 'ms')), plannerTimeoutMs)
  );

  let response;
  try {
    response = await Promise.race([plannerCallPromise, timeoutPromise]);
  } catch (e) {
    console.warn('[M12.5] planner call failed or timed out:', (e && e.message) || e, '-- using static fallback');
    return staticFallback;
  }

  const raw = response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
  if (!raw || raw.trim().length < 10) {
    console.warn('[M12.5] planner returned empty response, using static fallback');
    return staticFallback;
  }

  // M12.7: for stronger_sculptra, the planner returns a patient-specific emphasis
  // line only, which is appended to the fixed SCULPTRA_SCENARIO_BASE.
  // For all other scenarios, the planner output is used as the full imagePrompt.
  // This prevents the planner from overthinking and writing cautious language for Sculptra.
  const isSculptraEmphasisMode = (scenarioKey === 'stronger_sculptra');

  let imagePrompt;
  if (isSculptraEmphasisMode) {
    // The planner returned a patient-specific emphasis line.
    // Use the fixed base from staticFallback (which is SCULPTRA_SCENARIO_BASE)
    // and append the emphasis line.
    const emphasisLine = raw.trim();
    imagePrompt = staticFallback + ' ' + emphasisLine;
    console.log('[M12.7] Sculptra emphasis mode: appended "' + emphasisLine.slice(0, 80) + '"');
  } else {
    // Parse JSON for other scenarios
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('[M12.5] planner JSON parse failed, using static fallback. raw:', raw.slice(0, 200));
      return staticFallback;
    }

    imagePrompt = parsed.imagePrompt && parsed.imagePrompt.trim();
    if (!imagePrompt || imagePrompt.length < 50) {
      console.warn('[M12.5] planner imagePrompt missing or too short, using static fallback');
      return staticFallback;
    }

    // Append riskFlags as additional hard prohibitions
    let riskFlags = Array.isArray(parsed.riskFlags) && parsed.riskFlags.length > 0 ? parsed.riskFlags : null;
    if (riskFlags) {
      riskFlags = riskFlags
        .map(r => String(r || '').trim().slice(0, 60))
        .filter(r => r.length > 4)
        .slice(0, 5);
      if (riskFlags.length > 0) {
        imagePrompt += ' ADDITIONAL PATIENT-SPECIFIC PROHIBITIONS: ' + riskFlags.map(r => '- ' + r).join('; ') + '.';
      }
    }

    console.log('[M12.5] planner OK | case: ' + (parsed.caseSummary || '').slice(0, 80)
      + ' | strategy: ' + (parsed.scenarioStrategy || '').slice(0, 80)
      + ' | risks: ' + (riskFlags ? riskFlags.join(', ') : 'none')
      + ' | prompt length: ' + imagePrompt.length);
  }

  return imagePrompt;
}

exports.handler = async (event) => {
  connectLambda(event); // wire Blobs context into the classic handler signature
  let jobId;
  try { jobId = JSON.parse(event.body || '{}').jobId; } catch (e) { /* ignore */ }
  if (!jobId) return { statusCode: 400 };

  const store = getStore('visualize-jobs');

  // M13. The two store.delete calls in this file used to live only in the two
  // success paths, and they were written to free a large payload, not to protect
  // a patient. Where cost and privacy happened to agree, the photograph went.
  // Where they did not, it stayed: a failed or moderation-blocked generation left
  // the patient's uploaded photograph in the blob store permanently, at full
  // upload resolution, and the code's own comment notes that moderation blocks
  // are a frequent trigger for lip edits. So this is not a rare corner.
  //
  // fail() is the single funnel for every non-success exit. Dropping the payload
  // here means no path out of this handler can leave the photograph behind.
  const fail = async (error, code) => {
    try { await store.setJSON(jobId + ':status', { state: 'error', error, code: code || 'error', updatedAt: Date.now() }); } catch (e) { /* ignore */ }
    try { await store.delete(jobId + ':job'); } catch (e) { /* ignore */ }
  };

  // Background endpoints are public URLs, so re-check the key.
  if (!checkKey(event)) { await fail('Unauthorized background invocation', 'INVALID_KEY'); return { statusCode: 401 }; }

  let modelName = 'unknown'; // hoisted so the catch block can log it safely

  try {
    const job = await store.get(jobId + ':job', { type: 'json' });
    if (!job) {
      await fail('Job payload not found (it may have expired).', 'not_found');
      await refundIfBilled(store, jobId, 'job payload expired');
      return { statusCode: 200 };
    }

    const f = job.params || {};

    // ── M17 v2: SINGLE-PASS COMBINATION PLAN ─────────────────────────────────
    // One gpt-image-2 edit of the ORIGINAL photo for the whole treatment plan,
    // instead of the layered chain (primary + one add-on pass per treatment).
    // Motivation (Rejuuv Sculptra+chin/jaw+nose evidence): each layered pass
    // re-renders the whole frame, so photographic fidelity compounds down over
    // 3-4 passes. One pass returns to the same NUMBER of edits as any single
    // treatment (whether it also returns to the same output QUALITY is exactly
    // what the blinded A/B decides -- a combined prompt is a harder task).
    //
    // The prompt is buildPlanPrompt (prompts.js): one photographic-preservation
    // contract, one concise contribution per treatment, one overlap rule, one
    // untreated-feature lock, one magnitude ceiling. NO compositor and NO hybrid
    // region composite here -- this is the clean single-pass arm. Any final
    // region composite is a separate, later, opt-in arm and must never paste an
    // untreated original feature back over the generated result.
    const isPlan = (f.planMode === 'true' || f.planMode === true);
    if (isPlan) {
      let plan = null;
      try { plan = (typeof f.plan === 'string') ? JSON.parse(f.plan) : f.plan; } catch (e) { plan = null; }
      if (!plan || !plan.primary) {
        await fail('Plan mode missing or invalid plan', 'bad_request');
        await refundIfBilled(store, jobId, 'invalid plan');
        return { statusCode: 200 };
      }

      let planPrompt;
      try {
        planPrompt = buildPlanPrompt(plan, f.view || 'frontal');
      } catch (e) {
        await fail('Could not build plan prompt: ' + ((e && e.message) || 'error'), 'bad_request');
        await refundIfBilled(store, jobId, 'plan prompt build failed');
        return { statusCode: 200 };
      }

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // Single-pass edits the ORIGINAL photo directly. The client posts the
      // original patient photo as `image`; there is no baseline and no planner.
      const originalB64  = job.imageB64;
      const originalMime = job.mime || 'image/jpeg';
      if (!originalB64) {
        await fail('Plan mode missing source image', 'bad_request');
        await refundIfBilled(store, jobId, 'plan missing image');
        return { statusCode: 200 };
      }
      const planBuffer = Buffer.from(originalB64, 'base64');
      const planFile   = await OpenAI.toFile(planBuffer, 'original.jpg', { type: originalMime });

      // gpt-image-2 default (same model the single-treatment and scenario paths
      // use); env override so the A/B can pin a model without a redeploy.
      const imageModel = process.env.PLAN_IMAGE_MODEL || 'gpt-image-2';
      const planParams = {
        model: imageModel,
        image: planFile,
        prompt: planPrompt,
        size: 'auto',
        output_format: 'jpeg',
        output_compression: 92
      };
      if (imageModel === 'gpt-image-1') planParams.input_fidelity = 'high';

      const addonCount = Array.isArray(plan.addons) ? plan.addons.length : 0;
      console.log('[M17 plan] single-pass | model=' + imageModel + ' | primary=' +
        ((plan.primary && plan.primary.type) || '?') + ' | addons=' + addonCount +
        ' | view=' + (f.view || 'frontal'));

      const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);

      let planResult;
      try {
        planResult = await client.images.edit(planParams);
      } catch (err) {
        const code = err && (err.code || (err.error && err.error.code));
        const msg = (err && err.message) || '';
        const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
        if (blocked) {
          await fail('The AI provider blocked this plan edit under its safety system. Try a different photo or plan.', 'moderation_blocked');
          await refundIfBilled(store, jobId, 'moderation blocked');
          await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: imageModel }).catch(() => {});
        } else {
          await fail(msg || 'Plan generation failed', code || 'error');
          await refundIfBilled(store, jobId, code ? String(code) : 'plan generation failed');
          await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: imageModel }).catch(() => {});
        }
        return { statusCode: 200 };
      }

      const b64 = planResult.data && planResult.data[0] && planResult.data[0].b64_json;
      if (!b64) {
        await fail('No image returned for plan', 'no_image');
        await refundIfBilled(store, jobId, 'no image returned');
        return { statusCode: 200 };
      }

      await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
      await store.setJSON(jobId + ':status', { state: 'done', model: imageModel, updatedAt: Date.now() });
      try { await store.delete(jobId + ':job'); } catch (e) { /* free payload */ }

      try {
        await logGeneration({
          jobId,
          userId: billing ? billing.userId : null,
          betaKeyUsed: !billing,
          treatmentType: 'plan',
          angle: f.angle || null,
          isRegen: false,
          model: imageModel,
          imageSize: planParams.size || 'auto',
          imageQuality: planParams.input_fidelity || 'n/a',
          // Record the plan shape so the A/B can be sliced by primary type and
          // add-on count without re-parsing the (already-deleted) job payload.
          scenarioKey: 'plan:' + ((plan.primary && plan.primary.type) || '?') + '+' + addonCount,
          plannerUsed: false,
          plannerProvider: null,
          rawScenarioMode: null,
          openAIUsage: planResult.usage || null,
          creditsCharged: billing ? billing.cost : null,
          referenceMode: null,
          status: 'success',
        });
      } catch (logErr) { console.error('[logGeneration] plan success log failed:', logErr.message); }

      return { statusCode: 200 };
    }

    // M12.2: SCENARIO MODE
    // M15 ARCHITECTURE: scenarios edit the BASELINE image directly, for ALL
    // baseline types (Sculptra included). Add-ons must stack on top of the
    // result already shown -- a scenario may never display less correction
    // than the baseline it builds on. This extends the proven M14 cross-type
    // direct-edit path (incremental prompt, gpt-image-2, no compositor) to
    // Sculptra baselines, replacing the M12.6 edit-from-original approach,
    // which made every scenario an independent draw whose quality had no
    // floor tied to the baseline.
    // The raw AI result is still displayed directly: no compositor, no mask,
    // no warp. (Compositor was removed in M12.7 after it caused artifacts and
    // suppressed aesthetic lift. Do not reintroduce it for scenario generation.)
    const isScenario = (f.scenarioMode === 'true' || f.scenarioMode === true);
    if (isScenario) {
      const scenarioKey = f.scenarioKey;
      if (!scenarioKey) {
        await fail('Scenario mode missing scenarioKey', 'bad_request');
        await refundIfBilled(store, jobId, 'missing scenarioKey');
        return { statusCode: 200 };
      }

      let staticPrompt;
      try {
        staticPrompt = buildScenarioPrompt(scenarioKey, f.view || 'frontal', f.baselineType);
      } catch (e) {
        await fail('Invalid scenario key: ' + scenarioKey, 'bad_request');
        await refundIfBilled(store, jobId, 'invalid scenarioKey');
        return { statusCode: 200 };
      }

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // M15 role mapping:
      // Frontend sends: image = BASELINE (edit target), originalImage = original photo
      // start-visualization stores: image → job.imageB64, originalImage → job.originalImageB64
      // So: job.imageB64 = baseline image (edit target for the image model)
      //     job.originalImageB64 = original pre-treatment photo (planner reference only)
      const baselineB64     = job.imageB64;                    // baseline (add-on edit target + planner context)
      const baselineMime    = job.mime || 'image/jpeg';
      const originalRefB64  = job.originalImageB64 || null;    // original pre-treatment photo
      const originalRefMime = job.originalMime || 'image/jpeg';

      // M16: stronger_sculptra is the SAME treatment at a higher dose, generated
      // FRESH from the original photo -- NOT an add-on stacked on the baseline. Its
      // prompt (SCULPTRA_SCENARIO_BASE) already instructs the model to edit the
      // original photo; editing the baseline instead compounds the baseline's own
      // beautification and leaves no clean delta vs the baseline. So for
      // stronger_sculptra the edit target is the ORIGINAL photo. Every other
      // scenario stays an add-on that edits the baseline. The real baseline still
      // rides along as planner context below.
      // M16: stronger_sculptra is the SAME treatment at a higher dose, generated
      // FRESH from the original photo -- NOT an add-on stacked on the baseline. Its
      // prompt (SCULPTRA_SCENARIO_BASE) already instructs the model to edit the
      // original photo; editing the baseline instead compounds the baseline's own
      // beautification and leaves no clean delta vs the baseline. So for
      // stronger_sculptra the edit target is the ORIGINAL photo. Every other
      // scenario stays an add-on that edits the baseline. The real baseline still
      // rides along as planner context below.
      const editFromOriginal = (scenarioKey === 'stronger_sculptra') && !!originalRefB64;
      const sourceImageB64   = editFromOriginal ? originalRefB64  : baselineB64;
      const sourceImageMime  = editFromOriginal ? originalRefMime : baselineMime;

      const primaryBuffer = Buffer.from(sourceImageB64, 'base64');
      const primaryFile   = await OpenAI.toFile(primaryBuffer, editFromOriginal ? 'original.jpg' : 'baseline.jpg', { type: sourceImageMime });
      console.log('[M16] scenario edit target: ' + (editFromOriginal ? 'ORIGINAL photo' : 'baseline image') + ' (' + sourceImageMime + ') | scenario=' + scenarioKey);

      // Planner context (unchanged): baseline = what Sculptra already achieved
      // (Image 1), original = where the patient started (Image 2). These stay the
      // TRUE baseline and TRUE original regardless of which one is the edit target.
      const baselineB64ForPlanner = baselineB64;
      const originalB64ForPlanner = originalRefB64;
      const origMimeForPlanner    = originalRefMime;

      // M12.5: SCENARIO PLANNER
      // Before generating the image, run a vision-capable text model to analyze
      // both images and produce a case-specific scenario prompt. This replaces the
      // static template for the specified scenarios and is the key quality improvement
      // over a fixed prompt. Falls back to staticPrompt on any error so generation
      // is never blocked. Provider is controlled by SCENARIO_PLANNER_PROVIDER env var
      // (default 'openai') so it can be swapped to 'anthropic' for A/B testing later.
      // add_lips_filler is intentionally NOT in this list: it uses the static
      // prompt only (the planner tends to over-hedge lip changes into invisibility).
      // M15: planner is now stronger_sculptra ONLY. Its emphasis line (patient-
      // specific zone priority) composes correctly with the incremental base
      // prompt. All other planner templates were written for the old edit-from-
      // original architecture: their output REPLACES the prompt entirely and
      // re-describes the full plan, which would break stacking on the baseline.
      const PLANNER_SCENARIOS = ['stronger_sculptra'];
      const plannerProvider = process.env.SCENARIO_PLANNER_PROVIDER || 'openai';
      // Kill switch: set SCENARIO_PLANNER_ENABLED=false in Netlify env to disable
      // the planner without redeploying code. Useful if planner output is unexpected
      // right before a demo. Defaults to enabled.
      const plannerEnabled = process.env.SCENARIO_PLANNER_ENABLED !== 'false';
      let scenarioPrompt = staticPrompt;
      let plannerUsed = false;

      // M14: planner is Sculptra-locked (its templates describe the baseline as a
      // Sculptra response), so it runs ONLY for Sculptra baselines. Cross-type
      // baselines (filler / laser) skip the planner and use the static add-on prompt,
      // which edits the already-treated baseline image directly.
      const isSculptraBaseline = (f.baselineType === 'biostim' || !f.baselineType);
      if (plannerEnabled && isSculptraBaseline && PLANNER_SCENARIOS.includes(scenarioKey) && sourceImageB64) {
        try {
          scenarioPrompt = await runScenarioPlanner({
            client,
            scenarioKey,
            view: f.view || 'frontal',
            sex: f.sex || null,
            angle: f.angle || null,
            baselineB64: baselineB64ForPlanner,   // baseline = planner context (what Sculptra achieved)
            baseMime: sourceImageMime,
            originalB64: originalB64ForPlanner,   // original = what the image model will edit
            origMime: origMimeForPlanner,
            staticFallback: staticPrompt,
            provider: plannerProvider
          });
          plannerUsed = true;
          console.log('[M12.5] planner succeeded for ' + scenarioKey + ' (provider=' + plannerProvider + ')');
        } catch (planErr) {
          console.warn('[M12.5] planner failed, using static prompt fallback:', (planErr && planErr.message) || planErr);
          scenarioPrompt = staticPrompt;
          plannerUsed = false;
        }
      }

      const SCENARIO_FIDELITY = {
        stronger_sculptra:   'high',  // diagnostic confirmed: low fidelity breaks identity; high is the least-bad on gpt-image-1.
        combination_plan:    'high',
        add_chin_jaw_filler: 'high',
        add_temple_support:  'high',
        add_tear_trough:     'high'
      };

      // M15: swappable image model per scenario.
      // ALL scenarios now direct-edit the baseline image -- the exact case
      // gpt-image-2 was validated for in M14 (better identity preservation and
      // prompt adherence on contour edits). gpt-image-2 is therefore the default
      // for every scenario. Env overrides are retained so any scenario can be
      // pinned to a different model without a redeploy:
      //   SCENARIO_SCULPTRA_IMAGE_MODEL -- model for stronger_sculptra
      //   SCENARIO_FILLER_IMAGE_MODEL   -- model for lips / nose / cross-type add-ons
      //   SCENARIO_IMAGE_MODEL          -- model for all other scenarios
      // IMPORTANT: gpt-image-2 always processes inputs at high fidelity and rejects
      // input_fidelity. So input_fidelity is omitted for any model other than gpt-image-1.
      const isCrossTypeScenario = (f.baselineType === 'filler' || f.baselineType === 'laser' || f.baselineType === 'tox');
      const FILLER_SCENARIOS = ['add_lips_filler', 'add_nose_filler'];
      const imageModel = (scenarioKey === 'stronger_sculptra')
        ? (process.env.SCENARIO_SCULPTRA_IMAGE_MODEL || 'gpt-image-2')
        : (isCrossTypeScenario || FILLER_SCENARIOS.includes(scenarioKey))
          ? (process.env.SCENARIO_FILLER_IMAGE_MODEL || 'gpt-image-2')
          : (process.env.SCENARIO_IMAGE_MODEL || 'gpt-image-2');

      // M15: image = baseline only. Single image, one clean incremental pass.
      const scenarioParams = {
        model: imageModel,
        image: primaryFile,
        prompt: scenarioPrompt,
        size: 'auto',
        output_format: 'jpeg',
        output_compression: 92
      };
      // input_fidelity only applies to gpt-image-1. gpt-image-2 always runs high-fidelity
      // and will error if the param is passed.
      if (imageModel === 'gpt-image-1') {
        scenarioParams.input_fidelity = SCENARIO_FIDELITY[scenarioKey] || 'high';
      }
      console.log('[M12.8] scenario image model: ' + imageModel + ' (scenario=' + scenarioKey + ')');
      // No mask for scenario generations.

      const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);

      let scenarioResult;
      try {
        scenarioResult = await client.images.edit(scenarioParams);
      } catch (err) {
        const code = err && (err.code || (err.error && err.error.code));
        const msg = (err && err.message) || '';
        const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
        if (blocked) {
          await fail('The AI provider blocked this scenario edit under its safety system. Try a different photo or scenario.', 'moderation_blocked');
          await refundIfBilled(store, jobId, 'moderation blocked');
          await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: imageModel }).catch(() => {});
        } else {
          await fail(msg || 'Scenario generation failed', code || 'error');
          await refundIfBilled(store, jobId, code ? String(code) : 'scenario generation failed');
          await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: imageModel }).catch(() => {});
        }
        return { statusCode: 200 };
      }

      const b64 = scenarioResult.data && scenarioResult.data[0] && scenarioResult.data[0].b64_json;
      if (!b64) {
        await fail('No image returned for scenario', 'no_image');
        await refundIfBilled(store, jobId, 'no image returned');
        return { statusCode: 200 };
      }

      await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
      await store.setJSON(jobId + ':status', { state: 'done', model: imageModel, updatedAt: Date.now() });
      try { await store.delete(jobId + ':job'); } catch (e) { /* free payload */ }

      try {
        await logGeneration({
          jobId,
          userId: billing ? billing.userId : null,
          betaKeyUsed: !billing,
          treatmentType: 'scenario',
          angle: f.angle || null,
          isRegen: false,
          model: imageModel,
          imageSize: scenarioParams.size || 'auto',
          imageQuality: scenarioParams.input_fidelity || 'n/a',
          scenarioKey,
          plannerUsed,
          plannerProvider: plannerUsed ? plannerProvider : null,
          rawScenarioMode: f.rawScenarioMode || null,
          openAIUsage: scenarioResult.usage || null,
          creditsCharged: billing ? billing.cost : null,
          referenceMode: null,
          status: 'success',
        });
      } catch (logErr) { console.error('[logGeneration] scenario success log failed:', logErr.message); }

      return { statusCode: 200 };
    }

    // ── Standard / Enhanced generation path (unchanged below) ──
    // v7): the generic tail's "do NOT slim the face or jaw" and "subtly adjusted"
    // were contradicting the chin/jaw content and capping the anchor, which is
    // why oblique chin/jaw came out timid. All other filler areas and hdr keep
    // the generic tail. A/B hook for staging: putting [safety:server] in the
    // note forces the generic tail back on (for Sculptra or chin/jaw) so old and
    // new can be compared on the same patient. The hook is stripped before the
    // prompt is built so it never reaches the model.
    const rawNote = (f.note != null) ? String(f.note) : '';
    const forceServerSafety = /\[safety:server\]/i.test(rawNote);
    const cleanNote = rawNote.replace(/\[safety:(server|none)\]/ig, '').replace(/\s{2,}/g, ' ').trim();

    const product = (f.type === 'biostim')
      ? (['sculptra', 'hdr'].includes(f.product) ? f.product : 'sculptra')
      : null;
    const isSculptra = product === 'sculptra';

    let core;
    if (f.type) {
      core = buildCorePrompt({
        type: f.type, areas: f.areas, goal: f.goal, intensity: f.intensity,
        product: f.product, projection: f.projection, timeline: f.timeline, note: cleanNote,
        isStrongPass:     f.isStrongPass,
        angle:            f.angle,
        sex:              f.sex,
        view:             f.view,
        phenotype:        f.phenotype,
        sculptraPhenotype: f.sculptraPhenotype,
        laserType:        f.laserType,
        toxMode:          f.toxMode,
        patientAge:       f.patientAge ? parseInt(f.patientAge, 10) : null,
      });
    } else {
      core = f.prompt || 'Create a subtle, realistic aesthetic treatment visualization.';
    }

    // Tail selection: Sculptra none, chin/jaw filler its own base, others the
    // generic tail. The [safety:server] hook forces the generic tail back on.
    // M16: HA filler now carries its own complete preservation block (buildFillerPrompt),
    // so filler gets NO tail by default -- same as laser/tox/sculptra. When the
    // MINIMAL_FILLER_OFF kill-switch is set, prompts.js returns the legacy filler
    // assembly which still expects the tail, so we re-append it in that mode only.
    const isChinJaw = usesChinJawSafety(f.type, f.areas);
    const legacyFiller = (process.env.MINIMAL_FILLER_OFF === 'true');
    let tail;
    if (forceServerSafety) tail = SERVER_SAFETY;
    else if (isSculptra) tail = '';
    else if (f.type === 'laser') tail = ''; // laser prompt carries its own complete guardrail
    else if (f.type === 'tox')   tail = ''; // tox prompt carries its own complete guardrail
    else if (f.type === 'filler' && !legacyFiller) tail = ''; // M16: filler prompt is self-contained
    else if (isChinJaw) tail = CHIN_JAW_SAFETY;
    else tail = SERVER_SAFETY;
    const prompt = core + tail;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const buffer = Buffer.from(job.imageB64, 'base64');
    const file   = await OpenAI.toFile(buffer, job.filename || 'image.png', { type: job.mime || 'image/png' });

    // M12: resolve reference image (clinic library > gold refs > null).
    // Fires only for Enhanced Sculptra. Standard always runs single-image.
    // Read billing now so resolveReference can use userId as clinic_id without
    // a second blob fetch in the log block below.
    const billing = await store.get(jobId + ':billing', { type: 'json' }).catch(() => null);
    const { refFile, referenceMode, referenceCaseIds } = await resolveReference(f, billing);

    // When a reference fires, append the identity-lock clause to the prompt.
    // This is the guardrail that prevents the reference patient's identity, age,
    // skin, and ethnicity from bleeding into the output. The clause is built from
    // THIS generation's treatment category, so the model is told to read the
    // right signal out of the reference (volume for a biostimulator, line
    // softening for a neurotoxin, skin quality for an energy treatment).
    const finalPrompt = (refFile && referenceMode)
      ? (prompt + referenceIdentityLock(canonicalTreatment(f)))
      : prompt;

    // M13: both biostim (Sculptra) and HA filler use gpt-image-2 for direct
    // generation. gpt-image-2 rejects input_fidelity -- omit it for that model.
    // BIOSTIM_IMAGE_MODEL controls biostim, FILLER_IMAGE_MODEL controls filler,
    // so either can be reverted to gpt-image-1 without a redeploy.
    if (f.type === 'biostim') {
      modelName = process.env.BIOSTIM_IMAGE_MODEL || 'gpt-image-2';
    } else if (f.type === 'filler') {
      modelName = process.env.FILLER_IMAGE_MODEL || 'gpt-image-2';
    } else if (f.type === 'laser') {
      modelName = process.env.LASER_IMAGE_MODEL || 'gpt-image-2';
    } else if (f.type === 'tox') {
      modelName = process.env.TOX_IMAGE_MODEL || 'gpt-image-2';
    } else {
      modelName = 'gpt-image-1';
    }

    // input_fidelity policy: only gpt-image-1 accepts it.
    //   - All other filler/hdr uses 'high'
    //   - gpt-image-2 (biostim) never receives input_fidelity
    const isChinJawFiller = isChinJaw && f.type === 'filler';
    const isOblique = canonicalAngle(f.angle || f.view) !== 'frontal';
    const editParams = {
      model:              modelName,
      // M13 fix: when a reference image fired, the prompt says "TWO IMAGES" via
      // the identity-lock clause, so the second image must actually be passed.
      image:              (refFile && referenceMode) ? [file, refFile] : file,
      prompt:             finalPrompt,
      size:               'auto',
      output_format:      'jpeg',
      output_compression: 92
    };
    // input_fidelity only applies to gpt-image-1
    if (modelName === 'gpt-image-1') {
      editParams.input_fidelity = (isChinJawFiller && isOblique) ? 'low' : 'high';
    }
    if (job.maskB64) {
      const maskBuf = Buffer.from(job.maskB64, 'base64');
      editParams.mask = await OpenAI.toFile(maskBuf, 'mask.png', { type: job.maskMime || 'image/png' });
    }

    const result = await client.images.edit(editParams);

    const b64 = result.data && result.data[0] && result.data[0].b64_json;
    if (!b64) throw new Error('No image returned by model');

    await store.set(jobId + ':result', 'data:image/jpeg;base64,' + b64);
    // referenceMode is surfaced to the client so a clinic can SEE whether their
    // own case actually grounded this simulation, rather than having to trust
    // that it did. 'clinic_case' means one of their approved, consented cases
    // was used; null means none was, and the result is unreferenced.
    // M13: the canonical treatment vocabulary goes in the status blob, computed
    // here by the SAME functions the reference matcher uses. clinic-simulation-save
    // reads it from here rather than trusting a client-supplied value, so a saved
    // simulation is filed under exactly the treatment key that a photograph of the
    // same treatment is filed under. Two vocabularies would mean a Library that
    // groups the real Sculptra cases in one bucket and the Sculptra simulations in
    // another, and nobody would notice until a clinic asked why.
    const savedTreatment = canonicalTreatment(f);
    await store.setJSON(jobId + ':status', {
      state: 'done',
      model: modelName,
      referenceMode: referenceMode || null,
      referenceCaseIds: referenceCaseIds || [],
      treatment: savedTreatment || null,
      subtype: savedTreatment ? canonicalSubtype(f, savedTreatment) : null,
      angle: canonicalAngle(f.angle || f.view) || null,
      updatedAt: Date.now()
    });
    try { await store.delete(jobId + ':job'); } catch (e) { /* free the large input payload */ }

    // Log cost for this successful generation (non-blocking).
    try {
      await logGeneration({
        jobId,
        userId:         billing ? billing.userId : null,
        betaKeyUsed:    !billing,
        treatmentType:  f.type || null,
        angle:          f.angle || null,
        isRegen:        billing ? (billing.cost === 0) : false,
        model:          modelName,
        imageSize:      editParams.size || 'auto',
        imageQuality:   editParams.input_fidelity || 'high',
        openAIUsage:    result.usage || null,
        creditsCharged: billing ? billing.cost : null,
        referenceMode,  // 'clinic_case' | null
        status:         'success',
      });
    } catch (logErr) { console.error('[logGeneration] success log failed:', logErr.message); }

    return { statusCode: 200 };
  } catch (err) {
    const code = err && (err.code || (err.error && err.error.code));
    const msg  = (err && err.message) || '';
    console.error('background generation failed:', JSON.stringify({ code, msg }));

    // Same moderation classification as the original function. The image-edit
    // endpoint is strict and cannot be turned down; lip edits are a common trigger.
    const blocked = code === 'moderation_blocked' || /safety system|moderation|not allowed/i.test(msg);
    if (blocked) {
      await fail('The AI provider blocked this specific edit under its safety system (the image-edit endpoint is strict and this cannot be turned down). Lip edits are a frequent trigger. Try a different area, or adjust the wording of the custom note.', 'moderation_blocked');
      await refundIfBilled(store, jobId, 'moderation blocked');
      await logGeneration({ jobId, status: 'blocked', failureReason: 'moderation_blocked', model: modelName || 'unknown' }).catch(() => {});
    } else {
      await fail(msg || 'Image generation failed', code || 'error');
      await refundIfBilled(store, jobId, (code ? String(code) : 'generation failed'));
      await logGeneration({ jobId, status: 'failed', failureReason: code || msg || 'unknown', model: modelName || 'unknown' }).catch(() => {});
    }
    return { statusCode: 200 };
  }
};

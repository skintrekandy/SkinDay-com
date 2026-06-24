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
// M12 CLINIC LIBRARY: reference-guided generation.
//   Reference image lookup fires for every biostim (Sculptra) generation.
//   Fallback chain:
//     1. Clinic's own approved reference case matching angle (and phenotype if
//        tagged). Best match = same phenotype first, then match-any.
//     2. Global gold reference (VISUALIZE_GOLD_REF_FRONTAL / _R45 / _L45 env
//        vars), each pointing to a public URL of a clean before/after pair.
//        When a gold ref env var is set, its after-image URL is fetched and
//        passed as image[1] alongside the patient photo (image[0]).
//     3. Single-image text-only (current behavior, unchanged).
//   The reference is passed as the SECOND element of the image array. The model
//   uses it for visual grammar (volume character, lighting, skin character) only;
//   it does NOT copy the reference face, because image[0] is the patient photo
//   and the prompt explicitly locks identity. This is the foundation for Enhanced.
//   referenceMode in the generation log records which branch fired:
//   'clinic_case', 'gold_ref', or null (single-image fallback).
//
// Required env: OPENAI_API_KEY, BETA_ACCESS_PASSWORD
// Optional env for clinic library:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already present for billing)
// Optional env for global gold refs:
//   VISUALIZE_GOLD_REF_FRONTAL  (public URL of after-image)
//   VISUALIZE_GOLD_REF_R45      (public URL of after-image)
//   VISUALIZE_GOLD_REF_L45      (public URL of after-image)
// Required packages: openai, @netlify/blobs   (npm i openai @netlify/blobs)

const OpenAI = require('openai');
const { getStore, connectLambda } = require('@netlify/blobs');
const { buildCorePrompt, CHIN_JAW_SAFETY, usesChinJawSafety, buildScenarioPrompt } = require('./prompts');
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

// M12: injected into the prompt whenever a reference image is passed.
// CRITICAL: gpt-image-1 requires explicit indexing when multiple images are
// provided -- it will ignore image[1] unless the prompt references it directly.
// The identity lock is equally critical: the reference is for treatment pattern
// only, never identity, skin, age, or ethnicity.
const REFERENCE_IDENTITY_LOCK =
  ' TWO IMAGES ARE PROVIDED. Image 1 is the patient to treat. Image 2 is a clinical reference showing a successful Sculptra biostimulator result.' +
  ' Use Image 2 ONLY to understand the visual character of the treatment result: the degree of cheek volume, midface support, lateral lift, and soft-tissue re-inflation.' +
  ' Apply that same degree and character of volume change to Image 1 (the patient).' +
  ' Do NOT copy, borrow, or be influenced by the reference patient\'s identity, face shape, skin tone, ethnicity, age, skin texture, pigmentation, hair, expression, lighting, or any personal feature.' +
  ' The output must show Image 1 (the actual patient) with the Sculptra treatment applied at the visual intensity shown in Image 2.' +
  ' Image 2 is a style and volume guide only -- never an identity donor.';

// M12: look up the best approved clinic reference case for this generation.
// Returns { beforePath, afterPath } or null.
// Match priority: (sex + phenotype) > (sex only) > (phenotype only) > untagged > any.
async function fetchClinicReferenceCase(clinicId, treatmentArea, angle, phenotype, sex) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !clinicId) return null;

  try {
    const qs = new URLSearchParams({
      select:         'id,before_path,after_path,phenotype,sex,sort_order',
      clinic_id:      'eq.' + clinicId,
      treatment_area: 'eq.' + treatmentArea,
      angle:          'eq.' + angle,
      approved:       'eq.true',
      order:          'sort_order.asc,created_at.asc',
      limit:          '10'
    });
    const res = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases?' + qs.toString(), {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!res.ok) {
      console.warn('[M12] clinic case lookup failed: HTTP ' + res.status);
      return null;
    }
    const rows = await res.json();
    if (!rows || !rows.length) return null;

    // Match priority: sex+phenotype > sex-only > phenotype-only > untagged > any.
    const chosen =
      rows.find(r => r.sex === sex && r.phenotype === phenotype)   ||
      rows.find(r => r.sex === sex && !r.phenotype)                ||
      rows.find(r => !r.sex        && r.phenotype === phenotype)   ||
      rows.find(r => !r.sex        && !r.phenotype)                ||
      rows[0];

    console.log('[M12] clinic reference chosen: id=' + chosen.id
      + ' phenotype=' + (chosen.phenotype || 'any')
      + ' sex=' + (chosen.sex || 'any'));
    return { beforePath: chosen.before_path, afterPath: chosen.after_path };
  } catch (e) {
    console.warn('[M12] fetchClinicReferenceCase error:', (e && e.message) || e);
    return null;
  }
}

// M12: generate a signed URL for a Storage object (service role, 300-second TTL).
// The signed URL is fetched at generation time, not stored, so the path is durable
// and the URL is ephemeral. 300 s is more than enough for a single generation.
async function signedStorageUrl(path) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !path) return null;
  try {
    const res = await fetch(
      SUPABASE_URL + '/storage/v1/object/sign/reference-cases/' + encodeURIComponent(path),
      {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 })
      }
    );
    if (!res.ok) { console.warn('[M12] sign URL failed: HTTP ' + res.status); return null; }
    const j = await res.json();
    return (j && j.signedURL) ? (SUPABASE_URL + j.signedURL) : null;
  } catch (e) {
    console.warn('[M12] signedStorageUrl error:', (e && e.message) || e);
    return null;
  }
}

// M12: fetch an image from a URL and return an OpenAI.toFile object.
// Used for both clinic reference cases (signed Storage URLs) and gold ref URLs.
// Returns null on any failure so the caller can fall through to single-image mode.
async function fetchReferenceFile(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) { console.warn('[M12] reference image fetch failed: HTTP ' + res.status + ' ' + url.slice(0, 80)); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct  = res.headers.get('content-type') || 'image/jpeg';
    return await OpenAI.toFile(buf, filename || 'reference.jpg', { type: ct });
  } catch (e) {
    console.warn('[M12] fetchReferenceFile error:', (e && e.message) || e);
    return null;
  }
}

// M12: resolve the reference image file for a generation.
// Returns { refFile, referenceMode } or { refFile: null, referenceMode: null }.
// referenceMode values: 'clinic_case' | 'gold_ref' | null
//
// CRITICAL SCOPE RULE: reference lookup fires ONLY for Enhanced (isStrongPass === 'true')
// Sculptra generations. Standard pass is never reference-guided -- this preserves the
// Standard pass as a known-good, reproducible baseline and ensures the reference
// mechanism is introduced only when its output has been validated.
// Gold refs (env var fallback) are also Enhanced-only for the same reason.
async function resolveReference(f, billing) {
  const isSculptra  = f.type === 'biostim' && (f.product === 'sculptra' || !f.product);
  const isEnhanced  = f.isStrongPass === 'true' || f.isStrongPass === true;
  console.log('[M12] resolveReference: isSculptra=' + isSculptra + ' isEnhanced=' + isEnhanced + ' isStrongPass=' + JSON.stringify(f.isStrongPass));
  if (!isSculptra || !isEnhanced) return { refFile: null, referenceMode: null };

  const angle         = canonicalAngle(f.angle || f.view);
  const phenotype     = f.phenotype || f.sculptraPhenotype || null;
  const sex           = f.sex || null;
  const treatmentArea = 'sculptra'; // Enhanced Sculptra is always sculptra area
  const clinicId      = billing ? billing.userId : null;

  // --- Branch 1: clinic's own library ---
  if (clinicId) {
    const caseRow = await fetchClinicReferenceCase(clinicId, treatmentArea, angle, phenotype, sex);
    if (caseRow) {
      const afterUrl = await signedStorageUrl(caseRow.afterPath);
      if (afterUrl) {
        const refFile = await fetchReferenceFile(afterUrl, 'clinic_ref_after.jpg');
        if (refFile) {
          console.log('[M12] reference mode: clinic_case (angle=' + angle + ')');
          return { refFile, referenceMode: 'clinic_case' };
        }
      }
    }
  }

  // --- Branch 2: global gold refs (Enhanced fallback only) ---
  // Gold refs are useful for testing Enhanced before a clinic has uploaded cases.
  // They are NOT used for Standard -- keeping Standard clean is the standing rule.
  const GOLD_REF_URLS = {
    frontal:       process.env.VISUALIZE_GOLD_REF_FRONTAL || '',
    oblique_right: process.env.VISUALIZE_GOLD_REF_R45     || '',
    oblique_left:  process.env.VISUALIZE_GOLD_REF_L45     || ''
  };
  const goldUrl = GOLD_REF_URLS[angle] || '';
  console.log('[M12] gold ref URL for angle=' + angle + ': ' + (goldUrl ? goldUrl.slice(0, 60) + '...' : 'NOT SET'));
  if (goldUrl) {
    const refFile = await fetchReferenceFile(goldUrl, 'gold_ref.jpg');
    if (refFile) {
      console.log('[M12] reference mode: gold_ref (angle=' + angle + ')');
      return { refFile, referenceMode: 'gold_ref' };
    }
  }

  // --- Branch 3: Enhanced without a reference --- single-image fallback.
  // Still runs Enhanced prompt (ENHANCED_MAGNITUDE) but without a reference image.
  console.log('[M12] reference mode: null (Enhanced single-image fallback)');
  return { refFile: null, referenceMode: null };
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

Return exactly one short patient-specific emphasis sentence for a Sculptra 6-month scenario.
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
  // M12.7: stronger_sculptra planner returns a SHORT patient-specific emphasis line only.
  // The full prompt is SCULPTRA_SCENARIO_BASE (fixed, proven). The planner must NOT
  // rewrite the treatment description -- it overthinks and produces cautious language.
  // The planner output is appended to the base prompt, not used as a replacement.
  stronger_sculptra: `TWO IMAGES PROVIDED AS CONTEXT:
Image 1 = the Visualize baseline (shows a moderate Sculptra biostimulator response already achieved).
Image 2 = the original pre-treatment photo (THIS is the photo the image model will edit).

YOUR JOB: Analyze this patient's face and return ONE SHORT patient-specific emphasis sentence only.
Do NOT write a full image prompt. Do NOT describe the treatment. The base prompt is already fixed.
You are adding one sentence of patient-specific anatomical guidance.

Analyze:
- Where this patient shows the most significant hollowing, descent, or lateral support loss
- What specific zone needs the most emphasis (lateral cheek, preauricular, submalar, temple, prejowl)
- What to avoid for this specific face (e.g. do not add anterior cheek volume if the face is already round centrally)

Return ONLY this format (under 40 words):
"Patient-specific emphasis: [zone/priority for this patient]. Avoid: [specific risk for this patient's anatomy]."

Example: "Patient-specific emphasis: prioritize preauricular and lateral cheek support; submalar hollowing is the dominant concern. Avoid: anterior cheek fill, do not make the face rounder centrally."`,

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
  const fail = async (error, code) => {
    try { await store.setJSON(jobId + ':status', { state: 'error', error, code: code || 'error', updatedAt: Date.now() }); } catch (e) { /* ignore */ }
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

    // M12.2: SCENARIO MODE
    // M12.6 ARCHITECTURE: scenarios generate from the ORIGINAL patient photo,
    // not the Visualize baseline. The planner receives both images as context
    // and writes a case-specific prompt describing the full combined treatment.
    // The image model receives only the original photo as the edit target -- one
    // clean pass, no compositor, no mask, no warp. The raw AI result is displayed
    // directly. If the result drifts, fix the prompt -- not the compositor.
    // (Compositor was removed in M12.7 after it caused artifacts and suppressed
    // aesthetic lift. Do not reintroduce it for scenario generation.)
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

      // M12.6 role mapping (corrected):
      // Frontend sends: image = original photo, originalImage = baseline
      // start-visualization stores: image → job.imageB64, originalImage → job.originalImageB64
      // So: job.imageB64 = original photo (edit target for image model)
      //     job.originalImageB64 = baseline (planner context only)
      // The previous code had this backwards, causing the baseline to be
      // used as the generation source instead of the original photo.
      const sourceImageB64  = job.imageB64;                    // original photo = edit target
      const sourceImageMime = job.mime || 'image/jpeg';
      const baselineRefB64  = job.originalImageB64 || null;    // baseline = planner context only
      const baselineRefMime = job.originalMime || 'image/jpeg';

      const primaryBuffer = Buffer.from(sourceImageB64, 'base64');
      const primaryFile   = await OpenAI.toFile(primaryBuffer, 'original.jpg', { type: sourceImageMime });
      console.log('[M12.6] scenario image target: original photo (' + sourceImageMime + ') | baseline ref: ' + (baselineRefB64 ? 'present' : 'none'));

      // Planner context: baseline = what Sculptra already achieved (reference)
      // Original = the photo the image model will edit
      const baselineB64ForPlanner = baselineRefB64;
      const originalB64ForPlanner = sourceImageB64;
      const origMimeForPlanner    = sourceImageMime;

      // M12.5: SCENARIO PLANNER
      // Before generating the image, run a vision-capable text model to analyze
      // both images and produce a case-specific scenario prompt. This replaces the
      // static template for the specified scenarios and is the key quality improvement
      // over a fixed prompt. Falls back to staticPrompt on any error so generation
      // is never blocked. Provider is controlled by SCENARIO_PLANNER_PROVIDER env var
      // (default 'openai') so it can be swapped to 'anthropic' for A/B testing later.
      // add_lips_filler is intentionally NOT in this list: it uses the static
      // prompt only (the planner tends to over-hedge lip changes into invisibility).
      const PLANNER_SCENARIOS = ['stronger_sculptra', 'combination_plan', 'add_chin_jaw_filler', 'add_temple_support', 'add_tear_trough', 'add_nose_filler'];
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
            baseMime: baselineRefMime,
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

      // M12.8: swappable image model per scenario.
      // gpt-image-1 hits a ceiling on diffuse Sculptra (visible change vs identity is a forced tradeoff).
      // gpt-image-2 has better identity preservation and prompt adherence; the architecture is ready
      // for it. Controlled by env vars so the model can be swapped without a redeploy once access lands:
      //   SCENARIO_SCULPTRA_IMAGE_MODEL -- model for stronger_sculptra (the hard diffuse case)
      //   SCENARIO_IMAGE_MODEL          -- model for all other scenarios
      // IMPORTANT: gpt-image-2 always processes inputs at high fidelity and rejects input_fidelity.
      // So input_fidelity is omitted for any model other than gpt-image-1.
      // M14: cross-type scenario baselines (filler / laser) generate on gpt-image-2,
      // the validated direct-edit model. Sculptra-baseline scenarios keep their
      // existing per-scenario model routing.
      const isCrossTypeScenario = (f.baselineType === 'filler' || f.baselineType === 'laser' || f.baselineType === 'tox');
      const FILLER_SCENARIOS = ['add_lips_filler', 'add_nose_filler'];
      const imageModel = isCrossTypeScenario
        ? (process.env.SCENARIO_FILLER_IMAGE_MODEL || 'gpt-image-2')
        : (scenarioKey === 'stronger_sculptra')
          ? (process.env.SCENARIO_SCULPTRA_IMAGE_MODEL || 'gpt-image-1')
          : FILLER_SCENARIOS.includes(scenarioKey)
            ? (process.env.SCENARIO_FILLER_IMAGE_MODEL || 'gpt-image-2')
            : (process.env.SCENARIO_IMAGE_MODEL || 'gpt-image-1');

      // M12.6: image = original photo only. Single image, one clean pass.
      const scenarioParams = {
        model: imageModel,
        image: primaryFile,
        prompt: scenarioPrompt,
        size: 'auto',
        output_format: 'jpeg',
        output_compression: 85
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
    const isChinJaw = usesChinJawSafety(f.type, f.areas);
    let tail;
    if (forceServerSafety) tail = SERVER_SAFETY;
    else if (isSculptra) tail = '';
    else if (f.type === 'laser') tail = ''; // laser prompt carries its own complete guardrail
    else if (f.type === 'tox')   tail = ''; // tox prompt carries its own complete guardrail
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
    const { refFile, referenceMode } = await resolveReference(f, billing);

    // M12: when a reference fires, append the identity-lock clause to the prompt.
    // This is the guardrail that prevents the reference patient's identity, age,
    // skin, and ethnicity from bleeding into the output.
    const finalPrompt = (refFile && referenceMode) ? (prompt + REFERENCE_IDENTITY_LOCK) : prompt;

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
      // REFERENCE_IDENTITY_LOCK, so the second image must actually be passed.
      image:              (refFile && referenceMode) ? [file, refFile] : file,
      prompt:             finalPrompt,
      size:               'auto',
      output_format:      'jpeg',
      output_compression: 85
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
    await store.setJSON(jobId + ':status', { state: 'done', model: modelName, updatedAt: Date.now() });
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
        referenceMode,  // M12: 'clinic_case' | 'gold_ref' | null
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

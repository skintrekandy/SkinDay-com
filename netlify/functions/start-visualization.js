// Netlify Function (SYNCHRONOUS, fast): /.netlify/functions/start-visualization
// Place in netlify/functions/ alongside prompts.js and the others.
//
// Receives the patient photo + clinician selections, stashes them in Netlify
// Blobs under a jobId, fires the background worker, and returns immediately
// (HTTP 202). The slow gpt-image-1 call runs in generate-visualization-background.js
// where it has a 15-minute budget instead of the 10-26s synchronous limit.
// This is what removes the 504s.
//
// HYBRID MASKING (added): an optional `mask` file (a PNG whose transparent areas
// are the treated region) is stashed alongside the image. The worker passes it
// to images.edit so the model can only change the masked region. Optional and
// backward compatible: no mask posted = today's exact full-image behavior.
//
// M8 (accounts + credits): this function is the single enforcement point for
// metering, because it is the only place generations start. Two access modes:
//   1. Beta key (x-beta-key): the internal, UNMETERED bypass. Unchanged.
//   2. Supabase account (Authorization: Bearer <access token>): METERED.
//      Cost per generation: HA filler 1 credit, Sculptra/biostim 2 credits;
//      a multi-angle case is N separate starts, so per-angle charging is
//      automatic. Credits are RESERVED (debited) here atomically via the
//      visualize_reserve_credits RPC; on insufficient balance the request is
//      refused with HTTP 402 before anything is stashed or spent. A small
//      `<jobId>:billing` blob records { userId, cost } for the background
//      worker, which refunds idempotently on failure or moderation rejection.
//      The billing blob deliberately outlives the job payload (which is
//      deleted on success).
// Free re-generate window: the client may send regenOf=<previous jobId>. If
// that job belongs to the same user, started inside REGEN_WINDOW_MS, and has
// not already granted a free regen, this generation costs 0 and the old
// billing record is marked used. Server-enforced; the client text is cosmetic.
//
// Required env: BETA_ACCESS_PASSWORD
//   plus, for metered accounts: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   VISUALIZE_SIGNUP_GRANT (optional). When the Supabase env vars are absent,
//   account tokens are rejected and only the beta key works (pre-M8 behavior).
// Required packages: busboy, @netlify/blobs   (npm i busboy @netlify/blobs)

const Busboy = require('busboy');
const { Readable } = require('stream');
const { getStore, connectLambda } = require('@netlify/blobs');

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false; // fail closed if not configured
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

/* ---- M8 credit plumbing (shared shape with get-credits.js) ---- */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SIGNUP_GRANT = parseInt(process.env.VISUALIZE_SIGNUP_GRANT || '6', 10) || 0;
const REGEN_WINDOW_MS = 90 * 1000; // server window; the client advertises 60s

// Per-generation costs, env-tunable so pricing changes never need code edits.
// All four action costs are env-driven; defaults preserve the original
// "credit ~= one generation" scale (filler 1, biostim 2, scenario 1, enhanced 1).
// To rescale the credit denomination, multiply every VISUALIZE_COST_* by the
// same factor as the pack sizes in VISUALIZE_PACKS so margin is unchanged.
const COST_FILLER   = parseInt(process.env.VISUALIZE_COST_FILLER   || '1', 10) || 1;
const COST_BIOSTIM  = parseInt(process.env.VISUALIZE_COST_BIOSTIM  || '2', 10) || 2;
const COST_LASER    = parseInt(process.env.VISUALIZE_COST_LASER    || '1', 10) || 1;
const COST_TOX      = parseInt(process.env.VISUALIZE_COST_TOX      || '1', 10) || 1;
const COST_SCENARIO = parseInt(process.env.VISUALIZE_COST_SCENARIO || '1', 10) || 1;
const COST_ENHANCED = parseInt(process.env.VISUALIZE_COST_ENHANCED || '1', 10) || 1;
function creditCost(fields) {
  // M12.2: scenario exploration pass cost (env-driven; default 1).
  // Server verifies baseline ownership below before this price applies.
  if (fields && fields.scenarioMode === 'true') return COST_SCENARIO;
  // Energy-Based Devices (RF/HIFU) are a single Expected pass, priced at 100/angle.
  if (fields && fields.type === 'laser') return COST_LASER;
  // Neurotoxin (lower-face contouring) is also a single pass at 100/angle.
  if (fields && fields.type === 'tox') return COST_TOX;
  return (fields && fields.type === 'biostim') ? COST_BIOSTIM : COST_FILLER;
}

async function verifyUser(event) {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const h = event.headers['authorization'] || event.headers['Authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + m[1] }
    });
    if (!res.ok) return null;
    const u = await res.json();
    return (u && u.id) ? u : null;
  } catch (e) { return null; }
}

async function rpc(name, args) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error('Supabase RPC ' + name + ' failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = {};
    const busboy = Busboy({ headers: event.headers });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', chunk => chunks.push(chunk));
      file.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename || 'image.png',
          mimeType: info.mimeType || 'image/png'
        };
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
    Readable.from(body).pipe(busboy);
  });
}

// M11.1: isStrongPass, angle, sex, view, phenotype, sculptraPhenotype added.
// Previously only isStrongPass was added; angle/sex were missing, causing
// normalizeView() to always default to 'frontal' for oblique generations.
// phenotype/sculptraPhenotype added for future phenotype field routing.
const FIELD_KEYS = [
  'type', 'areas', 'goal', 'intensity', 'product', 'projection',
  'timeline', 'note', 'prompt', 'isStrongPass',
  'angle', 'sex', 'view', 'phenotype', 'sculptraPhenotype', 'patientAge', 'laserType',
  'toxMode',  // was appended by visualize.html but missing from this allowlist,
              // so it never reached the worker. Needed for neurotoxin reference
              // matching, and it was silently absent from the prompt path too.
  'sourceJobId',
  'scenarioMode', 'scenarioKey', 'rawScenarioMode', 'baselineType',  // M12.2 scenario; M14 baselineType
  'clinicId'  // M11: explicit clinic context (clinic route only; consumer omits it)
];

// M11: verify an explicit clinic context.
//
// Clinic grounding is never inferred from who the user is. The clinic portal's
// Visualize sends clinicId; the consumer Visualize on skinday.com does not, and
// therefore gets no clinic's private patient imagery, even when the signed-in
// user happens to own a clinic.
//
// A clinicId in a request is a CLAIM. It is verified here so a bad claim fails
// loudly at the door, rather than silently falling through to a gold reference
// and leaving a clinic user believing their own cases grounded the result. The
// background worker verifies it again independently before touching any case.
async function verifyClinicMembership(userId, clinicId) {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!SUPABASE_URL || !SERVICE_KEY || !userId || !clinicId) return false;
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
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn('[M11] verifyClinicMembership error:', (e && e.message) || e);
    return false;
  }
}

exports.handler = async (event) => {
  connectLambda(event); // wire Blobs context into the classic handler signature
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // M8 dual access: a valid beta key is the unmetered bypass; otherwise a
  // Supabase access token identifies the metered clinic account.
  const isBeta = checkKey(event);
  let user = null;
  if (!isBeta) {
    user = await verifyUser(event);
    if (!user) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Sign in (or a valid beta key) is required.', code: 'UNAUTHENTICATED' }) };
    }
  }

  try {
    const { fields, files } = await parseMultipart(event);
    const imageFile = files.image;
    if (!imageFile) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing image file' }) };
    }

    // Use the client-supplied jobId when it looks sane, else mint one.
    const jobId = (fields.jobId && /^[A-Za-z0-9._-]{8,128}$/.test(fields.jobId))
      ? fields.jobId
      : (Date.now() + '-' + Math.random().toString(36).slice(2));

    const params = {};
    FIELD_KEYS.forEach(k => { if (fields[k] != null) params[k] = fields[k]; });

    // M11: if this request claims a clinic context, prove it before proceeding.
    // A beta-key session has no Supabase user, so it cannot claim a clinic.
    if (params.clinicId) {
      const ok = user ? await verifyClinicMembership(user.id, String(params.clinicId)) : false;
      if (!ok) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'You are not an active member of that clinic.',
            code: 'CLINIC_FORBIDDEN'
          })
        };
      }
      console.log('[M11] clinic context accepted: clinic ' + params.clinicId);
    }

    const store = getStore('visualize-jobs');

    // M12.2: Scenario mode server-side verification.
    // Scenarios are priced at 1 credit only when they build on a verified,
    // completed Sculptra baseline that belongs to the same user. Without this
    // gate, any user could call scenarioMode=true with any image and pay 1
    // credit instead of the 2-credit biostim baseline.
    // Beta-key users are exempt from ownership verification (internal use).
    if (fields.scenarioMode === 'true') {
      // M14: each scenario key declares which baseline treatment types it may
      // build on. Filler-area add-ons work on any baseline; stronger_sculptra and
      // combination_plan are Sculptra-only.
      // M17: widened for combination-plan mode, which stacks validated add-ons on
      // any primary (biostim/filler/laser/tox). Each list below is the UNION of
      // what the single-treatment scenario panel and the combination builder can
      // legitimately send for that key, so widening never regresses the panel and
      // only ever makes the gate more permissive:
      //   - cheek/nasolabial/tear-trough/temple/nose/lips + chin/jaw filler stack
      //     on any primary.
      //   - RF/HIFU and masseter/Nefertiti neurotoxin now stack on a biostim
      //     primary (Sculptra + lower-face tox/energy is a standard plan), and on
      //     each other's non-repeating primaries.
      //   - add_biostim_lift still excluded from a biostim primary (biostim on
      //     biostim is the same modality, not a distinct add-on).
      // Also fixes a pre-existing omission: add_nasolabial_filler was absent from
      // this map, so the scenario panel's "Add nasolabial fold support" button
      // (offered on biostim/filler/laser) returned 400 BAD_SCENARIO_KEY on click.
      const SCENARIO_SOURCE_TYPES = {
        stronger_sculptra:     ['biostim'],
        combination_plan:      ['biostim'],
        add_chin_jaw_filler:   ['biostim', 'filler', 'laser', 'tox'],
        add_chin_filler:       ['biostim', 'filler', 'laser', 'tox'],
        add_jawline_filler:    ['biostim', 'filler', 'laser', 'tox'],
        add_cheek_filler:      ['biostim', 'filler', 'laser', 'tox'],
        add_temple_support:    ['biostim', 'filler', 'laser', 'tox'],
        add_tear_trough:       ['biostim', 'filler', 'laser', 'tox'],
        add_nasolabial_filler: ['biostim', 'filler', 'laser', 'tox'],
        add_nose_filler:       ['biostim', 'filler', 'laser', 'tox'],
        add_lips_filler:       ['biostim', 'filler', 'laser', 'tox'],
        add_biostim_lift:      ['filler', 'laser', 'tox'],
        add_rf:                ['biostim', 'filler', 'tox'],
        add_hifu:              ['biostim', 'filler', 'tox'],
        add_masseter:          ['biostim', 'filler', 'laser'],
        add_nefertiti:         ['biostim', 'filler', 'laser'],
        stronger_laser:        ['laser']
      };
      if (!SCENARIO_SOURCE_TYPES[fields.scenarioKey]) {
        return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid scenario key.', code: 'BAD_SCENARIO_KEY' }) };
      }
      if (user) {
        // Require sourceJobId for metered accounts.
        const srcId = fields.sourceJobId;
        if (!srcId || !/^[A-Za-z0-9._-]{8,128}$/.test(srcId)) {
          return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Scenario requires a valid source job.', code: 'MISSING_SOURCE_JOB' }) };
        }
        // Verify source job: must belong to this user, be done, be a real baseline
        // (not itself a scenario), and be a treatment type this scenario can build on.
        try {
          const srcBilling = await store.get(srcId + ':billing', { type: 'json' });
          const srcStatus  = await store.get(srcId + ':status',  { type: 'json' });
          if (!srcBilling || srcBilling.userId !== user.id) {
            return { statusCode: 403, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'Source job not found or belongs to a different account.', code: 'SOURCE_JOB_MISMATCH' }) };
          }
          if (!srcStatus || srcStatus.state !== 'done') {
            return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'Source job has not completed successfully.', code: 'SOURCE_JOB_NOT_DONE' }) };
          }
          if (srcBilling.scenarioMode === true) {
            return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'Cannot build a scenario on top of another scenario.', code: 'SOURCE_JOB_IS_SCENARIO' }) };
          }
          // M15.2: stronger_sculptra and combination_plan require a biostimulator
          // baseline: Sculptra (PLLA) or Hyperdilute Radiesse (CaHA/hdr). Both
          // products share the same intensify mechanism (lateral scaffold).
          if (fields.scenarioKey === 'stronger_sculptra' || fields.scenarioKey === 'combination_plan') {
            if (srcBilling.type !== 'biostim' || (srcBilling.product !== 'sculptra' && srcBilling.product !== 'hdr')) {
              return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'This scenario requires a completed biostimulator baseline.', code: 'SOURCE_JOB_NOT_BIOSTIM' }) };
            }
          }
          const allowed = SCENARIO_SOURCE_TYPES[fields.scenarioKey];
          if (!allowed.includes(srcBilling.type)) {
            return { statusCode: 400, headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ error: 'This scenario cannot be applied to that baseline treatment type.', code: 'SOURCE_JOB_TYPE_MISMATCH' }) };
          }
        } catch (e) {
          console.error('[M14] scenario source job lookup failed:', (e && e.message) || e);
          return { statusCode: 500, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Could not verify source job. Please try again.', code: 'SOURCE_JOB_LOOKUP_ERROR' }) };
        }
      }
    }

    // M8 metering: reserve credits before any work, atomically and balance-
    // checked server-side. Beta key: cost 0, no account touched.
    let billing = null;
    if (user) {
      let cost = creditCost(fields);

      // Free re-generate window, enforced by job lineage.
      // M12.2: regenOf is explicitly disabled for scenario mode -- scenarios
      // must always cost 1 credit and cannot inherit a free-regen from a baseline job.
      const regenOf = fields.scenarioMode === 'true' ? null : fields.regenOf;
      if (cost > 0 && regenOf && /^[A-Za-z0-9._-]{8,128}$/.test(regenOf)) {
        try {
          const prev = await store.get(regenOf + ':billing', { type: 'json' });
          if (prev && prev.userId === user.id && !prev.regenUsed &&
              (Date.now() - (prev.createdAt || 0)) < REGEN_WINDOW_MS) {
            cost = 0;
            await store.setJSON(regenOf + ':billing', { ...prev, regenUsed: true });
          }
        } catch (e) { /* lineage lookup is best-effort; full price applies */ }
      }

      // Enhanced course second pass: charged at 1 credit per angle (half the
      // standard biostim cost). Verified server-side: source job must belong to
      // the same user and have completed successfully. Full price applies if
      // the lookup fails (best-effort; never silently free).
      const sourceJobId = fields.sourceJobId;
      if (fields.isStrongPass === 'true' && sourceJobId && /^[A-Za-z0-9._-]{8,128}$/.test(sourceJobId)) {
        try {
          const sourceBilling = await store.get(sourceJobId + ':billing', { type: 'json' });
          const sourceStatus  = await store.get(sourceJobId + ':status',  { type: 'json' });
          // M13: discount applies if the source biostim job belongs to this user.
          // The source need NOT be 'done' -- in parallel "Both" mode the Optimistic
          // pass is fired at the same time as Expected, so Expected is still pending.
          // Requiring 'done' here would overcharge parallel Both. Ownership + a
          // valid pending/done biostim source job is sufficient proof of payment intent.
          const validSource = sourceBilling && sourceBilling.userId === user.id &&
            (sourceBilling.type === 'biostim' || sourceBilling.type === 'laser') &&
            sourceStatus && (sourceStatus.state === 'done' || sourceStatus.state === 'pending');
          if (validSource) {
            cost = COST_ENHANCED; // Enhanced pass cost per angle (env-driven; default 1)
          }
        } catch (e) { /* source lookup best-effort; full price applies if lookup fails */ }
      }

      if (cost > 0) {
        await rpc('visualize_ensure_account', { p_user: user.id, p_email: user.email || null, p_grant: SIGNUP_GRANT });
        const balance = await rpc('visualize_reserve_credits', { p_user: user.id, p_cost: cost, p_job: jobId });
        if (balance === -1) {
          return { statusCode: 402, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not enough credits for this generation.', code: 'INSUFFICIENT_CREDITS', cost }) };
        }
      }
      billing = { userId: user.id, cost, createdAt: Date.now(), regenUsed: false,
        type: fields.type || null,
        product: fields.product || null,
        scenarioMode: fields.scenarioMode === 'true'
      };
    }

    // Full payload for the worker (image as base64). Kept separate from the
    // small status object so the poller never has to download the image.
    // The optional mask rides along in the same payload.
    // M12.2: scenario mode sends an originalImage field alongside the baseline
    // image so the background worker can pass both to gpt-image-1 as a two-
    // image input: image[0] = baseline (treatment anchor), image[1] = original
    // patient photo (identity + skin-texture reference).
    const maskFile = files.mask;
    const originalImageFile = files.originalImage; // M12.2: scenario only
    await store.setJSON(jobId + ':job', {
      params,
      imageB64: imageFile.buffer.toString('base64'),
      mime: imageFile.mimeType,
      filename: imageFile.filename,
      maskB64: maskFile ? maskFile.buffer.toString('base64') : null,
      maskMime: maskFile ? maskFile.mimeType : null,
      originalImageB64: originalImageFile ? originalImageFile.buffer.toString('base64') : null,
      originalMime:     originalImageFile ? originalImageFile.mimeType : null
    });
    await store.setJSON(jobId + ':status', { state: 'pending', createdAt: Date.now() });
    if (billing) await store.setJSON(jobId + ':billing', billing);

    // Fire the background worker. It re-reads the job from Blobs, so we send
    // only the id (background-function request bodies are capped at 256KB,
    // which the photo would exceed).
    // Host header first: Netlify's URL env var is ALWAYS the production URL,
    // even on branch deploys, which made staging trigger PRODUCTION's worker
    // (whose context lacks the Supabase vars, silently disabling refunds).
    const base = 'https://' + (event.headers.host || event.headers.Host ||
                 (process.env.DEPLOY_PRIME_URL || process.env.URL || '').replace(/^https?:\/\//, ''));
    // M8: the internal trigger authenticates with the server's own beta key
    // (account users have no key to forward; the server trusts itself).
    const trigger = await fetch(base + '/.netlify/functions/generate-visualization-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-beta-key': process.env.BETA_ACCESS_PASSWORD || '' },
      body: JSON.stringify({ jobId })
    });
    if (!(trigger.status === 202 || trigger.ok)) {
      await store.setJSON(jobId + ':status', { state: 'error', error: 'Could not enqueue the background job (HTTP ' + trigger.status + ').', updatedAt: Date.now() });
      if (billing && billing.cost > 0) {
        try { await rpc('visualize_refund_credits', { p_user: billing.userId, p_cost: billing.cost, p_job: jobId, p_note: 'enqueue failed' }); }
        catch (e) { console.error('refund after enqueue failure also failed:', (e && e.message) || e); }
      }
      return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not start the background job. Please try again.' }) };
    }

    return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) };
  } catch (err) {
    console.error('start-visualization failed:', (err && err.message) || err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: (err && err.message) || 'Failed to start generation' }) };
  }
};

// Netlify Function: /.netlify/functions/get-visualization
// Poll endpoint for async generations. Reads the small status blob (and, when
// done, the result data URL) from Netlify Blobs by jobId.
//
// M8 REWRITE of the M5-era poller to the same client contract, plus dual auth:
//   GET ?jobId=...   with x-beta-key OR Authorization: Bearer <supabase token>
//   -> { state: 'pending' }
//   -> { state: 'done', image: 'data:image/jpeg;base64,...' }
//   -> { state: 'error', error, code }
// Ownership: when a `<jobId>:billing` blob exists (metered jobs), only that
// account may poll the job; beta-key callers may poll anything (internal use).
//
// Env: BETA_ACCESS_PASSWORD, and for accounts SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY. Packages: @netlify/blobs.

const { getStore, connectLambda } = require('@netlify/blobs');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false;
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
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

exports.handler = async (event) => {
  connectLambda(event);
  const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

  const isBeta = checkKey(event);
  let user = null;
  if (!isBeta) {
    user = await verifyUser(event);
    if (!user) return json(401, { error: 'Sign in (or a valid beta key) is required.', code: 'UNAUTHENTICATED' });
  }

  const jobId = (event.queryStringParameters && event.queryStringParameters.jobId) || '';
  if (!jobId || !/^[A-Za-z0-9._-]{8,128}$/.test(jobId)) {
    return json(400, { error: 'Missing or invalid jobId' });
  }

  try {
    const store = getStore('visualize-jobs');

    // Ownership check for metered jobs.
    if (!isBeta) {
      try {
        const billing = await store.get(jobId + ':billing', { type: 'json' });
        if (billing && billing.userId && billing.userId !== user.id) {
          return json(404, { state: 'error', error: 'Job not found.', code: 'not_found' });
        }
      } catch (e) { /* no billing blob: legacy or beta job; allow */ }
    }

    const status = await store.get(jobId + ':status', { type: 'json' });
    if (!status) return json(200, { state: 'pending' });

    if (status.state === 'done') {
      const image = await store.get(jobId + ':result');
      // referenceMode tells a clinic whether one of their own approved, consented
      // cases actually grounded this simulation ('clinic_case') or not (null).
      // A clinic paying for a personalized Visualize should not have to guess.
      if (image) return json(200, { state: 'done', image, model: status.model || null, referenceMode: status.referenceMode || null });
      return json(200, { state: 'error', error: 'The result has expired. Please generate again.', code: 'expired' });
    }
    if (status.state === 'error') {
      return json(200, { state: 'error', error: status.error || 'Generation failed.', code: status.code || 'error' });
    }
    return json(200, { state: 'pending' });
  } catch (err) {
    console.error('get-visualization failed:', (err && err.message) || err);
    return json(500, { error: 'Could not read the job status.' });
  }
};

// netlify/functions/crawl-queue-admin.js
//
// Queue housekeeping for the Websites panel: seed, requeue, reset stuck, count.
//
// ⭐ WHY THIS EXISTS AS A FUNCTION RATHER THAN CLIENT CODE. Seeding a state is
// an insert-from-select over ~8,000 clinics producing ~3,500 queue rows. A
// browser cannot do that: it has no service key, and PostgREST caps a read at
// 1,000 rows, so the client would have to page through clinics and chunk the
// inserts — thousands of lines of round-trips to replace one SQL statement.
// The work lives in two Postgres functions (queue_seed, queue_requeue) and this
// endpoint just calls them, so the button is a button.
//
// ⛔ IT ALSO EXISTS SO THIS STOPS BEING A SQL PASTE. Seeding is routine — every
// new state needs it — and handing over a 30-line block each time is how a
// destructive statement eventually gets pasted next to an audit query.

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function counts(country, state) {
  let q = `crawl_queue?select=status,social_status&country=eq.${encodeURIComponent(country)}&limit=20000`;
  if (state) q += `&state=eq.${encodeURIComponent(state)}`;
  const rows = (await sb(q)) || [];
  const by = { total: rows.length, doctors: {}, socials: {} };
  for (const r of rows) {
    const d = r.status || '(null)';
    const s = r.social_status || '(null)';
    by.doctors[d] = (by.doctors[d] || 0) + 1;
    by.socials[s] = (by.socials[s] || 0) + 1;
  }
  return by;
}

exports.handler = async (event) => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const given = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!ADMIN_SECRET || given !== ADMIN_SECRET) return json(401, { error: 'unauthorised' });
  if (!SB || !SB_KEY) return json(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  const action  = String(body.action || 'count').toLowerCase();
  const country = String(body.country || '').trim().toLowerCase();
  const state   = String(body.state || '').trim().toLowerCase() || null;

  if (!country) return json(400, { error: 'country is required' });

  try {
    if (action === 'count') {
      return json(200, { action, country, state, counts: await counts(country, state) });
    }

    if (action === 'seed') {
      const out = await sb('rpc/queue_seed', {
        method: 'POST',
        body: JSON.stringify({ p_country: country, p_state: state })
      });
      const inserted = typeof out === 'number' ? out : (out && out[0]) || 0;
      return json(200, { action, country, state, inserted, counts: await counts(country, state) });
    }

    if (action === 'requeue') {
      // 'doctors' | 'socials' | 'both'
      const what = ['doctors', 'socials', 'both'].includes(String(body.what))
        ? String(body.what) : 'both';
      const out = await sb('rpc/queue_requeue', {
        method: 'POST',
        body: JSON.stringify({ p_country: country, p_state: state, p_what: what })
      });
      const touched = typeof out === 'number' ? out : (out && out[0]) || 0;
      return json(200, { action, country, state, what, touched, counts: await counts(country, state) });
    }

    if (action === 'unstick') {
      // ⭐ A function killed mid-batch leaves rows marked 'running' and nothing
      // will ever claim them again. This is the only way back without SQL.
      let q = `crawl_queue?status=eq.running&country=eq.${encodeURIComponent(country)}`;
      if (state) q += `&state=eq.${encodeURIComponent(state)}`;
      const rows = await sb(q, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'pending' })
      });
      return json(200, {
        action, country, state,
        reset: (rows || []).length,
        counts: await counts(country, state)
      });
    }

    return json(400, { error: `unknown action "${action}"` });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 500) });
  }
};

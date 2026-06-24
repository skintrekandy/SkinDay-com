// Netlify Function: /.netlify/functions/get-credits
// Authenticated balance + recent ledger for the signed-in clinic account.
// Also performs lazy account creation with the one-time signup grant, so the
// first balance fetch after signup is what mints the account row.
//
// Auth: Authorization: Bearer <supabase access token>
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VISUALIZE_SIGNUP_GRANT

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SIGNUP_GRANT = parseInt(process.env.VISUALIZE_SIGNUP_GRANT || '6', 10) || 0;

// (Shared by the credit-aware functions; duplicated per file on purpose so each
// Netlify function stays a single self-contained deployable.)
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

exports.handler = async (event) => {
  const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
  const user = await verifyUser(event);
  if (!user) return json(401, { error: 'Sign in required', code: 'UNAUTHENTICATED' });

  try {
    const balance = await rpc('visualize_ensure_account', { p_user: user.id, p_email: user.email || null, p_grant: SIGNUP_GRANT });

    let recent = [];
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/visualize_ledger'
        + '?user_id=eq.' + encodeURIComponent(user.id)
        + '&select=delta,kind,note,created_at&order=created_at.desc&limit=10', {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
      });
      if (res.ok) recent = await res.json();
    } catch (e) { /* recent activity is decorative; balance is the contract */ }

    return json(200, { balance, email: user.email || null, recent });
  } catch (err) {
    console.error('get-credits failed:', (err && err.message) || err);
    return json(500, { error: 'Could not load the credit balance.' });
  }
};

// Netlify Function: /.netlify/functions/stripe-webhook
// Lands purchased credits when Stripe confirms payment. Idempotent: the
// ledger's unique stripe_session_id makes duplicate deliveries a no-op, so
// Stripe's retries are always safe.
//
// Zero npm dependencies: webhook signatures are verified manually per Stripe's
// documented scheme (HMAC-SHA256 of "<timestamp>.<raw body>" with the signing
// secret, compared timing-safe against every v1 candidate in the header).
//
// Stripe dashboard setup: add an endpoint for
//   https://<site>/.netlify/functions/stripe-webhook
// listening to checkout.session.completed (and optionally
// checkout.session.async_payment_succeeded), then put its signing secret in
// STRIPE_WEBHOOK_SECRET.
//
// Env: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const TOLERANCE_S = 300;

function verifySignature(rawBuf, sigHeader) {
  if (!WEBHOOK_SECRET || !sigHeader) return false;
  const parts = {};
  for (const kv of sigHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 't') parts.t = v;
    else if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
  }
  if (!parts.t || !parts.v1 || !parts.v1.length) return false;
  const age = Math.abs(Date.now() / 1000 - parseInt(parts.t, 10));
  if (!isFinite(age) || age > TOLERANCE_S) return false;

  const signed = Buffer.concat([Buffer.from(parts.t + '.', 'utf8'), rawBuf]);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signed).digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  return parts.v1.some(v => {
    const vb = Buffer.from(v, 'utf8');
    return vb.length === expBuf.length && crypto.timingSafeEqual(vb, expBuf);
  });
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
  const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const rawBuf = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';
  if (!verifySignature(rawBuf, sig)) {
    console.error('stripe-webhook: signature verification failed');
    return json(400, { error: 'Invalid signature' });
  }

  let evt;
  try { evt = JSON.parse(rawBuf.toString('utf8')); } catch (e) { return json(400, { error: 'Invalid payload' }); }

  const relevant = evt.type === 'checkout.session.completed' ||
                   evt.type === 'checkout.session.async_payment_succeeded';
  if (!relevant) return json(200, { received: true });

  const session = evt.data && evt.data.object;
  if (!session || session.payment_status !== 'paid') return json(200, { received: true });

  const userId = session.metadata && session.metadata.user_id;
  const credits = parseInt(session.metadata && session.metadata.credits, 10);
  if (!userId || !credits || credits <= 0) {
    console.error('stripe-webhook: session missing credit metadata', session.id);
    return json(200, { received: true }); // not ours to retry
  }

  try {
    const balance = await rpc('visualize_add_credits', {
      p_user: userId,
      p_amount: credits,
      p_session: session.id,
      p_note: (session.metadata.pack || 'credit pack') + ' purchase'
    });
    console.log('stripe-webhook: +' + credits + ' credits for ' + userId + ' (balance ' + balance + ', session ' + session.id + ')');
    return json(200, { received: true });
  } catch (err) {
    console.error('stripe-webhook: credit landing failed (Stripe will retry):', (err && err.message) || err);
    return json(500, { error: 'Credit landing failed; retry.' });
  }
};

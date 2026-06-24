// Netlify Function: /.netlify/functions/create-checkout-session
// Creates a Stripe Checkout session for a credit pack and returns its URL.
// Zero npm dependencies: the Stripe REST API over fetch with form encoding.
//
// Auth: Authorization: Bearer <supabase access token>
// Body: { "packId": "starter" | "clinic" | "studio" | <env-defined id> }
// Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY,
//       VISUALIZE_PACKS (optional override; see visualize-config.js), URL

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';

// Must mirror visualize-config.js. `cad` is the charged (launch) price;
// `regularCad` is display-only and never charged.
const DEFAULT_PACKS = [
  { id: 'starter', label: 'Starter', credits: 20,  cad: 2900,  regularCad: 5900  },
  { id: 'clinic',  label: 'Clinic',  credits: 60,  cad: 6900,  regularCad: 14900 },
  { id: 'studio',  label: 'Studio',  credits: 150, cad: 13900, regularCad: 32900 }
];

function packs() {
  try {
    const env = process.env.VISUALIZE_PACKS;
    if (!env) return DEFAULT_PACKS;
    const parsed = JSON.parse(env);
    if (Array.isArray(parsed) && parsed.length &&
        parsed.every(p => p.id && p.label && p.credits > 0 && p.cad > 0)) {
      return parsed;
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_PACKS;
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
  const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!STRIPE_KEY) return json(503, { error: 'Payments are not configured yet.' });

  const user = await verifyUser(event);
  if (!user) return json(401, { error: 'Sign in required', code: 'UNAUTHENTICATED' });

  let packId = null;
  try { packId = JSON.parse(event.body || '{}').packId; } catch (e) { /* ignore */ }
  const pack = packs().find(p => p.id === packId);
  if (!pack) return json(400, { error: 'Unknown credit pack.' });

  // The request's own host is the only context-correct base: Netlify's URL
  // env var is ALWAYS the production URL, even on branch deploys, which sent
  // checkout returns from staging back to skinday.ca. Host header first.
  const base = 'https://' + (event.headers.host || event.headers.Host ||
               (process.env.DEPLOY_PRIME_URL || process.env.URL || '').replace(/^https?:\/\//, ''));

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', base + '/visualize.html?purchase=success&session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url', base + '/visualize.html?purchase=cancelled');
  params.append('client_reference_id', user.id);
  params.append('metadata[user_id]', user.id);
  params.append('metadata[credits]', String(pack.credits));
  params.append('metadata[pack]', pack.label);
  if (user.email) params.append('customer_email', user.email);
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', (process.env.VISUALIZE_CURRENCY || 'cad').toLowerCase());
  params.append('line_items[0][price_data][unit_amount]', String(pack.cad));
  params.append('line_items[0][price_data][product_data][name]',
    'SkinDay Visualize credits: ' + pack.label + ' (' + pack.credits + ' credits)');

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const session = await res.json();
    if (!res.ok || !session.url) {
      console.error('Stripe checkout creation failed:', JSON.stringify(session && session.error));
      return json(502, { error: 'Could not start the checkout. Please try again.' });
    }
    return json(200, { url: session.url });
  } catch (err) {
    console.error('create-checkout-session failed:', (err && err.message) || err);
    return json(500, { error: 'Could not start the checkout. Please try again.' });
  }
};

// netlify/functions/clinic-subscribe.js
//
// Starts a Stripe Checkout session in subscription mode, and returns the URL.
//
// The clinic id goes in client_reference_id and in the subscription metadata, so
// the webhook can tell which clinic paid without trusting anything the browser
// sends back.
//
// Env
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_VISUALIZE_PRO   the price_... id
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const PRICE_ID = process.env.STRIPE_PRICE_VISUALIZE_PRO;
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  if (!STRIPE_KEY || !PRICE_ID) {
    return json(500, { error: 'missing env: STRIPE_SECRET_KEY, STRIPE_PRICE_VISUALIZE_PRO' });
  }

  const headers = event.headers || {};
  const jwt = (headers.authorization || headers.Authorization || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'missing bearer token' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'invalid json body' }); }

  const clinicId = body.clinicId ? String(body.clinicId) : '';
  if (!clinicId) return json(400, { error: 'clinicId is required' });

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Only an owner can put a card on a clinic. Proved against the database, not
  // against what the browser claims.
  const { data: mem } = await asUser
    .from('clinic_memberships')
    .select('role')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .is('revoked_at', null)
    .maybeSingle();

  if (!mem) return json(403, { error: 'not a member of this clinic' });
  if (mem.role !== 'owner') {
    return json(403, { error: 'only an owner can subscribe this clinic' });
  }

  const { data: userData } = await asUser.auth.getUser();
  const email = (userData && userData.user && userData.user.email) || undefined;

  const stripe = Stripe(STRIPE_KEY);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Reuse the Stripe customer if this clinic already has one, so a clinic that
  // cancels and comes back keeps one billing history rather than two.
  const { data: sub } = await admin
    .from('clinic_subscriptions')
    .select('stripe_customer_id')
    .eq('clinic_id', clinicId)
    .maybeSingle();

  const customerId = (sub && sub.stripe_customer_id) || undefined;

  const origin =
    headers.origin || headers.Origin ||
    ('https://' + (headers.host || 'skinday.com'));

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      client_reference_id: clinicId,
      customer: customerId,
      customer_email: customerId ? undefined : email,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { clinic_id: clinicId }
      },
      metadata: { clinic_id: clinicId },
      success_url: origin + '/clinic-portal.html?billing=ok',
      cancel_url: origin + '/clinic-portal.html?billing=cancelled'
    });

    return json(200, { ok: true, url: session.url });
  } catch (err) {
    console.error('[clinic-subscribe]', err.message);
    return json(500, { error: err.message });
  }
};

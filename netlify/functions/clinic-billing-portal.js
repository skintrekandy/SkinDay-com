// netlify/functions/clinic-billing-portal.js
//
// Opens the Stripe Billing Portal, where a clinic changes its card, sees its
// invoices, and cancels. All of that is Stripe's job and Stripe does it better
// than we would.
//
// Env
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
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
  if (!STRIPE_KEY) return json(500, { error: 'missing env: STRIPE_SECRET_KEY' });

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

  const { data: mem } = await asUser
    .from('clinic_memberships')
    .select('role')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .is('revoked_at', null)
    .maybeSingle();

  if (!mem) return json(403, { error: 'not a member of this clinic' });
  if (mem.role !== 'owner') {
    return json(403, { error: 'only an owner can manage billing' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: sub } = await admin
    .from('clinic_subscriptions')
    .select('stripe_customer_id')
    .eq('clinic_id', clinicId)
    .maybeSingle();

  if (!sub || !sub.stripe_customer_id) {
    return json(400, { error: 'this clinic has no billing account yet' });
  }

  const origin =
    headers.origin || headers.Origin ||
    ('https://' + (headers.host || 'skinday.com'));

  try {
    const stripe = Stripe(STRIPE_KEY);
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: origin + '/clinic-portal.html'
    });
    return json(200, { ok: true, url: portal.url });
  } catch (err) {
    console.error('[clinic-billing-portal]', err.message);
    return json(500, { error: err.message });
  }
};

// netlify/functions/mi-checkout.js
//
// Starts a Stripe Checkout Session for Market Intelligence.
//
// ⭐ THE TENANT IS NOT CREATED HERE. Everything the buyer chose rides along as
// Stripe metadata and the tenant is created by the WEBHOOK once payment
// actually succeeds. Creating it here would leave a tenant behind every time
// someone opened checkout and changed their mind.
//
// Env required on the .com site:
//   STRIPE_SECRET_KEY
//   MI_PRICE_SOLO_MONTH / MI_PRICE_SOLO_YEAR
//   MI_PRICE_TEAM_MONTH / MI_PRICE_TEAM_YEAR
//   SITE_URL (e.g. https://skinday.com)
//
// ⚠️ Price ids are ENV, not constants. Sandbox and live have different ids, so
// hardcoding them means going live is a code change instead of a config change.

const Stripe = require('stripe');

const TRIAL_DAYS = 14;

// Seats per plan. The webhook reads this from metadata rather than inferring it
// from the price, so changing a plan's seat count never needs a webhook edit.
const PLANS = {
  solo: { seats: 1, month: 'MI_PRICE_SOLO_MONTH', year: 'MI_PRICE_SOLO_YEAR' },
  team: { seats: 5, month: 'MI_PRICE_TEAM_MONTH', year: 'MI_PRICE_TEAM_YEAR' }
};

const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
});
const json = (code, obj) => ({
  statusCode: code,
  headers: Object.assign({ 'Content-Type': 'application/json' }, cors()),
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) return json(500, { error: 'stripe is not configured' });
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad json' }); }

  const plan    = String(body.plan || '').toLowerCase();
  const period  = String(body.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const email   = String(body.email || '').trim().toLowerCase();
  const company = String(body.company || '').trim();
  const kind    = String(body.company_type || 'manufacturer').toLowerCase();
  const country = String(body.country || '').trim().toLowerCase();
  const person  = String(body.name || '').trim();

  if (!PLANS[plan])                          return json(400, { error: 'choose a plan' });
  if (!email || email.indexOf('@') === -1)    return json(400, { error: 'a valid email is required' });
  if (!company)                               return json(400, { error: 'choose your company' });
  if (['canada', 'usa'].indexOf(country) === -1) return json(400, { error: 'choose a country' });
  if (['manufacturer', 'distributor'].indexOf(kind) === -1) return json(400, { error: 'bad company type' });

  const priceId = process.env[PLANS[plan][period]];
  if (!priceId) return json(500, { error: 'that plan is not available yet' });

  const site = (process.env.SITE_URL || 'https://skinday.com').replace(/\/+$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      // Stripe Tax needs an address to work out GST/HST or US state tax.
      billing_address_collection: 'required',
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
      subscription_data: {
        // The trial lives HERE rather than on the price. Stripe moved it, and
        // keeping it in one place means the length is a single line to change.
        trial_period_days: TRIAL_DAYS,
        metadata: {
          mi_company: company, mi_company_type: kind, mi_country: country,
          mi_plan: plan, mi_seats: String(PLANS[plan].seats),
          mi_email: email, mi_name: person
        }
      },
      // Duplicated onto the session because the two objects arrive in different
      // webhook events and either one may be the first to land.
      metadata: {
        mi_company: company, mi_company_type: kind, mi_country: country,
        mi_plan: plan, mi_seats: String(PLANS[plan].seats),
        mi_email: email, mi_name: person
      },
      success_url: site + '/mi-welcome?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: site + '/mi-signup'
    });
    return json(200, { url: session.url });
  } catch (e) {
    return json(500, { error: 'could not start checkout', detail: e.message });
  }
};

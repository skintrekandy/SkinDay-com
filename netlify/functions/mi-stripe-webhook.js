// netlify/functions/mi-stripe-webhook.js
//
// Turns a successful Stripe payment into a working tenant, then emails the
// buyer an invite link so they can set a password and sign in.
//
// ⛔ SIGNATURE VERIFICATION IS NOT OPTIONAL. This endpoint creates accounts, so
// without it anyone who finds the URL can POST a fake payment and mint a free
// tenant. It needs the RAW body, which is why the handler never JSON.parses
// before verifying.
//
// Env required on the .com site:
//   MI_STRIPE_SECRET_KEY (optional, sandbox) or STRIPE_SECRET_KEY
//   MI_STRIPE_WEBHOOK_SECRET (NEW, and it must NOT reuse STRIPE_WEBHOOK_SECRET:
//     that one belongs to the Visualize Pro endpoint, and every Stripe endpoint
//     has its OWN signing secret. Reusing it would break one or the other.)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY, SITE_URL
//   MI_FROM_EMAIL (defaults to hello@skinday.ca, the verified Resend domain)

const Stripe = require('stripe');

// ⚠️ KEY SELECTION. MI_STRIPE_SECRET_KEY wins when set, STRIPE_SECRET_KEY is the
// fallback. That exists so Market Intelligence can run against the SANDBOX while
// Visualize Pro keeps using the live key in the same account: a live key cannot
// see sandbox prices, which is exactly how the first checkout failed
// ("a similar object exists in test mode, but a live mode key was used").
// Delete MI_STRIPE_SECRET_KEY to go live and this silently falls back.
const STRIPE_KEY = process.env.MI_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  const stripe = Stripe(STRIPE_KEY);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let ev;
  try {
    ev = stripe.webhooks.constructEvent(raw, sig, process.env.MI_STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    // 400 tells Stripe not to retry: a bad signature will never become good.
    return { statusCode: 400, body: 'signature check failed: ' + e.message };
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  const site = (process.env.SITE_URL || 'https://skinday.com').replace(/\/+$/, '');

  try {
    if (ev.type === 'checkout.session.completed') {
      const s = ev.data.object;
      // Subscription metadata is the authoritative copy; the session copy is a
      // fallback for the case where the subscription object arrives empty.
      let md = s.metadata || {};
      let sub = null;
      if (s.subscription) {
        sub = await stripe.subscriptions.retrieve(s.subscription);
        if (sub && sub.metadata && sub.metadata.mi_company) md = sub.metadata;
      }
      if (!md.mi_company) return { statusCode: 200, body: 'not a market intelligence signup' };

      const trialEnds = sub && sub.trial_end
        ? new Date(sub.trial_end * 1000).toISOString()
        : new Date(Date.now() + 14 * 864e5).toISOString();

      // Atomic, and idempotent on the subscription id: Stripe retries webhooks,
      // and a retry must not mint a second tenant for the same payment.
      const { data, error } = await supabase.rpc('mi_signup_tenant', {
        p_owner_name: md.mi_company,
        p_owner_type: md.mi_company_type || 'manufacturer',
        p_country: md.mi_country || 'canada',
        p_email: md.mi_email || s.customer_email || s.customer_details?.email,
        p_person_name: md.mi_name || '',
        p_plan: md.mi_plan || 'solo',
        p_seat_limit: parseInt(md.mi_seats, 10) || 1,
        p_trial_ends_at: trialEnds,
        p_stripe_customer: typeof s.customer === 'string' ? s.customer : null,
        p_stripe_sub: typeof s.subscription === 'string' ? s.subscription : null
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const to = md.mi_email || s.customer_email;
      let mailed = 'skipped';
      if (row && row.invite_token && to) {
        mailed = await sendInvite(to, md.mi_company, site + '/mi-invite?token=' + row.invite_token);
      }
      // ⚠️ The email failure is LOGGED, never thrown. The tenant already exists
      // and the invite token is already in mi_users, so failing the webhook here
      // would make Stripe retry a signup that actually succeeded. But it must not
      // be silent either: the first live test created the tenant, sent nothing,
      // and reported success, which took a round trip to notice.
      console.log('mi-signup: tenant ' + (row && row.tenant_id) + ' created, invite email ' + mailed);
      return { statusCode: 200, body: 'tenant ready, invite email ' + mailed };
    }

    // Keeps the dashboard's view of the subscription current without it having
    // to ask Stripe on every page load.
    if (ev.type === 'customer.subscription.updated' ||
        ev.type === 'customer.subscription.deleted') {
      const sub = ev.data.object;
      await supabase.from('mi_tenants').update({
        sub_status: ev.type.endsWith('deleted') ? 'canceled' : sub.status,
        trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        // ⚠️ `active` is what actually gates sign-in, so a cancellation closes
        // the door here rather than only changing a label nobody enforces.
        active: !(ev.type.endsWith('deleted') || sub.status === 'canceled')
      }).eq('stripe_subscription_id', sub.id);
      return { statusCode: 200, body: 'subscription updated' };
    }

    return { statusCode: 200, body: 'ignored' };
  } catch (e) {
    // 500 asks Stripe to retry, which is right for a transient database error.
    return { statusCode: 500, body: 'handler failed: ' + e.message };
  }
};

// Returns a short status string rather than throwing. The caller logs it.
async function sendInvite(to, company, link) {
  if (!process.env.RESEND_API_KEY) return 'not sent: RESEND_API_KEY missing on this site';
  const from = process.env.MI_FROM_EMAIL || 'SkinDay <hello@skinday.ca>';
  const text =
    'Your SkinDay Market Intelligence account for ' + company + ' is ready.\n\n' +
    'Set your password and sign in here:\n' + link + '\n\n' +
    'The link is valid for 14 days. Your first 14 days are free, and you can ' +
    'cancel any time before then without being charged.\n\n' +
    'If you have any trouble, just reply to this email.\n\nSkinDay';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from, to: [to], subject: 'Your SkinDay Market Intelligence access', text
      })
    });
    const body = await res.text();
    if (!res.ok) return 'FAILED HTTP ' + res.status + ': ' + body.slice(0, 300);
    return 'sent to ' + to;
  } catch (e) {
    return 'FAILED: ' + (e && e.message);
  }
}

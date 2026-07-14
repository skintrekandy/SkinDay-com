// Netlify Function: /.netlify/functions/stripe-webhook
//
// Handles TWO things, and they must not be confused:
//
//   1. Credit purchases (consumer Visualize). One-off payments. Lands credits in
//      the ledger. Idempotent via the unique stripe_session_id.
//
//   2. Visualize Pro subscriptions (clinics). Writes clinic_subscriptions.
//
// Both fire checkout.session.completed, which is why one endpoint has to know the
// difference. It tells them apart by session.mode: 'payment' is credits,
// 'subscription' is a clinic. Nothing about the credit path below has changed.
//
// Zero npm dependencies, as before: signatures are verified manually per Stripe's
// documented scheme (HMAC-SHA256 of "<timestamp>.<raw body>", compared timing-safe
// against every v1 candidate). The one Stripe API call the subscription path needs
// is a single GET, done with fetch, so this file stays free of the SDK.
//
// THE WEBHOOK IS THE ONLY THING THAT WRITES SUBSCRIPTION STATE. Not the browser,
// not the success page. A success_url redirect proves someone reached a URL; it
// does not prove a payment. A clinic is subscribed because Stripe said so, here,
// with a signature.
//
// Stripe dashboard: ONE endpoint at
//   https://<site>/.netlify/functions/stripe-webhook
// listening to:
//   checkout.session.completed
//   checkout.session.async_payment_succeeded
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
//
// Env: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
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

// PostgREST upsert. merge-duplicates makes this INSERT ... ON CONFLICT DO UPDATE
// on the primary key, which is what a webhook arriving twice, or out of order,
// needs.
async function upsertRow(table, row, onConflict) {
  const url = SUPABASE_URL + '/rest/v1/' + table + '?on_conflict=' + onConflict;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) {
    throw new Error('upsert ' + table + ' failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
}

async function selectOne(table, query) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + query + '&limit=1', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return (rows && rows[0]) || null;
}

// One GET. Not worth the SDK.
async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + STRIPE_KEY }
  });
  if (!res.ok) throw new Error('Stripe GET ' + path + ' failed: HTTP ' + res.status);
  return res.json();
}

// Stripe's statuses are not ours. incomplete and unpaid are both "no".
function mapStatus(s) {
  switch (s) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
    case 'unpaid':
      return 'canceled';
    default:
      return 'none';
  }
}

function ts(n) {
  return n ? new Date(n * 1000).toISOString() : null;
}

async function writeSubscription(clinicId, sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;

  // Stripe moved current_period_end onto the subscription ITEM in recent API
  // versions. Read the item first, fall back to the subscription for older ones,
  // so this works whichever API version the account is pinned to.
  const periodEnd = (item && item.current_period_end) || sub.current_period_end;

  await upsertRow('clinic_subscriptions', {
    clinic_id: clinicId,
    status: mapStatus(sub.status),
    plan: 'visualize_pro',
    trial_ends_at: ts(sub.trial_end),
    current_period_end: ts(periodEnd),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id),
    stripe_subscription_id: sub.id,
    stripe_price_id: price ? price.id : null,
    updated_at: new Date().toISOString()
  }, 'clinic_id');

  console.log('stripe-webhook: clinic ' + clinicId + ' -> ' + mapStatus(sub.status));
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

  const obj = (evt.data && evt.data.object) || {};

  // -------------------------------------------------------------------------
  // Subscription lifecycle. Renewals, failed cards, cancellations, and anything
  // changed by hand in the Stripe dashboard.
  // -------------------------------------------------------------------------
  if (
    evt.type === 'customer.subscription.created' ||
    evt.type === 'customer.subscription.updated' ||
    evt.type === 'customer.subscription.deleted'
  ) {
    try {
      let clinicId = obj.metadata && obj.metadata.clinic_id;

      // A subscription edited in the dashboard may carry no metadata. Fall back
      // to the subscription id already on file, which is why it is stored.
      if (!clinicId) {
        const row = await selectOne(
          'clinic_subscriptions',
          'stripe_subscription_id=eq.' + encodeURIComponent(obj.id) + '&select=clinic_id'
        );
        clinicId = row && row.clinic_id;
      }

      if (!clinicId) {
        console.error('stripe-webhook: cannot map subscription to a clinic', obj.id);
        return json(200, { received: true });
      }

      // A deletion is a cancellation, whatever the object says its status is.
      const sub = (evt.type === 'customer.subscription.deleted')
        ? Object.assign({}, obj, { status: 'canceled' })
        : obj;

      await writeSubscription(clinicId, sub);
      return json(200, { received: true });
    } catch (err) {
      console.error('stripe-webhook: subscription write failed (Stripe will retry):', (err && err.message) || err);
      return json(500, { error: 'Subscription write failed; retry.' });
    }
  }

  // -------------------------------------------------------------------------
  // Checkout completed. Credits and subscriptions both land here, and this is
  // where they are told apart.
  // -------------------------------------------------------------------------
  const isCheckout = evt.type === 'checkout.session.completed' ||
                     evt.type === 'checkout.session.async_payment_succeeded';
  if (!isCheckout) return json(200, { received: true });

  const session = obj;

  // ---- a clinic subscribing
  if (session.mode === 'subscription') {
    const clinicId = session.client_reference_id ||
                     (session.metadata && session.metadata.clinic_id);
    if (!clinicId || !session.subscription) {
      console.error('stripe-webhook: subscription checkout with no clinic id', session.id);
      return json(200, { received: true });
    }
    try {
      const sub = await stripeGet('subscriptions/' + session.subscription);
      await writeSubscription(clinicId, sub);
      return json(200, { received: true });
    } catch (err) {
      console.error('stripe-webhook: subscription landing failed (Stripe will retry):', (err && err.message) || err);
      return json(500, { error: 'Subscription landing failed; retry.' });
    }
  }

  // ---- a credit purchase. Byte for byte what it was.
  if (session.payment_status !== 'paid') return json(200, { received: true });

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

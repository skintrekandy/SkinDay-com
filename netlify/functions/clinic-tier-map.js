// netlify/functions/clinic-tier-map.js
//
// The single source of truth mapping Stripe price IDs to seat tiers. Required by
// both clinic-subscribe.js (to choose a price from a tier the owner picked) and
// stripe-webhook.js (to derive the operational tier from the price a clinic
// actually paid). Keeping it in one file is deliberate: the tier a clinic is on
// must never be recorded in two places that can disagree.
//
// The webhook treats the Stripe price as the billing authority. A clinic is on a
// tier because that is the price on their subscription, verified by signature,
// not because the browser said so. An unrecognized price must fail loudly and
// leave entitlement unchanged, never silently default to a tier.
//
// Seats per tier live in the database (apply_clinic_tier / _tier_seat_limit):
//   solo 1, boutique 4, premium 12, enterprise contact-us.
// Founding is a premium entitlement (12 seats) at a locked price, so it maps to
// the premium tier with founding = true, keeping the special price distinguishable.
//
// Env (set in Netlify):
//   STRIPE_PRICE_SOLO
//   STRIPE_PRICE_BOUTIQUE
//   STRIPE_PRICE_PREMIUM
//   STRIPE_PRICE_FOUNDING

const PRICE_SOLO     = process.env.STRIPE_PRICE_SOLO || '';
const PRICE_BOUTIQUE = process.env.STRIPE_PRICE_BOUTIQUE || '';
const PRICE_PREMIUM  = process.env.STRIPE_PRICE_PREMIUM || '';
const PRICE_FOUNDING = process.env.STRIPE_PRICE_FOUNDING || '';

// Tiers a self-serve checkout may be started for. Enterprise is contact-us and
// has no standard price.
const SELF_SERVE_TIERS = ['solo', 'boutique', 'premium'];

// tier -> the price id a checkout should use.
function priceForTier(tier) {
  switch (tier) {
    case 'solo':     return PRICE_SOLO || null;
    case 'boutique': return PRICE_BOUTIQUE || null;
    case 'premium':  return PRICE_PREMIUM || null;
    default:         return null; // enterprise or unknown: no self-serve price
  }
}

// price id -> { tier, founding }, or null if the price is not recognized. A null
// return is a signal to the caller to fail loudly, never to assume a tier.
function tierForPrice(priceId) {
  if (!priceId) return null;
  if (PRICE_SOLO     && priceId === PRICE_SOLO)     return { tier: 'solo',     founding: false };
  if (PRICE_BOUTIQUE && priceId === PRICE_BOUTIQUE) return { tier: 'boutique', founding: false };
  if (PRICE_PREMIUM  && priceId === PRICE_PREMIUM)  return { tier: 'premium',  founding: false };
  if (PRICE_FOUNDING && priceId === PRICE_FOUNDING) return { tier: 'premium',  founding: true };
  return null;
}

module.exports = { SELF_SERVE_TIERS, priceForTier, tierForPrice };

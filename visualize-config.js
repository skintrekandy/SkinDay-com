// Netlify Function: /.netlify/functions/visualize-config
// Public, read-only client bootstrap for SkinDay Visualize accounts.
//
// Serves the Supabase URL + anon key (public by design) and the credit packs,
// all from environment variables, so the client HTML never needs key edits.
// When the Supabase env vars are absent (e.g. a fresh staging deploy before
// setup), it answers { authDisabled: true } and the client falls back to the
// beta-password-only mode, exactly the pre-M8 behavior.
//
// Env (optional): SUPABASE_URL, SUPABASE_ANON_KEY, VISUALIZE_PACKS,
//                 VISUALIZE_SIGNUP_GRANT,
//                 VISUALIZE_COST_FILLER, VISUALIZE_COST_BIOSTIM,
//                 VISUALIZE_COST_TOX, VISUALIZE_COST_LASER,
//                 VISUALIZE_COST_SCENARIO, VISUALIZE_COST_ENHANCED
// VISUALIZE_PACKS overrides the default packs without a code change. JSON, e.g.
// [{"id":"starter","label":"Starter","credits":20,"cad":5900}, ...]
// (cad is in cents).

// cad = what is charged today (launch price). regularCad = the post-beta list
// price, shown struck through in the buy modal as forward-looking framing
// ("regular after beta"), never as a fake former price.
const DEFAULT_PACKS = [
  { id: 'starter', label: 'Starter', credits: 2000,  cad: 2900,  regularCad: 5900  },
  { id: 'clinic',  label: 'Clinic',  credits: 6000,  cad: 6900,  regularCad: 14900 },
  { id: 'studio',  label: 'Studio',  credits: 15000, cad: 13900, regularCad: 32900 }
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
  } catch (e) { /* fall through to defaults */ }
  return DEFAULT_PACKS;
}

exports.handler = async () => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const body = (supabaseUrl && supabaseAnonKey)
    ? {
        authDisabled: false,
        supabaseUrl,
        supabaseAnonKey,
        packs: packs(),
        costs: {
          // Flat 100 credits per angle for every treatment (M14.3). Fallbacks
          // match the live env scheme where the value is the credit count
          // directly (100 = one angle), not a raw unit multiplied later.
          filler:   parseInt(process.env.VISUALIZE_COST_FILLER   || '100', 10) || 100,
          biostim:  parseInt(process.env.VISUALIZE_COST_BIOSTIM  || '100', 10) || 100,
          tox:      parseInt(process.env.VISUALIZE_COST_TOX      || '100', 10) || 100,
          laser:    parseInt(process.env.VISUALIZE_COST_LASER    || '100', 10) || 100,
          scenario: parseInt(process.env.VISUALIZE_COST_SCENARIO || '50',  10) || 50,
          enhanced: parseInt(process.env.VISUALIZE_COST_ENHANCED || '50',  10) || 50
        },
        // Signup grant is in the same credit units as costs (100 = one angle).
        // Default 600 = six free angles (e.g. two 3-angle cases) so a new clinic
        // can try the tool on a real consultation. Override with the env var.
        signupGrant: parseInt(process.env.VISUALIZE_SIGNUP_GRANT || '600', 10) || 0,
        currency: (process.env.VISUALIZE_CURRENCY || 'cad').toLowerCase()
      }
    : { authDisabled: true };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
};

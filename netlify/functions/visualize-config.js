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
//                 VISUALIZE_COST_SCENARIO, VISUALIZE_COST_ENHANCED
// VISUALIZE_PACKS overrides the default packs without a code change. JSON, e.g.
// [{"id":"starter","label":"Starter","credits":20,"cad":5900}, ...]
// (cad is in cents).

// cad = what is charged today (launch price). regularCad = the post-beta list
// price, shown struck through in the buy modal as forward-looking framing
// ("regular after beta"), never as a fake former price.
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
          filler:   parseInt(process.env.VISUALIZE_COST_FILLER   || '1', 10) || 1,
          biostim:  parseInt(process.env.VISUALIZE_COST_BIOSTIM  || '2', 10) || 2,
          scenario: parseInt(process.env.VISUALIZE_COST_SCENARIO || '1', 10) || 1,
          enhanced: parseInt(process.env.VISUALIZE_COST_ENHANCED || '1', 10) || 1
        },
        signupGrant: parseInt(process.env.VISUALIZE_SIGNUP_GRANT || '6', 10) || 0,
        currency: (process.env.VISUALIZE_CURRENCY || 'cad').toLowerCase()
      }
    : { authDisabled: true };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
};

// netlify/functions/admin-costs.js
// Returns cost summary data for the admin dashboard.
// Protected by ADMIN_SECRET env var (Bearer token check).
// Returns JSON; called by admin-costs.html via fetch.

const { createClient } = require('@supabase/supabase-js');

// Credit pack definitions. Read from the same VISUALIZE_PACKS env the live app
// uses, so the dashboard can never drift from production pricing. VISUALIZE_PACKS
// stores cad in CENTS; convert to whole CAD here for display. Falls back to the
// current (post-redenomination) scale if the env is absent.
function loadPacks(){
  const fallback = [
    { id: 'starter', credits: 2000,  price_cad: 29 },
    { id: 'clinic',  credits: 6000,  price_cad: 69 },
    { id: 'studio',  credits: 15000, price_cad: 139 },
  ];
  try {
    const env = process.env.VISUALIZE_PACKS;
    if(!env) return fallback;
    const parsed = JSON.parse(env);
    if(Array.isArray(parsed) && parsed.length &&
       parsed.every(p => p.id && p.credits > 0 && p.cad > 0)){
      return parsed.map(p => ({ id: p.id, credits: p.credits, price_cad: p.cad / 100 }));
    }
  } catch(e){ /* fall through to fallback */ }
  return fallback;
}
const PACKS = loadPacks();

// Per-action credit costs (mirror the live app's VISUALIZE_COST_* env). Used to
// convert pack credits into generation counts and to value each generation.
const FILLER_COST   = parseInt(process.env.VISUALIZE_COST_FILLER   || '100', 10) || 100;
const BIOSTIM_COST  = parseInt(process.env.VISUALIZE_COST_BIOSTIM  || '100', 10) || 100;
const SCENARIO_COST = parseInt(process.env.VISUALIZE_COST_SCENARIO || '100', 10) || 100;

// Exchange rate for display (USD cost vs CAD revenue)
const CAD_TO_USD = parseFloat(process.env.CAD_TO_USD || '0.73');

exports.handler = async (event) => {
  // Auth check. Uses VISUALIZE_ADMIN_SECRET, a credential separate from the
  // Canada directory admin's ADMIN_SECRET, so the two admin systems are fully
  // isolated: a leak or rotation of one never affects the other.
  const auth = (event.headers['authorization'] || '').replace('Bearer ', '').trim();
  if(!process.env.VISUALIZE_ADMIN_SECRET || auth !== process.env.VISUALIZE_ADMIN_SECRET){
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Daily summary (last 30 days)
    const { data: daily, error: dailyErr } = await supabase
      .from('generation_cost_summary')
      .select('*')
      .limit(30);
    if(dailyErr) throw dailyErr;

    // All-time totals
    const { data: totals, error: totalsErr } = await supabase
      .from('generation_logs')
      .select('estimated_cost_usd, credits_charged, status, treatment_type, angle')
      .gte('created_at', new Date(Date.now() - 30 * 86400_000).toISOString());
    if(totalsErr) throw totalsErr;

    // Compute aggregate stats
    const successful = totals.filter(r => r.status === 'success');
    const failed     = totals.filter(r => r.status !== 'success');
    const totalCostUsd    = totals.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const successCostUsd  = successful.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const wastedCostUsd   = failed.reduce((s, r) => s + (parseFloat(r.estimated_cost_usd) || 0), 0);
    const avgCostSuccess  = successful.length ? successCostUsd / successful.length : 0;
    const totalCredits    = successful.reduce((s, r) => s + (r.credits_charged || 0), 0);

    // Revenue estimate. CAD per credit is taken from the Clinic pack (or the
    // first pack) at current pricing. Revenue is then computed from GENERATION
    // COUNTS x per-generation CAD value, NOT from the raw credits_charged sum.
    // This is scale-invariant: a biostim generation is the same product whether
    // it was billed 2 credits (old scale) or 200 (new scale), so a 30-day window
    // that straddles the redenomination stays accurate. (Summing credits_charged
    // directly would value old-scale rows at the new rate, badly skewing totals.)
    const refPack = PACKS.find(p => p.id === 'clinic') || PACKS[0];
    const cadPerCredit = refPack && refPack.credits ? (refPack.price_cad / refPack.credits) : 0;
    const genCadByType = {
      biostim:  BIOSTIM_COST  * cadPerCredit,
      filler:   FILLER_COST   * cadPerCredit,
      scenario: SCENARIO_COST * cadPerCredit,
    };
    const revenueEstCAD = successful.reduce((s, r) => {
      const t = r.treatment_type || 'filler';
      const perGen = (genCadByType[t] != null) ? genCadByType[t] : (FILLER_COST * cadPerCredit);
      return s + perGen;
    }, 0);
    const revenueEstUSD    = revenueEstCAD * CAD_TO_USD;
    const marginUSD        = revenueEstUSD - successCostUsd;

    // Pack margin analysis
    const packMargins = PACKS.map(p => {
      const revenueUsd    = p.price_cad * CAD_TO_USD;
      // avgCostSuccess is cost per GENERATION. Convert pack credits into
      // generation counts using the per-action credit cost, so the math holds at
      // any credit scale (old: filler=1/biostim=2; new: flat 100 per angle for all types).
      const fillerGens    = p.credits / FILLER_COST;
      const biostimGens   = p.credits / BIOSTIM_COST;
      const costIfAllFiller  = fillerGens  * avgCostSuccess;
      const costIfAllBiostim = biostimGens * avgCostSuccess;
      return {
        pack:              p.id,
        credits:           p.credits,
        price_cad:         p.price_cad,
        revenue_usd:       revenueUsd,
        cost_if_all_filler:   costIfAllFiller,
        cost_if_all_biostim:  costIfAllBiostim,
        margin_if_all_filler:   revenueUsd - costIfAllFiller,
        margin_if_all_biostim:  revenueUsd - costIfAllBiostim,
      };
    });

    // By angle breakdown
    const byAngle = {};
    for(const r of successful){
      const a = r.angle || 'unknown';
      if(!byAngle[a]) byAngle[a] = { count: 0, cost: 0 };
      byAngle[a].count++;
      byAngle[a].cost += parseFloat(r.estimated_cost_usd) || 0;
    }

    // By treatment type
    const byType = {};
    for(const r of successful){
      const t = r.treatment_type || 'unknown';
      if(!byType[t]) byType[t] = { count: 0, cost: 0 };
      byType[t].count++;
      byType[t].cost += parseFloat(r.estimated_cost_usd) || 0;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        window_days: 30,
        totals: {
          total_generations:  totals.length,
          successful:         successful.length,
          failed:             failed.length,
          total_cost_usd:     totalCostUsd,
          success_cost_usd:   successCostUsd,
          wasted_cost_usd:    wastedCostUsd,
          avg_cost_per_gen:   avgCostSuccess,
          total_credits_used: totalCredits,
          revenue_est_cad:    revenueEstCAD,
          revenue_est_usd:    revenueEstUSD,
          margin_est_usd:     marginUSD,
        },
        daily,
        by_angle:    byAngle,
        by_type:     byType,
        pack_margins: packMargins,
      }),
    };
  } catch(err){
    console.error('[admin-costs] Error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

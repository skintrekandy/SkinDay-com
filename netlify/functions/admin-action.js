// netlify/functions/admin-action.js  (skinday.com global admin)
//
// Vote moderation, Visualize Pro sign-ups, and DIRECTORY CLAIMS.
//
// ⚠️ M23 REVERSAL, stated plainly because the old comment said the opposite.
// This build used to exclude directory operations on purpose: .com was
// Visualize, Taiwan and Hong Kong, and every directory claim was Canadian, so
// the .ca admin was the only place claims needed to be worked.
//
// .com now hosts the US directory. US claims land in the SAME `claims` table,
// so excluding claim actions here meant the only way to approve a US claim was
// through the Canadian admin. The four claim actions below are therefore added
// deliberately, not by oversight.
//
// ADD-CLINIC and manual price entry (set-prices) remain .ca only.
//
// ⭐ PRICE CRAWL REVIEW ADDED 2026-09-29, for the New York price crawl run from
// this admin. Same four actions and the same rules as the .ca build (a price a
// clinic already has is never overwritten; price_date is the day the page was
// read), plus optional country/state scoping so a US review list is not buried
// under Canadian rows.
//
// (skinday.com and skinday.ca share one Supabase database, so every action
// here operates on the same rows either admin would see.)
//
// Actions:
//   list-flagged-votes   -> { votes: [ ...enriched ] }
//   review-vote          { visit_id, decision:'approve'|'remove' } -> { success }
//   review-votes-bulk    { visit_ids:[...], decision } -> { success, count }
//   list                 { status } -> { claims: [...] }
//   approve              { claim_id, admin_note } -> { success }
//   reject               { claim_id, admin_note } -> { success }
//   revoke               { claim_id, admin_note } -> { success }
//   price-candidate-stats    { country?, state? } -> { counts, queue_pending }
//   list-price-candidates    { status, limit, country?, state? } -> { candidates }
//   approve-price-candidates { ids:[...] } -> { approved, already_priced }
//   reject-price-candidates  { ids:[...], note? } -> { rejected }
//
// M36 moderation model:
//   A vote counts publicly unless it is HIDDEN. `flagged` means "needs review"
//   and still counts. approve = clear the flag (vote stays). remove = set hidden
//   (drops from the count) and clear the flag.
//
// Auth: unified with the rest of the .com global admin. Accepts either the
// x-admin-secret header or a Bearer token, matched against either ADMIN_SECRET
// or VISUALIZE_ADMIN_SECRET. One login secret works across the whole console.
//
// clinic_visits.id and clinic_visits.clinic_id are TEXT; all id filters use
// strings.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────────────────────
// CLAIM SUPPORT (M23), ported from the skinday.ca build.
//
// ⚠️ THE APPROVAL EMAIL IS SENT INLINE HERE, not by the approve-claim.js
// webhook. The .ca build did it this way because self-HTTP calls between
// Netlify functions proved unreliable, and that is the path that actually
// works today. Keep them consistent: a change to the email or the portal link
// has to be made in both, or one country silently keeps the old behaviour.
// ─────────────────────────────────────────────────────────────

// A US clinic must not be sent to the Canadian portal. Resolved from the
// clinic's own country. Same table as the .ca build; the difference is that
// .com actually has non-Canadian claims to serve.
const SITE_BY_COUNTRY = {
  canada:   'https://skinday.ca',
  usa:      'https://skinday.com',
  taiwan:   'https://skinday.com',
  hongkong: 'https://skinday.com'
};

// ⚠️ The CONTACT address follows the clinic's own site, so each site's contact
// email matches its domain. The SENDER stays hello@skinday.ca on both: that is
// the domain verified in Resend and the one the .com key is scoped to, and
// verifying a second domain is deliberately not being paid for.
//
// ⚠️ Both approval paths serve BOTH countries. This function is .ca-only but is
// fired by a webhook on every clinic; the .com admin's claims queue likewise
// shows every country. So neither can hardcode a contact address.
function contactFor(country) {
  const key = String(country || '').trim().toLowerCase();
  const site = SITE_BY_COUNTRY[key] || 'https://skinday.ca';
  return 'hello@' + site.replace(/^https?:\/\//, '');
}

async function portalUrlForClinic(clinicId) {
  try {
    const { data } = await supabase
      .from('clinics')
      .select('country')
      .eq('id', String(clinicId))
      .maybeSingle();
    const key = String((data && data.country) || '').trim().toLowerCase();
    const site = SITE_BY_COUNTRY[key];
    if (site) return site + '/editor.html';
    console.error('No site mapped for country "' + key + '" on clinic ' + clinicId);
  } catch (e) {
    console.error('portalUrlForClinic lookup failed:', e.message);
  }
  return process.env.PORTAL_URL || 'https://skinday.ca/editor.html';
}

// Labels every location a chain owner can switch between in the portal.
async function buildClinicNamesMap(clinicIds, primaryName, primaryId) {
  const namesMap = {};
  namesMap[String(primaryId)] = primaryName;
  const others = clinicIds.filter(id => String(id) !== String(primaryId));
  if (others.length > 0) {
    const { data: otherClaims } = await supabase
      .from('claims')
      .select('clinic_id, clinic_name, clinic_neighbourhood')
      .in('clinic_id', others);
    (otherClaims || []).forEach(cl => {
      namesMap[String(cl.clinic_id)] = cl.clinic_neighbourhood
        ? (cl.clinic_name + ' - ' + cl.clinic_neighbourhood)
        : cl.clinic_name;
    });
    others.forEach(id => {
      if (!namesMap[String(id)]) namesMap[String(id)] = 'Location ' + id;
    });
  }
  return namesMap;
}

function approvalEmailHtml(clinicName, setupLink, locationCount, portalUrl) {
  const contact = 'hello@' + String(portalUrl).replace(/^https?:\/\//, '').split('/')[0];
  const isChain = locationCount > 1;
  const headline = isChain ? 'Your listings are live' : 'Your listing is live';
  const bodyLine = isChain
    ? 'Great news, <strong>' + clinicName + '</strong> and your other ' + (locationCount - 1) + ' location(s) have been approved on SkinDay.'
    : 'Great news, <strong>' + clinicName + '</strong> has been approved on SkinDay.';
  const portalLabel = String(portalUrl).replace(/^https?:\/\//, '');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>'
    + 'body{margin:0;padding:0;background:#faf8f5;font-family:Georgia,sans-serif;}'
    + '.wrap{max-width:520px;margin:40px auto;background:#fffef9;border:1px solid #e8ddd8;border-radius:16px;overflow:hidden;}'
    + '.header{background:#3d2c28;padding:28px 36px;}.logo{font-size:24px;color:white;}.logo span{color:#e8a89f;}'
    + '.body{padding:36px;}h1{font-size:22px;color:#3d2c28;margin:0 0 12px;font-weight:600;}'
    + 'p{font-size:15px;color:#6b4c44;line-height:1.6;margin:0 0 16px;}'
    + '.btn{display:inline-block;background:#c9736a;color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600;margin:8px 0 24px;}'
    + '.note{font-size:13px;color:#9e7a72;}'
    + '.footer{background:#faf8f5;border-top:1px solid #e8ddd8;padding:20px 36px;font-size:12px;color:#9e7a72;}'
    + '</style></head><body><div class="wrap">'
    + '<div class="header"><div class="logo">Skin<span>Day</span></div></div>'
    + '<div class="body"><h1>' + headline + '</h1><p>' + bodyLine + '</p>'
    + '<p>Set up your password to access the Clinic Portal, where you can update your pricing, add promos, upload photos, list your equipment and manage your hours.</p>'
    + '<a href="' + setupLink + '" class="btn">Set up your password</a>'
    + '<p class="note">This link expires in 24 hours. If it expires, visit <a href="' + portalUrl + '" style="color:#c9736a;">' + portalLabel + '</a> and use "Forgot password."</p>'
    + '</div>'
    + '<div class="footer">Questions? Reply to this email or contact <a href="mailto:' + contact + '" style="color:#c9736a;">' + contact + '</a><br/>SkinDay</div>'
    + '</div></body></html>';
}


// ─────────────────────────────────────────────────────────────
// PRICE CRAWL REVIEW (ported from the .ca build, 2026-09-29)
// ─────────────────────────────────────────────────────────────

// PostgREST puts .in() lists in the URL; ~300 text ids overflow it and the
// request fails quietly. Always chunk.
async function selectInChunks(table, cols, column, values) {
  const out = [];
  for (let i = 0; i < values.length; i += 60) {
    const { data, error } = await supabase.from(table).select(cols).in(column, values.slice(i, i + 60));
    if (error) throw error;
    (data || []).forEach(r => out.push(r));
  }
  return out;
}

// Recompute clinics.price from EVERY clinic_prices row for the clinic, so the
// card and the price modal agree. Identical to the .ca build.
async function syncClinicLowestPrice(clinicId) {
  const id = String(clinicId);
  const { data: rows, error } = await supabase
    .from('clinic_prices')
    .select('price, toxin, price_source, price_date')
    .eq('clinic_id', id)
    .order('price', { ascending: true })
    .limit(1);
  if (error) { console.error('syncClinicLowestPrice read error:', error); return; }
  const update = (rows && rows.length)
    ? { price: rows[0].price, price_source: rows[0].price_source, price_date: rows[0].price_date, toxin_type: rows[0].toxin }
    : { price: null, price_source: null, price_date: null, toxin_type: null };
  const { error: upErr } = await supabase.from('clinics').update(update).eq('id', id);
  if (upErr) console.error('syncClinicLowestPrice write error:', upErr);
}

function cleanScope(body) {
  const country = String(body.country || '').trim().toLowerCase() || null;
  const st = String(body.state || '').trim().toLowerCase();
  const state = (country === 'usa' && /^[a-z-]+$/.test(st)) ? st : null;
  return { country, state };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Unified auth: accept EITHER the x-admin-secret header (this endpoint's
  // original scheme) OR a Bearer token (the scheme admin-costs uses), and match
  // against EITHER ADMIN_SECRET or VISUALIZE_ADMIN_SECRET. This makes the .com
  // global admin a single console under one login: the same secret the operator
  // types works for Costs and for vote moderation, regardless of which env var
  // name is set on the .com site. At least one of the two env vars must be set.
  const bearer = (event.headers['authorization'] || event.headers['Authorization'] || '').replace(/^Bearer\s+/i, '');
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || bearer;
  const validSecrets = [process.env.ADMIN_SECRET, process.env.VISUALIZE_ADMIN_SECRET].filter(Boolean);
  if (!secret || !validSecrets.includes(secret)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;

  // ── LIST FLAGGED VOTES ───────────────────────────────────────────────────────
  // Votes awaiting review: flagged = true and not yet hidden. Flagged votes still
  // count publicly; this queue lets a human approve (clear the flag) or remove
  // (set hidden, dropping it from the count). Enriched with clinic names and two
  // context signals so the reviewer can judge the pattern.
  if (action === 'list-flagged-votes') {
    const { data: votes, error } = await supabase
      .from('clinic_visits')
      .select('id, clinic_id, user_id, would_return, treatment_type, visit_month, created_at')
      .eq('flagged', true)
      .not('hidden', 'is', true)
      .order('user_id', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('list-flagged-votes error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list flagged votes' }) };
    }

    const rows = votes || [];
    if (rows.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ votes: [] }) };
    }

    // Clinic names for display.
    const clinicIds = [...new Set(rows.map(r => String(r.clinic_id)))];
    const { data: clinicRows } = await supabase
      .from('clinics')
      .select('id, name, neighbourhood')
      .in('id', clinicIds);
    const clinicNames = {};
    (clinicRows || []).forEach(c => {
      clinicNames[String(c.id)] = c.neighbourhood ? (c.name + ' (' + c.neighbourhood + ')') : c.name;
    });

    // Per-account context: how many clinics this account has voted on (the unique
    // constraint means one vote per clinic, so this count is a clinic count). A
    // real patient votes on a few; a staffer blasting locations votes on many.
    const userIds = [...new Set(rows.map(r => r.user_id))];
    const { data: userVoteRows } = await supabase
      .from('clinic_visits')
      .select('user_id')
      .in('user_id', userIds)
      .not('hidden', 'is', true);
    const userTotals = {};
    (userVoteRows || []).forEach(v => { userTotals[v.user_id] = (userTotals[v.user_id] || 0) + 1; });

    // Per-clinic context: yes / total among counted votes, to surface all-yes bursts.
    const { data: clinicVoteRows } = await supabase
      .from('clinic_visits')
      .select('clinic_id, would_return')
      .in('clinic_id', clinicIds)
      .not('hidden', 'is', true);
    const clinicYes = {}, clinicTotal = {};
    (clinicVoteRows || []).forEach(v => {
      const k = String(v.clinic_id);
      clinicTotal[k] = (clinicTotal[k] || 0) + 1;
      if (v.would_return === 'yes') clinicYes[k] = (clinicYes[k] || 0) + 1;
    });

    const enriched = rows.map(r => {
      const cid    = String(r.clinic_id);
      const uTotal = userTotals[r.user_id] || 1;
      const cYes   = clinicYes[cid]   || 0;
      const cTotal = clinicTotal[cid] || 0;

      let reason;
      if (uTotal >= 5) {
        reason = 'This account has voted on ' + uTotal + ' clinics';
      } else if (cTotal >= 8 && cYes === cTotal) {
        reason = 'Clinic is ' + cYes + '/' + cTotal + ' all-yes';
      } else {
        reason = 'Flagged for review';
      }

      return {
        id:               String(r.id),
        clinic_id:        cid,
        clinic_name:      clinicNames[cid] || ('Clinic ' + cid),
        user_id:          r.user_id,
        would_return:     r.would_return,
        treatment_type:   r.treatment_type,
        visit_month:      r.visit_month,
        created_at:       r.created_at,
        user_total_votes: uTotal,
        clinic_yes:       cYes,
        clinic_total:     cTotal,
        reason
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ votes: enriched }) };
  }

  // ── REVIEW ONE VOTE ──────────────────────────────────────────────────────────
  // approve: clear the flag, vote stays counted.
  // remove:  set hidden (drops from the public count) and clear the flag.
  if (action === 'review-vote') {
    const { visit_id, decision } = body;
    if (!visit_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'visit_id required' }) };
    }
    if (!['approve', 'remove'].includes(decision)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "decision must be 'approve' or 'remove'" }) };
    }

    const update = decision === 'approve'
      ? { flagged: false }
      : { hidden: true, flagged: false };

    const { error } = await supabase
      .from('clinic_visits')
      .update(update)
      .eq('id', String(visit_id));

    if (error) {
      console.error('review-vote error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update vote' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, visit_id: String(visit_id), decision }) };
  }

  // ── REVIEW A GROUP OF VOTES ──────────────────────────────────────────────────
  // Same decision applied to many votes at once, e.g. "approve all" for one
  // honest patient across the locations they visited.
  if (action === 'review-votes-bulk') {
    const { visit_ids, decision } = body;
    if (!Array.isArray(visit_ids) || visit_ids.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'visit_ids array required' }) };
    }
    if (!['approve', 'remove'].includes(decision)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "decision must be 'approve' or 'remove'" }) };
    }

    const update = decision === 'approve'
      ? { flagged: false }
      : { hidden: true, flagged: false };

    const ids = visit_ids.map(String);
    const { error } = await supabase
      .from('clinic_visits')
      .update(update)
      .in('id', ids);

    if (error) {
      console.error('review-votes-bulk error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update votes' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, count: ids.length, decision }) };
  }

  // == LIST PENDING CLINICS (Visualize Pro sign-up approvals) ==================
  // Approval lives on clinic_subscriptions.approved (the Pro layer), NOT on
  // clinics, which is shared with the ~thousands of directory listings. A Pro
  // sign-up is pending while its subscription row has approved=false and is not
  // rejected. Enriched with clinic name/location + owner email.
  if (action === 'list-pending-clinics') {
    const { data: subs, error } = await supabase
      .from('clinic_subscriptions')
      .select('clinic_id, status')
      .eq('approved', false)
      .neq('status', 'rejected')
      .limit(200);
    if (error) {
      console.error('list-pending-clinics error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list pending clinics' }) };
    }
    const rows = subs || [];
    const ids = [...new Set(rows.map(r => String(r.clinic_id)))];
    if (!ids.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ clinics: [] }) };
    }
    const { data: clinicRows } = await supabase
      .from('clinics')
      .select('id, name, neighbourhood, region, country')
      .in('id', ids);
    const cById = {};
    (clinicRows || []).forEach(c => { cById[String(c.id)] = c; });

    const { data: mems } = await supabase
      .from('clinic_memberships')
      .select('clinic_id, user_id')
      .in('clinic_id', ids)
      .eq('role', 'owner')
      .eq('status', 'active')
      .is('revoked_at', null);
    const ownerByClinic = {};
    for (const m of (mems || [])) {
      const cid = String(m.clinic_id);
      if (ownerByClinic[cid]) continue;
      try {
        const { data: u } = await supabase.auth.admin.getUserById(m.user_id);
        ownerByClinic[cid] = (u && u.user && u.user.email) || null;
      } catch (e) { /* leave email null */ }
    }

    const out = ids.map(cid => {
      const c = cById[cid] || {};
      return {
        id: cid,
        name: c.name || ('Clinic ' + cid),
        city: c.neighbourhood || c.region || null,
        country: c.country || null,
        owner_email: ownerByClinic[cid] || null
      };
    });
    return { statusCode: 200, headers, body: JSON.stringify({ clinics: out }) };
  }

  // == APPROVE CLINIC =========================================================
  // Approving a Pro sign-up flips its subscription to approved and STARTS the
  // 90-day pilot from this moment (status=trialing, trial_ends_at=now+90d).
  if (action === 'approve-clinic') {
    const { clinic_id } = body;
    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }
    const trialEnds = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('clinic_subscriptions')
      .update({ approved: true, status: 'trialing', trial_ends_at: trialEnds })
      .eq('clinic_id', String(clinic_id));
    if (error) {
      console.error('approve-clinic error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve clinic' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, clinic_id: String(clinic_id), trial_ends_at: trialEnds }) };
  }

  // == REJECT CLINIC ==========================================================
  if (action === 'reject-clinic') {
    const { clinic_id } = body;
    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }
    const { error } = await supabase
      .from('clinic_subscriptions')
      .update({ approved: false, status: 'rejected' })
      .eq('clinic_id', String(clinic_id));
    if (error) {
      console.error('reject-clinic error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject clinic' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, clinic_id: String(clinic_id) }) };
  }

  // == LIST CLAIMS ============================================================
  // Every country. `claims` has no country column, so this is the same queue
  // the .ca admin shows, by design rather than by accident.
  if (action === 'list') {
    const status = body.status || 'pending';
    const { data, error } = await supabase
      .from('claims')
      .select('*')
      .eq('status', status)
      .order('submitted_at', { ascending: false })
      .limit(100);
    if (error) {
      console.error('list claims error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list claims' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ claims: data || [] }) };
  }

  // == REVOKE A CLAIM =========================================================
  // Resets the clinic (all locations for a chain) to unclaimed and bans the
  // auth user so they lose portal access.
  if (action === 'revoke') {
    const { claim_id, admin_note } = body;
    if (!claim_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'claim_id required' }) };
    }

    const { data: revokeClaim, error: rClaimErr } = await supabase
      .from('claims')
      .select('clinic_id, owner_email, chain_clinic_ids, status')
      .eq('id', claim_id)
      .maybeSingle();

    if (rClaimErr || !revokeClaim) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Claim not found' }) };
    }
    if (revokeClaim.status === 'revoked') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Claim is already revoked' }) };
    }

    let clinicIds = [String(revokeClaim.clinic_id)];
    if (revokeClaim.chain_clinic_ids) {
      try {
        const chainIds = JSON.parse(revokeClaim.chain_clinic_ids).map(String);
        if (chainIds.length > 0) clinicIds = chainIds;
      } catch (e) { /* primary only */ }
    }

    const { error: resetErr } = await supabase
      .from('clinics')
      .update({ claimed: false, approved: false, claimed_email: null })
      .in('id', clinicIds);

    if (resetErr) {
      console.error('revoke reset error:', resetErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reset clinic(s)' }) };
    }

    const { error: rUpdateErr } = await supabase
      .from('claims')
      .update({ status: 'revoked', admin_note: admin_note || null, reviewed_at: new Date().toISOString() })
      .eq('id', claim_id);
    if (rUpdateErr) console.error('revoke claim update error:', rUpdateErr);

    if (revokeClaim.owner_email) {
      try {
        const userRes = await fetch(
          `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(revokeClaim.owner_email)}`,
          { headers: { 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        const userData = await userRes.json();
        const authUser = userData && userData.users && userData.users[0];
        if (authUser && authUser.id) {
          await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${authUser.id}`, {
            method: 'PUT',
            headers: {
              'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ban_duration: '87600h' })
          });
        }
      } catch (e) {
        // Non-fatal, the clinic is already reset.
        console.error('Auth ban failed (non-fatal):', e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'revoked', claim_id, clinic_ids_reset: clinicIds }) };
  }

  // == APPROVE / REJECT A CLAIM ===============================================
  if (action === 'approve' || action === 'reject') {
    const { claim_id, admin_note } = body;
    if (!claim_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'claim_id required' }) };
    }

    const { data: claim, error: claimErr } = await supabase
      .from('claims')
      .select('*')
      .eq('id', claim_id)
      .maybeSingle();

    if (claimErr || !claim) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Claim not found' }) };
    }

    // An already-approved claim can be approved again to RE-SEND the email,
    // which is how a failed first send is recovered. Anything else is blocked.
    let alreadyApproved = false;
    if (claim.status === 'approved' && action === 'approve') {
      alreadyApproved = true;
    } else if (claim.status !== 'pending') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Claim is already ' + claim.status }) };
    }

    const now = new Date().toISOString();

    if (action === 'reject') {
      const { error } = await supabase
        .from('claims')
        .update({ status: 'rejected', reviewed_at: now, admin_note: admin_note || null })
        .eq('id', claim_id);
      if (error) {
        console.error('reject error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject claim' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'rejected', claim_id }) };
    }

    if (!alreadyApproved) {
      const { error: upsertErr } = await supabase
        .from('clinics')
        .upsert({
          id:            claim.clinic_id,
          claimed:       true,
          approved:      true,
          claimed_email: claim.owner_email,
          claimed_at:    claim.submitted_at,
          approved_at:   now
        }, { onConflict: 'id' });

      if (upsertErr) {
        console.error('approve upsert error:', upsertErr);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve claim' }) };
      }

      if (claim.is_chain && claim.chain_clinic_ids) {
        try {
          const allIds = JSON.parse(claim.chain_clinic_ids).map(String);
          const otherIds = allIds.filter(id => id !== String(claim.clinic_id));
          if (otherIds.length > 0) {
            const { error: chainErr } = await supabase
              .from('clinics')
              .update({ claimed: true, approved: true, claimed_email: claim.owner_email })
              .in('id', otherIds);
            if (chainErr) console.error('Chain locations update error:', chainErr);
          }
        } catch (e) {
          console.error('Chain clinic_ids parse error:', e.message);
        }
      }

      const { error: claimUpdateErr } = await supabase
        .from('claims')
        .update({ status: 'approved', reviewed_at: now, admin_note: admin_note || null })
        .eq('id', claim_id);
      if (claimUpdateErr) console.error('claim update error:', claimUpdateErr);
    }

    // Auth user + email, inline. Every failure below returns 200 with a
    // warning rather than a 500: the clinic IS approved at this point, and
    // reporting the whole action as failed would invite a re-run that changes
    // nothing. The warning surfaces in the admin so the send can be retried.
    try {
      const SUPA_URL = process.env.SUPABASE_URL;
      const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      let allClinicIds = [String(claim.clinic_id)];
      if (claim.is_chain && claim.chain_clinic_ids) {
        try {
          const parsed = JSON.parse(claim.chain_clinic_ids).map(String);
          if (parsed.length > 0) allClinicIds = parsed;
        } catch (e) { /* primary only */ }
      }

      const portalUrl = await portalUrlForClinic(claim.clinic_id);
      const namesMap = await buildClinicNamesMap(allClinicIds, claim.clinic_name, claim.clinic_id);

      const clinicMeta = {
        clinic_id:    allClinicIds[0],
        clinic_ids:   allClinicIds,
        clinic_name:  claim.clinic_name,
        is_chain:     claim.is_chain || false,
        clinic_names: namesMap
      };

      const authRes = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` },
        body: JSON.stringify({
          email: claim.owner_email,
          email_confirm: true,
          user_metadata: clinicMeta
        })
      });
      const authData = await authRes.json();

      if (!authRes.ok) {
        const msg = (authData.msg || authData.message || '').toLowerCase();
        const alreadyExists = msg.includes('already') || authData.code === 'email_exists';

        if (!alreadyExists) {
          console.error('Auth user creation failed:', JSON.stringify(authData));
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, warning: 'Auth user creation failed: ' + (authData.msg || authData.message || 'unknown') }) };
        }

        // ⚠️⚠️ THE BUG THIS FIXES, found 2026-09-02 on Essential Bella.
        // The old code logged "already exists" and CONTINUED, which sent the
        // password email but left the clinic ids unwritten: a POST to
        // /admin/users creates, it never updates. So any owner who already had
        // a SkinDay login (another clinic, Visualize Pro, Market Intelligence,
        // or a Google sign-in) was approved, emailed, and then found no clinic
        // in their portal. It fails silently and only shows up as "I got the
        // email but there's nothing there".
        //
        // MERGE, do not overwrite. That account's existing metadata carries
        // full_name, the Google provider claims, and clinic_ids for clinics
        // they ALREADY own. Replacing the object would strip all of it and
        // revoke their access to those other clinics.
        const lookupRes = await fetch(
          `${SUPA_URL}/auth/v1/admin/users?email=${encodeURIComponent(claim.owner_email)}`,
          { headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` } }
        );
        const lookupData = await lookupRes.json();
        const existing = lookupData && lookupData.users && lookupData.users[0];

        if (!existing || !existing.id) {
          console.error('Existing auth user not found for', claim.owner_email);
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, warning: 'Owner already has an account but it could not be read, so their clinic access was not granted.' }) };
        }

        const prior = existing.user_metadata || {};
        const priorIds = Array.isArray(prior.clinic_ids) ? prior.clinic_ids.map(String) : [];
        const mergedIds = priorIds.slice();
        allClinicIds.forEach(id => { if (!mergedIds.includes(String(id))) mergedIds.push(String(id)); });

        const patchRes = await fetch(`${SUPA_URL}/auth/v1/admin/users/${existing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` },
          body: JSON.stringify({
            user_metadata: Object.assign({}, prior, {
              clinic_ids:   mergedIds,
              // clinic_id is the landing location. Keep whichever they already
              // had so an existing owner does not get moved to the new clinic
              // on their next sign-in.
              clinic_id:    prior.clinic_id || allClinicIds[0],
              clinic_name:  prior.clinic_name || claim.clinic_name,
              is_chain:     mergedIds.length > 1,
              clinic_names: Object.assign({}, prior.clinic_names || {}, namesMap)
            })
          })
        });

        if (!patchRes.ok) {
          const patchErr = await patchRes.text();
          console.error('Auth metadata merge failed:', patchErr);
          return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, warning: 'Owner already has an account and granting them this clinic failed: ' + patchErr.slice(0, 200) }) };
        }

        console.log('Existing auth user ' + claim.owner_email + ' granted clinics ' + mergedIds.join(', '));
      }

      // ⚠️ redirect_to must be on Supabase's Redirect URLs allowlist. An
      // unlisted url does NOT error; Supabase quietly substitutes the project
      // Site URL and the clinic lands on the wrong site with nothing logged.
      const linkRes = await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` },
        body: JSON.stringify({ type: 'recovery', email: claim.owner_email, redirect_to: portalUrl })
      });
      const linkData = await linkRes.json();
      if (!linkRes.ok || !linkData.action_link) {
        console.error('Link generation failed:', JSON.stringify(linkData));
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, warning: 'Link generation failed' }) };
      }

      const isChain = allClinicIds.length > 1;
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({
          from: 'SkinDay <hello@skinday.ca>',
          to: claim.owner_email,
          subject: isChain
            ? 'Your SkinDay listings are approved: ' + claim.clinic_name
            : 'Your SkinDay listing is approved: ' + claim.clinic_name,
          html: approvalEmailHtml(claim.clinic_name, linkData.action_link, allClinicIds.length, portalUrl)
        })
      });

      if (!emailRes.ok) {
        const emailErr = await emailRes.text();
        console.error('Resend error:', emailErr);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: 'approved', claim_id, warning: 'Email failed: ' + emailErr.slice(0, 200) }) };
      }

      console.log('Approved and emailed: ' + claim.clinic_name + ' -> ' + claim.owner_email + ' (portal ' + portalUrl + ')');

    } catch (e) {
      console.error('Approval email error (non-fatal):', e.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, action: 'approved', claim_id, clinic_id: claim.clinic_id, resent: alreadyApproved })
    };
  }

  // == PRICE CANDIDATES =======================================================
  if (action === 'price-candidate-stats') {
    const { country, state } = cleanScope(body);
    const counts = {};
    for (const st of ['needs_review', 'approved', 'rejected']) {
      const { count } = await supabase
        .from('clinic_price_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('status', st);
      counts[st] = count || 0;
    }
    let q = supabase.from('crawl_price_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (country) q = q.eq('country', country);
    if (state) q = q.contains('states', [state]);
    const { count: queueLeft } = await q;
    return { statusCode: 200, headers, body: JSON.stringify({ counts, queue_pending: queueLeft || 0 }) };
  }

  if (action === 'list-price-candidates') {
    const status = body.status || 'needs_review';
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 500);
    const { country, state } = cleanScope(body);

    // Read more than asked for when a country is given, because the country
    // lives on the clinic and is only known after the second query.
    const { data: cands, error } = await supabase
      .from('clinic_price_candidates')
      .select('*')
      .eq('status', status)
      .order('host', { ascending: true })
      .order('toxin', { ascending: true })
      .limit(country ? 2000 : limit);
    if (error) {
      console.error('list-price-candidates error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    const ids = [...new Set((cands || []).map(c => String(c.clinic_id)))];
    const byId = {};
    try {
      (await selectInChunks('clinics', 'id, name, region, province, state, country', 'id', ids))
        .forEach(c => { byId[String(c.id)] = c; });
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'clinic lookup failed: ' + e.message }) };
    }

    const out = (cands || [])
      .filter(c => {
        const k = byId[String(c.clinic_id)];
        if (country && (!k || String(k.country || '').toLowerCase() !== country)) return false;
        if (state && (!k || String(k.state || '').toLowerCase() !== state)) return false;
        return true;
      })
      .slice(0, limit)
      .map(c => {
        const k = byId[String(c.clinic_id)] || {};
        const place = k.country === 'usa' ? (k.state || '').replace(/-/g, ' ') : (k.province || k.region || '');
        return Object.assign({}, c, {
          clinic_name: k.name || ('Clinic ' + c.clinic_id),
          clinic_region: place || null
        });
      });

    return { statusCode: 200, headers, body: JSON.stringify({ candidates: out }) };
  }

  if (action === 'approve-price-candidates') {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id or ids required' }) };

    const nowIso = new Date().toISOString();
    let approved = 0, alreadyPriced = 0;
    const touched = new Set();
    const errors = [];

    for (const id of ids) {
      const { data: cand } = await supabase.from('clinic_price_candidates').select('*').eq('id', id).maybeSingle();
      if (!cand) { errors.push('candidate ' + id + ' not found'); continue; }

      // A price the clinic gave us, or entered itself, outranks a web page.
      const { data: existing } = await supabase
        .from('clinic_prices').select('id')
        .eq('clinic_id', String(cand.clinic_id)).eq('toxin', cand.toxin).limit(1);
      if (existing && existing.length) {
        await supabase.from('clinic_price_candidates')
          .update({ status: 'rejected', reviewed_at: nowIso, note: 'clinic already has a ' + cand.toxin + ' price' })
          .eq('id', id);
        alreadyPriced++;
        continue;
      }

      // Dated to the day the page was READ, not the day it was approved.
      const priceDate = (cand.crawled_at || nowIso).split('T')[0];
      const { error: insErr } = await supabase.from('clinic_prices').upsert({
        clinic_id:     String(cand.clinic_id),
        toxin:         cand.toxin,
        price:         cand.price,
        injector_type: '',
        currency:      cand.currency || 'CAD',
        price_source:  'website',
        price_date:    priceDate,
        updated_at:    nowIso
      }, { onConflict: 'clinic_id,toxin,injector_type' });
      if (insErr) { console.error('approve-price-candidate insert error:', insErr); errors.push(insErr.message); continue; }

      await supabase.from('clinic_price_candidates').update({ status: 'approved', reviewed_at: nowIso }).eq('id', id);
      touched.add(String(cand.clinic_id));
      approved++;
    }

    // One clinics write per clinic, after all its prices are in: clinics
    // carries the approve-clinic trigger.
    for (const clinicId of touched) await syncClinicLowestPrice(clinicId);

    return { statusCode: 200, headers, body: JSON.stringify({
      success: errors.length === 0, approved, already_priced: alreadyPriced, clinics_synced: touched.size, errors
    }) };
  }

  if (action === 'reject-price-candidates') {
    const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
    if (!ids.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id or ids required' }) };
    for (let i = 0; i < ids.length; i += 60) {
      const { error } = await supabase.from('clinic_price_candidates')
        .update({ status: 'rejected', reviewed_at: new Date().toISOString(), note: body.note || null })
        .in('id', ids.slice(i, i + 60));
      if (error) {
        console.error('reject-price-candidates error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, rejected: ids.length }) };
  }

  // == UNKNOWN ACTION =========================================================
  // add-clinic and manual price entry remain .ca only.
  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({ error: "Invalid action. Supported: list, approve, reject, revoke, list-flagged-votes, review-vote, review-votes-bulk, list-pending-clinics, approve-clinic, reject-clinic, price-candidate-stats, list-price-candidates, approve-price-candidates, reject-price-candidates." })
  };
};

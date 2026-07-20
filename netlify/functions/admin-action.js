// netlify/functions/admin-action.js  (skinday.com global admin)
//
// TRIMMED build for the .com global admin: vote moderation ONLY.
// The full .ca admin-action.js also handles directory operations (claims,
// prices, add-clinic). The .com global admin is deliberately scoped to
// Visualize cost/generation data plus vote moderation, and must NOT be able to
// perform directory operations, so those actions are intentionally absent here.
// (skinday.com and skinday.ca share one Supabase database, so these three
// actions operate on the same clinic_visits rows either admin would see.)
//
// Actions:
//   list-flagged-votes   -> { votes: [ ...enriched ] }
//   review-vote          { visit_id, decision:'approve'|'remove' } -> { success }
//   review-votes-bulk    { visit_ids:[...], decision } -> { success, count }
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
  // New clinics land as approval_status='pending' (DB default). This queue lets
  // an operator approve (grant portal access) or reject. Enriched with the
  // owner's email so the reviewer knows who signed up.
  if (action === 'list-pending-clinics') {
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, city, country, created_at')
      .eq('approval_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) {
      console.error('list-pending-clinics error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list pending clinics' }) };
    }
    const rows = clinics || [];
    const ids = rows.map(r => String(r.id));
    const ownerByClinic = {};
    if (ids.length) {
      const { data: mems } = await supabase
        .from('clinic_memberships')
        .select('clinic_id, user_id')
        .in('clinic_id', ids)
        .eq('role', 'owner')
        .eq('status', 'active')
        .is('revoked_at', null);
      for (const m of (mems || [])) {
        const cid = String(m.clinic_id);
        if (ownerByClinic[cid]) continue;
        try {
          const { data: u } = await supabase.auth.admin.getUserById(m.user_id);
          ownerByClinic[cid] = (u && u.user && u.user.email) || null;
        } catch (e) { /* leave email null */ }
      }
    }
    const out = rows.map(r => ({
      id: String(r.id),
      name: r.name,
      city: r.city,
      country: r.country,
      created_at: r.created_at,
      owner_email: ownerByClinic[String(r.id)] || null
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ clinics: out }) };
  }

  // == APPROVE CLINIC =========================================================
  if (action === 'approve-clinic') {
    const { clinic_id } = body;
    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }
    const { error } = await supabase
      .from('clinics')
      .update({ approval_status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', String(clinic_id));
    if (error) {
      console.error('approve-clinic error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve clinic' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, clinic_id: String(clinic_id) }) };
  }

  // == REJECT CLINIC ==========================================================
  if (action === 'reject-clinic') {
    const { clinic_id } = body;
    if (!clinic_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'clinic_id required' }) };
    }
    const { error } = await supabase
      .from('clinics')
      .update({ approval_status: 'rejected' })
      .eq('id', String(clinic_id));
    if (error) {
      console.error('reject-clinic error:', error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject clinic' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, clinic_id: String(clinic_id) }) };
  }

  // == UNKNOWN ACTION ───────────────────────────────────────────────────────────
  // Directory actions (approve/reject claims, prices, add-clinic) are
  // intentionally not available on the .com global admin.
  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({ error: "Invalid action. Supported: list-flagged-votes, review-vote, review-votes-bulk, list-pending-clinics, approve-clinic, reject-clinic." })
  };
};

// ============================================================================
// SkinDay Market Intelligence — dashboard API  (M41 → M19-US, 2026-08-02)
// ----------------------------------------------------------------------------
// Read-only apart from the saved list. Server-side service role so the data
// (the national competitive map — the moat) never leaves as an anon key a
// browser could dump. Every action calls a mi_* RPC and returns shaped rows.
//
// MULTI-TENANT, WITH ROLES. Nothing about a customer lives in this file. The
// x-mi-secret header resolves to a USER in mi_users, which yields the tenant
// (display name, branding, and the OWNER PREDICATE: owner_type
// 'manufacturer'|'distributor' plus owner_name), the ROLE and the TERRITORY.
// A distributor tenant's installed base is defined by distributor_ca, not by
// manufacturer, which no amount of p_manufacturer could express.
//
// ⭐⭐ MULTI-COUNTRY. The tenant also carries a COUNTRY, and every data RPC now
// takes p_country (defaulting to 'canada', so skinday.ca is unaffected). The
// country is a property of the TENANT, never of the filename or a dropdown —
// Cynosure-California and Cynosure-Ontario are two tenants over one database.
//
// ⚠️ THE TERRITORY AXIS RESOLVES INSIDE THE RPCs, NOT HERE. p_province means
// `province` in Canada and `state` in the US; p_city means `city` in Canada and
// `metro` in the US. The page keeps calling it "province" and the SQL decides.
//
// ⛔ distributor_ca IS CANADA-ONLY. A DISTRIBUTOR tenant on a US country will
// return an empty installed base. Manufacturer tenants are unaffected, which is
// why the California pilot works today and a US distributor seat does not.
//
// Two rules enforced here rather than in the browser, because a dropdown is
// not a permission: a user with a province is LOCKED to it whatever the page
// asks for, and only role='admin' may write settings.
//
// Resolution order, so nobody is locked out mid-pilot:
//   mi_users -> mi_tenants (treated as admin) -> MI_SECRET env var.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MI_SECRET (fallback only)
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-mi-secret'
  };
}
function json(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ 'content-type': 'application/json' }, cors()),
    body: JSON.stringify(body)
  };
}

// null out empty strings so the RPCs treat "" the same as "all"
function nz(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// The fallback tenant, used only when MI_SECRET matches and mi_tenants has no
// row for it. Deliberately the ONLY place a customer name appears in code.
//
// ⚠️ ITS COUNTRY IS ENV-DRIVEN. On skinday.com this file serves a US tenant, and
// a fallback hardcoded to 'canada' would quietly show Canadian numbers under a
// California banner — the exact failure the whole p_country migration exists to
// prevent. Set MI_FALLBACK_COUNTRY=usa on the .com site. This is a TESTING
// convenience only: a real tenant row in mi_tenants carries its own country.
const FALLBACK_TENANT = {
  tenant_id: null,
  user_id: null,
  slug: 'cynosure',
  display_name: 'Cynosure Lutronic',
  owner_type: 'manufacturer',
  owner_name: 'Cynosure Lutronic',
  accent_hex: '#147D74',
  logo_url: null,
  user_name: 'Pilot access',
  role: 'admin',
  province: process.env.MI_FALLBACK_PROVINCE || null,
  territories: null,
  country: (process.env.MI_FALLBACK_COUNTRY || 'canada').toLowerCase()
};

async function rpcRow(supabase, fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (!error && Array.isArray(data) && data.length) return data[0];
  } catch (e) { /* fall through to the next resolution step */ }
  return null;
}

async function resolveIdentity(supabase, secret) {
  if (!secret) return null;

  // A real sign-in. The browser keeps sending the session token in the same
  // header, so every action below is unchanged by the move to passwords.
  const asSession = await rpcRow(supabase, 'mi_session_identity', { p_session: secret });
  if (asSession) return asSession;

  // Legacy per-user access codes, still honoured so nobody is locked out.
  const asUser = await rpcRow(supabase, 'mi_user_by_secret', { p_secret: secret });
  if (asUser) return asUser;

  // a tenant-level code is an admin with no territory limit
  const asTenant = await rpcRow(supabase, 'mi_tenant_by_secret', { p_secret: secret });
  if (asTenant) {
    return Object.assign({}, asTenant, {
      user_id: null, user_name: 'Admin', role: 'admin', province: null
    });
  }

  if (process.env.MI_SECRET && secret === process.env.MI_SECRET) return FALLBACK_TENANT;
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'bad json' }); }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  // ---- public actions ---------------------------------------------------------
  // Signing in and accepting an invitation necessarily happen before there is
  // an identity to check, so they sit ahead of the gate.
  // The signup page needs this BEFORE anyone has an identity, so it sits with
  // login and accept_invite ahead of the gate. It exposes only manufacturer and
  // distributor names we already hold devices for, which is public information
  // and is exactly the vocabulary owner_name has to match.
  if (body.action === 'companies') {
    const { data, error } = await supabase.rpc('mi_companies');
    if (error) return json(500, { error: 'query failed', detail: error.message });
    return json(200, { companies: data || [] });
  }

  if (body.action === 'login') {
    const { data, error } = await supabase.rpc('mi_login', {
      p_email: String(body.email || '').trim(),
      p_password: String(body.password || '')
    });
    if (error) return json(500, { error: 'query failed', detail: error.message });
    if (!data || data.ok !== true) return json(401, { error: 'Email or password is incorrect.' });
    return json(200, { session: data.session });
  }
  // ---- PASSWORD RESET (pre-gate: someone locked out has no session) ----------
  // ⚠️ MI CANNOT REUSE THE CLINIC PORTAL'S RESET. That portal runs on Supabase
  // Auth (sb.auth.resetPasswordForEmail); MI has its own users, its own login
  // RPC and its own hashing, so Supabase Auth has no password here to reset.
  // This mirrors the INVITE flow instead, which already works the same shape:
  // single-use token, short expiry, emailed to the address on file.
  if (body.action === 'request_reset') {
    const { data, error } = await supabase.rpc('mi_request_reset', {
      p_email: String(body.email || '').trim()
    });
    if (error) return json(500, { error: 'query failed', detail: error.message });

    // Email is best-effort, and the RESPONSE IS IDENTICAL either way. Telling an
    // anonymous caller whether an address exists turns this endpoint into a way
    // to enumerate which emails hold a paid seat.
    try {
      const KEY = process.env.MI_RESEND_API_KEY || process.env.RESEND_API_KEY;
      if (KEY && data && data.token && data.email) {
        // ⭐ Derived from the REQUEST, not a constant. The dashboard is served
        // from the same host that handles this call, so the link is always
        // right — including on branch deploys — with no env var to set or
        // forget. MI_BASE_URL still wins if it is ever set explicitly.
        const proto = event.headers['x-forwarded-proto'] || 'https';
        const host  = event.headers.host || 'skinday.com';
        const base  = process.env.MI_BASE_URL || (proto + '://' + host);
        // ⭐ HASH, not a query param — matching the invitation link. A token in
        // the query string ends up in server logs, referrer headers and browser
        // history; a hash is never sent to the server at all.
        const link = base + '/mi-dashboard#r=' + encodeURIComponent(data.token);
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: process.env.MI_FROM_EMAIL || 'SkinDay <hello@skinday.ca>',
            to: [data.email],
            subject: 'Reset your SkinDay Market Intelligence password',
            text: [
              'Someone asked to reset the password for this account.',
              '',
              'Open this link to choose a new one. It works once and expires in an hour:',
              link,
              '',
              'If it was not you, ignore this email — nothing has changed and your',
              'current password still works.'
            ].join('\n')
          })
        });
      }
    } catch (e) { /* never reveal a mail failure to an anonymous caller */ }

    return json(200, { ok: true });
  }
  if (body.action === 'reset_password') {
    const { data, error } = await supabase.rpc('mi_reset_password', {
      p_token: String(body.token || ''),
      p_new: String(body.new_password || '')
    });
    if (error) return json(500, { error: 'query failed', detail: error.message });
    if (!data || data.ok !== true) return json(400, { error: (data && data.error) || 'That link is no longer valid.' });
    // Deliberately NOT signed in automatically: every session was just dropped,
    // and making them type the new password once confirms they know it.
    return json(200, { ok: true });
  }
  if (body.action === 'invite_status') {
    const { data, error } = await supabase.rpc('mi_invite_status', {
      p_token: String(body.token || '')
    });
    if (error) return json(500, { error: 'query failed', detail: error.message });
    const row = Array.isArray(data) && data.length ? data[0] : null;
    return json(200, { invite: row && row.valid ? row : null });
  }
  if (body.action === 'accept_invite') {
    const { data, error } = await supabase.rpc('mi_accept_invite', {
      p_token: String(body.token || ''),
      p_password: String(body.password || '')
    });
    if (error) return json(400, { error: error.message });
    // sign them straight in rather than making them type it again
    const { data: li } = await supabase.rpc('mi_login', {
      p_email: String(body.email || '').trim(),
      p_password: String(body.password || '')
    });
    return json(200, { ok: true, session: (li && li.session) || null, result: data });
  }

  // ---- gate + identity -------------------------------------------------------
  const secret = event.headers['x-mi-secret'] || event.headers['X-Mi-Secret'];
  const me = await resolveIdentity(supabase, secret);
  if (!me) return json(401, { error: 'unauthorized' });

  const owner = { p_owner_type: me.owner_type, p_owner_name: me.owner_name };
  const scope = { p_tenant_id: me.tenant_id, p_user_id: me.user_id };
  // ⭐ Trial state is read from mi_tenants rather than the identity RPC, which
  // predates these columns. One indexed lookup by id; cheap enough to do on
  // every call and it keeps the countdown honest if the date is changed while
  // someone is signed in.
  let trial = null;
  // ⭐⭐ MULTI-COUNTRY, WITHOUT MAKING A DROPDOWN INTO A PERMISSION.
  // The standing rule is that country is a property of the TENANT so a browser
  // cannot ask for another country's data by editing a payload. That rule
  // holds: `countries` on mi_tenants is an ALLOW-LIST, the request may only
  // CHOOSE from it, and anything outside it falls back to the tenant's own
  // country. NULL/empty means single-country, so every existing tenant is
  // unaffected by this code existing.
  let allowedCountries = null;
  if (me.tenant_id) {
    const { data: t } = await supabase.from('mi_tenants')
      .select('plan, sub_status, trial_ends_at, seat_limit, countries')
      .eq('id', me.tenant_id).maybeSingle();
    // ⭐ THE COUNTRY ALLOW-LIST. Read here so it costs no extra query.
    if (t && Array.isArray(t.countries) && t.countries.length) {
      allowedCountries = t.countries.map(c => String(c).toLowerCase());
    }
    if (t && t.trial_ends_at) {
      const ms = new Date(t.trial_ends_at).getTime() - Date.now();
      trial = {
        plan: t.plan || null,
        status: t.sub_status || null,
        ends_at: t.trial_ends_at,
        // Round UP: with 6 hours left a rep should read "1 day", not "0".
        days_left: Math.max(0, Math.ceil(ms / 86400000)),
        expired: ms <= 0
      };
    }
  }

  const brand = {
    trial: trial,
    display_name: me.display_name,
    accent_hex: me.accent_hex,
    logo_url: me.logo_url || null,
    owner_type: me.owner_type,
    user_name: me.user_name,
    user_id: me.user_id || null,
    email: me.email || null,
    role: me.role,
    province: me.province || null,
    territories: me.territories || null,
    country: (me.country || 'canada').toLowerCase(),
    // The page renders a switcher only when this holds more than one.
    countries: allowedCountries && allowedCountries.length > 1 ? allowedCountries : null
  };
  const isAdmin = me.role === 'admin';

  const action = body.action;
  // a locked territory is enforced here, not offered as a choice in the page
  // ⭐ TERRITORY IS A LIST, NOT A VALUE. A rep can cover CA+NV+AZ, or ON+QC.
  // `province` is kept as the single-value wire name so skinday.ca is unchanged;
  // `regions` is the array the RPCs actually filter on. A locked territory is
  // enforced HERE, not offered as a choice in the page.
  const lockedRegions = Array.isArray(me.territories) && me.territories.length
    ? me.territories
    : (me.province ? [me.province] : null);
  const province = lockedRegions ? lockedRegions[0] : nz(body.province);
  const askedRegion = nz(body.province);
  const regions = lockedRegions
    ? lockedRegions
    : (askedRegion ? [askedRegion] : null);
  const inRegions = { p_regions: regions };
  // ⭐ COUNTRY IS STILL NEVER TAKEN FROM THE REQUEST UNVALIDATED. A tenant with
  // an allow-list may CHOOSE from it; anyone else, and any value outside the
  // list, gets the tenant's own country. The check is here and not in the page.
  const homeCountry = (me.country || 'canada').toLowerCase();
  const askedCountry = String(body.country || '').trim().toLowerCase();
  const country = (allowedCountries && askedCountry && allowedCountries.includes(askedCountry))
    ? askedCountry
    : homeCountry;
  const inCountry = { p_country: country, p_regions: regions };
  const city = nz(body.city);
  const neighbourhood = nz(body.neighbourhood);
  const category = nz(body.category);

  try {
    switch (action) {

      // who am I — lets the page set its badge and accent before anything loads
      case 'tenant':
        return json(200, { tenant: brand });

      // geography drill-down options: no args -> provinces; province -> neighbourhoods
      case 'geo': {
        const { data, error } = await supabase.rpc('mi_geo', { p_country: country, p_regions: regions, 
          p_province: province, p_city: city
        });
        if (error) throw error;
        return json(200, { geo: data || [] });
      }

      // ⭐ p_city / p_neighbourhood added 2026-08-06. This was the ONLY rpc in
      // this file not given the drill-down, so coverage stayed territory-wide
      // while every other number followed the selection. The dashboard
      // subtracts mi_kpis.with_ours from coverage.verified, so a metro
      // selection produced a state figure minus a metro figure.
      case 'coverage': {
        const { data, error } = await supabase.rpc('mi_coverage', { p_country: country, p_regions: regions,  p_province: province, p_city: city, p_neighbourhood: neighbourhood });
        if (error) throw error;
        return json(200, { coverage: data });
      }

      case 'kpis': {
        const { data, error } = await supabase.rpc('mi_kpis', Object.assign({ p_country: country, p_regions: regions, 
          p_province: province, p_city: city, p_neighbourhood: neighbourhood
        }, owner));
        if (error) throw error;
        return json(200, { kpis: data });
      }

      case 'categories': {
        const { data, error } = await supabase.rpc('mi_categories', Object.assign({ p_country: country, p_regions: regions, 
          p_province: province, p_city: city, p_neighbourhood: neighbourhood
        }, owner));
        if (error) throw error;
        return json(200, { categories: data || [] });
      }

      // top N manufacturers by penetration in the selected geography. The same
      // field for every tenant: a rep sells against machines, not channels.
      case 'leaderboard': {
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 3, 1), 20);
        const { data, error } = await supabase.rpc('mi_leaderboard', Object.assign({ p_country: country, p_regions: regions, 
          p_province: province, p_neighbourhood: neighbourhood, p_limit: limit
        }, owner));
        if (error) throw error;
        return json(200, { leaderboard: data || [] });
      }

      // Per-category competitive field, as SHARE OF IDENTIFIED INSTALLATIONS.
      // ⚠️ This is a DIFFERENT metric from `leaderboard`, which is share of
      // CLINICS and overlaps (one clinic owning two makers counts in both, so
      // those percentages do not sum to 100 and must never be drawn as a pie).
      // Here each device row belongs to exactly one maker, so the slices are
      // mutually exclusive, sum to 100, and "Other" is real rather than a plug.
      // The two can never be reconciled and must not sit under one heading.
      case 'category_share': {
        const top = Math.min(Math.max(parseInt(body.top, 10) || 4, 2), 8);
        const { data, error } = await supabase.rpc('mi_category_share', Object.assign({ p_country: country, p_regions: regions, 
          p_province: province, p_neighbourhood: neighbourhood, p_top: top
        }, owner));
        if (error) throw error;
        return json(200, { category_share: data || [] });
      }

      // manufacturer + distributor option lists for the Accounts filters,
      // each with a clinic count, energy devices only
      case 'filter_options': {
        // ⭐ p_category added 2026-08-27. Without it the device and manufacturer
        // dropdowns showed the whole national list even with a category
        // selected, so "RF Skin Tightening" still offered CoolSculpting and
        // Fraxel. Null when no category is chosen, which is the old behaviour.
        const { data, error } = await supabase.rpc('mi_filter_options', { p_country: country, p_regions: regions, 
          p_province: province, p_neighbourhood: neighbourhood, p_city: city,
          p_category: category,
          // Narrow the DEVICE list only. The manufacturer and distributor lists
          // stay category-wide so the rep can always change their mind.
          p_manufacturer: nz(body.filter_manufacturer),
          p_distributor: nz(body.filter_distributor)
        });
        if (error) throw error;
        return json(200, { options: data || { manufacturers: [], distributors: [], devices: [] } });
      }

      // the filterable clinic list.
      // segment: ours | competitor | greenfield | research
      case 'accounts': {
        const segment = nz(body.segment);
        // ⭐ Ceiling 500 -> 20000 (2026-08-27). Measured: all 6,999 Canadian
        // accounts return in 446ms and 7.6MB. The old cap made a rep's list
        // silently partial; the client now renders in pages instead.
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 20000);
        const { data, error } = await supabase.rpc('mi_accounts', Object.assign({ p_country: country, p_regions: regions, 
          p_province: province, p_city: city, p_neighbourhood: neighbourhood,
          p_category: category, p_segment: segment, p_limit: limit,
          p_filter_manufacturer: nz(body.filter_manufacturer),
          p_filter_distributor: nz(body.filter_distributor),
          // Field-rep filters. All optional on the SQL side, so an older client
          // that sends none of them behaves exactly as before.
          p_exclude_manufacturer: nz(body.exclude_manufacturer),
          p_device: nz(body.device),
          p_min_reviews: body.min_reviews ? parseInt(body.min_reviews, 10) : null,
          p_sort: nz(body.sort) || 'reviews',
          // Only trusted as a pair. A lone coordinate would silently produce a
          // distance from the prime meridian rather than an error.
          p_near_lat: (body.near_lat != null && body.near_lng != null) ? Number(body.near_lat) : null,
          p_near_lng: (body.near_lat != null && body.near_lng != null) ? Number(body.near_lng) : null
        }, owner));
        if (error) throw error;
        return json(200, { accounts: data || [] });
      }

      // ⭐ Counts beside each option in the segment dropdown. Its own action so
      // it can be re-fetched when the category changes without re-running the
      // 500-row accounts query.
      case 'segment_counts': {
        const { data, error } = await supabase.rpc('mi_segment_counts', Object.assign({
          p_country: country, p_regions: regions, p_province: province,
          p_city: city, p_neighbourhood: neighbourhood, p_category: category
        }, owner));
        if (error) throw error;
        return json(200, { counts: data || {} });
      }

      // ⭐ Count behind the "+234" badge on the Accounts tab. Its own action so
      // the badge does not have to run the 500-row accounts query. Same 60-day
      // rule and same geography arguments as the 'new' segment in mi_accounts,
      // so the number on the tab always equals the rows behind it.
      case 'new_count': {
        const { data, error } = await supabase.rpc('mi_new_count', {
          p_country: country, p_regions: regions,
          p_province: province, p_city: city, p_neighbourhood: neighbourhood
        });
        if (error) throw error;
        return json(200, { count: Number(data) || 0 });
      }

      // one call for everything above the fold, so a geography change is a
      // single request instead of four
      case 'overview': {
        const [k, c, g, l, cov, cs] = await Promise.all([
          supabase.rpc('mi_kpis', Object.assign({ p_country: country, p_regions: regions, 
            p_province: province, p_city: city, p_neighbourhood: neighbourhood
          }, owner)),
          supabase.rpc('mi_categories', Object.assign({ p_country: country, p_regions: regions, 
            p_province: province, p_city: city, p_neighbourhood: neighbourhood
          }, owner)),
          supabase.rpc('mi_geo', { p_country: country, p_regions: regions,  p_province: province, p_city: city }),
          supabase.rpc('mi_leaderboard', Object.assign({ p_country: country, p_regions: regions, 
            p_province: province, p_neighbourhood: neighbourhood, p_limit: 3
          }, owner)),
          supabase.rpc('mi_coverage', { p_country: country, p_regions: regions,  p_province: province, p_city: city, p_neighbourhood: neighbourhood }),
          supabase.rpc('mi_category_share', Object.assign({ p_country: country, p_regions: regions, 
            p_province: province, p_neighbourhood: neighbourhood, p_top: 4
          }, owner))
        ]);
        if (k.error) throw k.error;
        if (c.error) throw c.error;
        if (g.error) throw g.error;
        if (l.error) throw l.error;
        return json(200, {
          tenant: brand,
          kpis: k.data,
          categories: c.data || [],
          geo: g.data || [],
          leaderboard: l.data || [],
          coverage: cov.error ? null : cov.data,
          // tolerated like coverage: a missing donut should not blank the page
          category_share: cs.error ? [] : (cs.data || [])
        });
      }

      // the tenant's own installed base, their taxonomy
      case 'feed': {
        const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
        const { data, error } = await supabase.rpc('mi_feed', {
          p_country: country, p_regions: regions,
          p_province: province, p_city: city, p_neighbourhood: neighbourhood,
          p_days: days,
          p_limit: Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 300),
          p_national: !!body.national
        });
        if (error) throw error;
        return json(200, { feed: data || {} });
      }

      // Rep corrections. Written to a QUEUE, never applied. One manufacturer's
      // rep must not be able to edit a database a competing manufacturer reads,
      // so a flag is a message to Andy and nothing more.
      case 'flag': {
        const KINDS = ['missing_device','wrong_device','device_removed',
                       'wrong_info','clinic_closed','other'];
        const kind = KINDS.includes(body.kind) ? body.kind : null;
        if (!kind || !body.clinic_id) return json(400, { error: 'clinic_id and a valid kind are required' });
        const { error } = await supabase.from('clinic_flags').insert({
          clinic_id: String(body.clinic_id),
          device_id: body.device_id ? parseInt(body.device_id, 10) : null,
          tenant_id: me.tenant_id || null,
          user_email: me.email || null,
          kind: kind,
          note: (body.note || '').toString().slice(0, 1000) || null
        });
        if (error) throw error;

        // ⚠️ A correction loop nobody reads is not a loop. The flag is stored
        // either way; the email is what makes it arrive. It is deliberately
        // best-effort: a mail failure must not lose the rep's report or make the
        // button look broken to them.
        try {
          const KEY = process.env.MI_RESEND_API_KEY || process.env.RESEND_API_KEY;
          const to = process.env.MI_FLAGS_EMAIL || 'hello@skinday.ca';
          if (KEY) {
            // Names rather than ids, so the email is actionable without a query.
            const { data: c } = await supabase.from('clinics')
              .select('name, neighbourhood, province, state, website')
              .eq('id', String(body.clinic_id)).maybeSingle();
            let device = null;
            if (body.device_id) {
              const { data: d } = await supabase.from('device_reference')
                .select('model, manufacturer').eq('id', parseInt(body.device_id, 10)).maybeSingle();
              device = d;
            }
            const label = {
              missing_device: 'A device is missing',
              wrong_device: 'A device listed is wrong',
              device_removed: 'They no longer have a device',
              wrong_info: 'Contact or clinic details are wrong',
              clinic_closed: 'This clinic has closed',
              other: 'Something else'
            }[kind] || kind;
            const lines = [
              label,
              '',
              'Clinic: ' + ((c && c.name) || body.clinic_id) +
                (c && c.neighbourhood ? ' (' + c.neighbourhood + ')' : ''),
              device ? 'Device: ' + device.model + ' (' + device.manufacturer + ')' : null,
              c && c.website ? 'Website: ' + c.website : null,
              body.note ? 'Note: ' + body.note : null,
              '',
              'Reported by: ' + (me.email || 'unknown') + ' at ' + (me.display_name || 'tenant ' + me.tenant_id),
              '',
              'clinic_id: ' + body.clinic_id
            ].filter(function (x) { return x !== null; }).join('\n');

            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: process.env.MI_FROM_EMAIL || 'SkinDay <hello@skinday.ca>',
                to: [to],
                reply_to: me.email || undefined,
                subject: 'Data flag: ' + ((c && c.name) || body.clinic_id),
                text: lines
              })
            });
          }
        } catch (e) { /* the flag is saved; a mail failure is not the rep's problem */ }

        return json(200, { ok: true });
      }

      case 'portfolio': {
        // p_tenant_id scopes the FOCUS flag. mi_focus_devices is keyed on
        // manufacturer, and two tenants can share an owner_name (Cynosure
        // Canada and Cynosure US do), so without this each sees the other's
        // focus list and can overwrite it.
        const { data, error } = await supabase.rpc('mi_portfolio', Object.assign({ p_country: country, p_regions: regions,
          p_province: province, p_neighbourhood: neighbourhood,
          p_tenant_id: me.tenant_id || null
        }, owner));
        if (error) throw error;
        return json(200, { portfolio: data || [] });
      }

      // ---- My List (shared saved accounts + notes, per tenant) ----
      case 'save_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_save_account', Object.assign({
          p_clinic_id: String(body.clinic_id), p_note: nz(body.note)
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'set_note': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_set_note', Object.assign({
          p_clinic_id: String(body.clinic_id), p_note: body.note == null ? '' : String(body.note),
          p_role: me.role
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'remove_account': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_remove_account', Object.assign({
          p_clinic_id: String(body.clinic_id),
          p_role: me.role
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }
      case 'list_saved': {
        // Geography applies here too: a director filtering to their region
        // expects My List to follow, not to show every rep's whole country.
        const { data, error } = await supabase.rpc('mi_list_saved', Object.assign({ p_country: country, p_regions: regions, 
          p_role: me.role,
          p_province: province,
          p_neighbourhood: neighbourhood
        }, scope, owner));
        if (error) throw error;
        return json(200, { saved: data || [] });
      }

      // ---- Comments: the shared layer over someone else's private note ----
      case 'add_comment': {
        if (!body.clinic_id) return json(400, { error: 'clinic_id required' });
        const { data, error } = await supabase.rpc('mi_add_comment', Object.assign({
          p_clinic_id: String(body.clinic_id),
          p_body: String(body.body || ''),
          p_author: me.user_name || 'Admin'
        }, scope));
        if (error) return json(400, { error: error.message });
        return json(200, { result: data });
      }
      case 'delete_comment': {
        if (!body.comment_id) return json(400, { error: 'comment_id required' });
        // Admins moderate the whole board; everyone else only their own.
        const { data, error } = await supabase.rpc('mi_delete_comment', Object.assign({
          p_comment_id: parseInt(body.comment_id, 10),
          p_role: me.role
        }, scope));
        if (error) throw error;
        return json(200, { result: data });
      }

      // ---- Your account (any signed-in user) ----
      case 'logout': {
        await supabase.rpc('mi_logout', { p_session: secret });
        return json(200, { ok: true });
      }
      case 'set_own_name': {
        if (!me.user_id) return json(400, { error: 'no personal account to edit' });
        const { data, error } = await supabase.rpc('mi_set_own_name', {
          p_user_id: me.user_id, p_name: String(body.name || '')
        });
        if (error) return json(400, { error: error.message });
        return json(200, { result: data });
      }
      case 'set_password': {
        if (!me.user_id) return json(400, { error: 'no personal account to edit' });
        const { data, error } = await supabase.rpc('mi_set_password', {
          p_user_id: me.user_id,
          p_current: String(body.current || ''),
          p_new: String(body.new_password || '')
        });
        if (error) return json(400, { error: error.message });
        // every session for this user was just invalidated, this one included
        return json(200, { result: data, signed_out: true });
      }

      // ---- Focus devices (admin only) ----
      case 'list_focus': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        const { data, error } = await supabase.rpc('mi_list_focus', { p_tenant_id: me.tenant_id });
        if (error) throw error;
        return json(200, { focus: data || [] });
      }
      case 'set_focus': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!nz(body.model)) return json(400, { error: 'model required' });
        const { data, error } = await supabase.rpc('mi_set_focus', {
          p_tenant_id: me.tenant_id,
          p_model: String(body.model),
          p_on: body.on === true
        });
        if (error) throw error;
        return json(200, { result: data });
      }

      // What plan this tenant is on, how many seats are used, and whether we can
      // hand them to Stripe to manage it themselves.
      case 'billing': {
        if (!me.tenant_id) return json(200, { billing: null });
        const { data: t, error: tErr } = await supabase
          .from('mi_tenants')
          .select('plan, seat_limit, sub_status, trial_ends_at, stripe_customer_id, stripe_subscription_id, country')
          .eq('id', me.tenant_id).maybeSingle();
        if (tErr) throw tErr;
        const { count } = await supabase.from('mi_users')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', me.tenant_id).eq('active', true);
        return json(200, { billing: Object.assign({}, t, {
          seats_used: count || 0,
          // ⚠️ TWO DIFFERENT QUESTIONS, and conflating them is what left a pilot
          // with no way to buy. can_manage = "Stripe knows this customer, so the
          // portal will open". has_subscription = "they are actually paying".
          // A tenant created by hand has neither; the Subscribe buttons key off
          // the second, and admin rights rather than the first.
          can_manage: !!(t && t.stripe_customer_id),
          has_subscription: !!(t && t.stripe_subscription_id)
        }) });
      }

      // Cancelling, changing card, and invoices all live in Stripe's own billing
      // portal. Building our own cancel button would mean reimplementing proration,
      // dunning and invoice history badly. One redirect instead.
      // ⭐⭐ CONVERTING AN EXISTING TENANT TO A PAID SUBSCRIPTION.
      // mi-checkout.js handles NEW signups and is deliberately unauthenticated,
      // so it must never take a tenant id from the body — anyone could attach a
      // subscription to somebody else's account and change their plan. Here the
      // caller is already identified and admin-checked, so the tenant is taken
      // from the SESSION and never from the request.
      //
      // This is the path a pilot takes at the end of its 30 days: the tenant
      // already exists with its saved accounts, notes and users, so the webhook
      // must ATTACH to it rather than mint a second one.
      case 'start_subscription': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!me.tenant_id) return json(400, { error: 'no account to subscribe' });

        const plan   = String(body.plan || '').toLowerCase();
        const period = String(body.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
        const SEATS  = { solo: 1, team: 5 };
        if (!SEATS[plan]) return json(400, { error: 'choose a plan' });

        const { data: t, error: tErr } = await supabase.from('mi_tenants')
          .select('id, display_name, owner_name, owner_type, country, stripe_customer_id, stripe_subscription_id')
          .eq('id', me.tenant_id).maybeSingle();
        if (tErr) throw tErr;
        if (!t) return json(400, { error: 'no account to subscribe' });
        // Already paying: the billing portal is where plan changes belong, and
        // a second checkout would create a second subscription on one tenant.
        if (t.stripe_subscription_id) {
          return json(400, { error: 'This account already has a subscription. Use Manage subscription to change it.' });
        }

        const priceId = process.env['MI_PRICE_' + plan.toUpperCase() + '_' + period.toUpperCase()];
        if (!priceId) return json(500, { error: 'that plan is not available yet' });
        const KEY = process.env.MI_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
        if (!KEY) return json(500, { error: 'billing is not configured' });
        const site = (process.env.SITE_URL || 'https://skinday.com').replace(/\/+$/, '');

        // ⚠️ NO TRIAL. mi-checkout gives new signups 14 days; a pilot has already
        // had its free period and would otherwise get another one.
        const form = new URLSearchParams({
          'mode': 'subscription',
          'line_items[0][price]': priceId,
          'line_items[0][quantity]': '1',
          'billing_address_collection': 'required',
          'automatic_tax[enabled]': 'true',
          'allow_promotion_codes': 'true',
          // BOTH of these are read by the webhook. client_reference_id is the
          // one Stripe surfaces most reliably; the metadata copy survives on the
          // subscription object when the session is not the event that lands.
          'client_reference_id': String(t.id),
          'metadata[mi_tenant_id]': String(t.id),
          'metadata[mi_plan]': plan,
          'metadata[mi_seats]': String(SEATS[plan]),
          'metadata[mi_company]': t.owner_name || t.display_name || '',
          'subscription_data[metadata][mi_tenant_id]': String(t.id),
          'subscription_data[metadata][mi_plan]': plan,
          'subscription_data[metadata][mi_seats]': String(SEATS[plan]),
          'subscription_data[metadata][mi_company]': t.owner_name || t.display_name || '',
          'success_url': site + '/mi-dashboard?subscribed=1',
          'cancel_url': site + '/mi-dashboard'
        });
        if (t.stripe_customer_id) form.set('customer', t.stripe_customer_id);
        else if (me.email) form.set('customer_email', me.email);

        const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        });
        const out = await res.json();
        if (!res.ok) return json(500, { error: 'could not start checkout', detail: (out.error && out.error.message) || '' });
        return json(200, { url: out.url });
      }

      case 'billing_portal': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!me.tenant_id) return json(400, { error: 'no subscription on this account' });
        const { data: t, error: tErr } = await supabase
          .from('mi_tenants').select('stripe_customer_id').eq('id', me.tenant_id).maybeSingle();
        if (tErr) throw tErr;
        if (!t || !t.stripe_customer_id) {
          return json(400, { error: 'This account has no card subscription. Email hello@skinday.ca and we will sort it out.' });
        }
        const KEY = process.env.MI_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
        if (!KEY) return json(500, { error: 'billing is not configured' });
        const site = (process.env.SITE_URL || 'https://skinday.com').replace(/\/+$/, '');
        // Plain fetch rather than the Stripe SDK: this file has no Stripe
        // dependency today and one form POST does not justify adding one.
        const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + KEY,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            customer: t.stripe_customer_id,
            return_url: site + '/mi-dashboard'
          }).toString()
        });
        const out = await res.json();
        if (!res.ok) {
          return json(500, { error: 'could not open billing', detail: (out.error && out.error.message) || '' });
        }
        return json(200, { url: out.url });
      }

      // ---- Team (admin only) ----
      case 'list_users': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        const { data, error } = await supabase.rpc('mi_list_users', { p_tenant_id: me.tenant_id });
        if (error) throw error;
        return json(200, { users: data || [] });
      }
      case 'invite_user': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!nz(body.name)) return json(400, { error: 'name required' });

        // ⛔ SEAT LIMIT. It is stored on the tenant by the Stripe webhook and,
        // until now, nothing looked at it: a Solo customer could invite ten
        // people and the Team plan had nothing behind it.
        //
        // Enforced HERE, at the invite, rather than at sign-in. Blocking an
        // existing user at sign-in because a plan changed would lock out someone
        // already working; refusing a NEW invite is the honest place to say no.
        if (me.tenant_id) {
          const { data: tRow, error: tErr } = await supabase
            .from('mi_tenants').select('seat_limit, plan').eq('id', me.tenant_id).maybeSingle();
          if (tErr) throw tErr;
          const limit = tRow && tRow.seat_limit;
          // A null limit means a tenant created before billing existed. Those
          // are left unlimited rather than silently locked out.
          if (limit) {
            const { count, error: cErr } = await supabase
              .from('mi_users')
              .select('id', { count: 'exact', head: true })
              .eq('tenant_id', me.tenant_id)
              .eq('active', true);
            if (cErr) throw cErr;
            if ((count || 0) >= limit) {
              return json(409, {
                error: 'Your plan includes ' + limit + ' seat' + (limit === 1 ? '' : 's') +
                       ', and ' + count + ' ' + (count === 1 ? 'is' : 'are') + ' in use. ' +
                       'Remove someone first, or email hello@skinday.ca to add seats.'
              });
            }
          }
        }

        const { data, error } = await supabase.rpc('mi_invite_user', {
          p_tenant_id: me.tenant_id,
          p_name: String(body.name).trim(),
          p_email: nz(body.email),
          p_role: nz(body.role) || 'rep',
          p_province: nz(body.province)
        });
        if (error) throw error;
        return json(200, { user: Array.isArray(data) && data.length ? data[0] : null });
      }
      case 'set_user_active': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!body.user_id) return json(400, { error: 'user_id required' });
        const { data, error } = await supabase.rpc('mi_set_user_active', {
          p_tenant_id: me.tenant_id,
          p_user_id: parseInt(body.user_id, 10),
          p_active: body.active === true
        });
        if (error) throw error;
        return json(200, { result: data });
      }

      // ---- Settings (admin only) ----
      case 'save_settings': {
        if (!isAdmin) return json(403, { error: 'admin only' });
        if (!me.slug) return json(400, { error: 'no tenant to update' });
        const { data, error } = await supabase.rpc('mi_set_tenant_branding', {
          p_slug: me.slug,
          p_display_name: nz(body.display_name),
          p_accent_hex: nz(body.accent_hex),
          p_logo_url: body.logo_url == null ? null : String(body.logo_url)
        });
        if (error) throw error;
        const row = Array.isArray(data) && data.length ? data[0] : null;
        return json(200, { tenant: row });
      }

      default:
        return json(400, { error: 'unknown action', got: action });
    }
  } catch (e) {
    return json(500, { error: 'query failed', detail: String(e.message || e) });
  }
};

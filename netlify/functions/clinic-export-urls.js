// netlify/functions/clinic-export-urls.js
//
// SkinDay M13. Turns a batch of a clinic's storage paths into signed URLs.
//
// This function never touches an image. It takes paths, checks that they belong
// to the caller's clinic, and hands back short-lived signed URLs. The browser
// fetches the bytes directly from storage and streams them into a ZIP on disk.
//
// That is the whole design, and it is deliberate. An export must not have a size
// at which it stops working. Pushing image bytes through a Lambda gives you a
// function that works beautifully on a clinic with nineteen cases and times out
// on the first clinic with two thousand, which is the one you least want to fail
// in front of. The blob sweep taught this lesson at 12:48 today.
//
// Env
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY

const { createClient } = require('@supabase/supabase-js');

const PRIVATE_BUCKET = 'clinic-cases-private';
const MAX_PATHS = 100;
const URL_TTL_SECONDS = 60 * 30;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json(500, {
      error: 'missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY'
    });
  }

  const authHeader =
    (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'missing bearer token' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { error: 'invalid json body' });
  }

  const clinicId = body.clinicId ? String(body.clinicId) : '';
  const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];

  if (!clinicId) return json(400, { error: 'clinicId is required' });
  if (paths.length === 0) return json(400, { error: 'paths is required' });
  if (paths.length > MAX_PATHS) {
    return json(400, { error: 'at most ' + MAX_PATHS + ' paths per request' });
  }

  // Membership, proved by the caller's own token against RLS. body.clinicId is a
  // claim the browser is making, and this is where it stops being taken on trust.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: member, error: memberErr } = await asUser
    .from('clinic_memberships')
    .select('clinic_id')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .is('revoked_at', null)
    .maybeSingle();

  if (memberErr) return json(500, { error: memberErr.message });
  if (!member) return json(403, { error: 'not an active member of clinic ' + clinicId });

  // Every private object lives under {clinic_id}/{case_id}/. Anything outside the
  // caller's own prefix is refused outright rather than signed and regretted.
  // Signing is done with service role, so this check is the only boundary there
  // is, and it has to be exact: a prefix test that accepted "386x/" for clinic
  // "386" would hand one clinic another clinic's patients.
  const prefix = clinicId + '/';
  const outside = paths.filter(function (p) {
    return !p.startsWith(prefix) || p.indexOf('..') !== -1;
  });
  if (outside.length > 0) {
    return json(403, {
      error: 'one or more paths do not belong to clinic ' + clinicId,
      offending: outside.slice(0, 5)
    });
  }

  const asService = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await asService.storage
    .from(PRIVATE_BUCKET)
    .createSignedUrls(paths, URL_TTL_SECONDS);

  if (error) return json(500, { error: 'signing failed: ' + error.message });

  const urls = {};
  const failed = [];
  for (const row of data || []) {
    if (row.error || !row.signedUrl) {
      failed.push({ path: row.path, error: row.error || 'no url returned' });
    } else {
      urls[row.path] = row.signedUrl;
    }
  }

  return json(200, {
    ok: true,
    expires_in: URL_TTL_SECONDS,
    urls,
    failed
  });
};

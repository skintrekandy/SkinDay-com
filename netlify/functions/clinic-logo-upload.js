// netlify/functions/clinic-logo-upload.js
//
// SkinDay M13. Uploads a clinic's logo.
//
// The bucket is clinic-logos, and that matters more than it looks.
//
// It is NOT clinic-cases-public. The reconcile mode of clinic-case-purge lists
// that bucket and deletes every object that no case row references by its
// published_before_path or published_after_path. A logo there would be deleted on
// the next sweep, silently, at four in the morning, and the clinic would find
// their gallery unbranded with nothing in any log explaining it.
//
// Public bucket, because the logo appears on the clinic's own gallery embed,
// which anonymous visitors load.
//
// Env
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ANON_KEY

const { createClient } = require('@supabase/supabase-js');

const LOGO_BUCKET = 'clinic-logos';
const MAX_BYTES = 2 * 1024 * 1024;

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

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('no image');
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error('logo must be a png, jpeg, webp or svg');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) throw new Error('that image is empty');
  if (buffer.length > MAX_BYTES) throw new Error('logo must be under 2MB');
  let type = m[1];
  if (type === 'image/jpg') type = 'image/jpeg';
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[type];
  return { buffer, type, ext };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    return json(500, { error: 'missing supabase env' });
  }

  const headers = event.headers || {};
  const jwt = (headers.authorization || headers.Authorization || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'missing bearer token' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { error: 'invalid json body' });
  }

  const clinicId = body.clinicId ? String(body.clinicId) : '';
  if (!clinicId) return json(400, { error: 'clinicId is required' });

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const asService = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Removing the logo is not a special case worth a second endpoint.
  if (body.remove === true) {
    const { data, error } = await asUser.rpc('set_clinic_logo', {
      p_clinic_id: clinicId,
      p_logo_url: null
    });
    if (error) return json(403, { error: error.message });
    return json(200, { ok: true, logo_url: null, result: data });
  }

  let img;
  try {
    img = decodeDataUrl(body.image);
  } catch (err) {
    return json(400, { error: err.message });
  }

  // Cache-busted by name, because a public URL for a fixed path is cached hard by
  // every CDN between here and the patient, and a clinic that swaps its logo and
  // still sees the old one will conclude the upload silently failed.
  const stamp = Date.now().toString(36);
  const path = clinicId + '/logo-' + stamp + '.' + img.ext;

  const up = await asService.storage.from(LOGO_BUCKET).upload(path, img.buffer, {
    contentType: img.type,
    upsert: false,
    cacheControl: '31536000'
  });
  if (up.error) return json(500, { error: 'upload failed: ' + up.error.message });

  const { data: pub } = asService.storage.from(LOGO_BUCKET).getPublicUrl(path);
  const logoUrl = pub && pub.publicUrl;
  if (!logoUrl) return json(500, { error: 'could not resolve the public url' });

  // The role gate lives in set_clinic_logo, called with the user's own token. If
  // they are not an owner or admin, this fails here, after the upload. The stray
  // object is 2KB in a bucket nothing else reads, which is a better failure than
  // checking permissions twice and having the two checks disagree one day.
  const { error: rpcErr } = await asUser.rpc('set_clinic_logo', {
    p_clinic_id: clinicId,
    p_logo_url: logoUrl
  });
  if (rpcErr) {
    try { await asService.storage.from(LOGO_BUCKET).remove([path]); } catch (e) {}
    return json(403, { error: rpcErr.message });
  }

  // The previous logo is now unreferenced. Sweep it, so a clinic that changes its
  // logo ten times does not leave ten of them in a public bucket.
  //
  // But ONLY files this function wrote. clinic-logos is a shared bucket: the
  // directory has been writing clinic listing logos into it since long before
  // this existed, and clinics.logo_url is the same column for both. A sweep that
  // deleted everything under the clinic's prefix except the file it just wrote
  // would silently destroy a directory logo the first time an owner uploaded one
  // here.
  //
  // That is exactly the clinic-cases-public mistake, in a different bucket, and
  // the fix is the same: never delete an object you did not create. The 'logo-'
  // prefix is the signature.
  try {
    const { data: existing } = await asService.storage.from(LOGO_BUCKET).list(clinicId);
    const stale = (existing || [])
      .filter(function (o) {
        if (!o.id) return false;                       // a folder, not a file
        if (!/^logo-[a-z0-9]+\.[a-z]+$/i.test(o.name)) return false;  // not ours
        return (clinicId + '/' + o.name) !== path;     // not the one just written
      })
      .map(function (o) { return clinicId + '/' + o.name; });
    if (stale.length) await asService.storage.from(LOGO_BUCKET).remove(stale);
  } catch (e) { /* a stale logo is not worth failing the upload over */ }

  return json(200, { ok: true, logo_url: logoUrl });
};

// SkinDay M11: clinic-case-publish
//
// Publishes or unpublishes a stored case. Publishing copies the private
// canonical image to the public bucket under a RANDOMIZED key, then records the
// public paths through the publish_case RPC, which independently re-verifies
// membership plus active store and gallery_site consent in one transaction.
//
// The private canonical is already EXIF-free and normalized (the browser
// sanitized it at upload), so publication is a byte copy, not a re-processing
// step. No native image dependency is needed anywhere in this path.
//
// The public key is fresh random and never derived from the private path or the
// case id, because any object in a public bucket is readable by anyone holding
// its URL. Unpublishing deletes the public objects and leaves the private
// canonical intact.
//
// Honest limitation, reflected in what this returns: removing a public object
// stops SkinDay serving it, but cannot recall copies already cached by
// browsers, CDNs, search engines, or social previews. The consent wording must
// say this.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//
// Expects JSON: { action: "publish" | "unpublish", case_id, clinic_id }

const crypto = require('node:crypto');

const PRIVATE_BUCKET = 'clinic-cases-private';
const PUBLIC_BUCKET = 'clinic-cases-public';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
}

async function verifyUser(supabaseUrl, anonKey, token) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

async function isActiveMember(supabaseUrl, anonKey, token, uid, clinicId) {
  const url =
    `${supabaseUrl}/rest/v1/clinic_memberships` +
    `?user_id=eq.${encodeURIComponent(uid)}` +
    `&clinic_id=eq.${encodeURIComponent(clinicId)}` +
    `&status=eq.active&revoked_at=is.null&select=id`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey }
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function downloadPrivate(supabaseUrl, serviceKey, path) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/${PRIVATE_BUCKET}/${path}`,
    { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
  );
  if (!res.ok) {
    throw new Error(`could not read private object ${path}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function uploadPublic(supabaseUrl, serviceKey, path, buffer) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/${PUBLIC_BUCKET}/${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'false'
      },
      body: buffer
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`public upload failed for ${path}: ${res.status} ${detail}`);
  }
}

async function deletePublic(supabaseUrl, serviceKey, paths) {
  const clean = (paths || []).filter(Boolean);
  if (clean.length === 0) return;
  try {
    await fetch(`${supabaseUrl}/storage/v1/object/${PUBLIC_BUCKET}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: clean })
    });
  } catch (err) {
    console.error('public delete failed', clean, err && err.message);
  }
}

function publicUrl(supabaseUrl, path) {
  return `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;
}

async function callRpc(supabaseUrl, anonKey, token, fn, body) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return {};
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method not allowed' });
    }

    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
      return json(500, { ok: false, error: 'server not configured' });
    }

    const authHeader = header(event, 'authorization');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      return json(401, { ok: false, error: 'missing bearer token' });
    }

    const user = await verifyUser(SUPABASE_URL, ANON_KEY, token);
    if (!user) {
      return json(401, { ok: false, error: 'invalid token' });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return json(400, { ok: false, error: 'body must be JSON' });
    }

    const action = (body.action || '').trim();
    const caseId = (body.case_id || '').trim();
    const clinicId = (body.clinic_id || '').trim();

    if (action !== 'publish' && action !== 'unpublish') {
      return json(400, { ok: false, error: 'action must be publish or unpublish' });
    }
    if (!caseId || !clinicId) {
      return json(400, { ok: false, error: 'case_id and clinic_id are required' });
    }

    const member = await isActiveMember(SUPABASE_URL, ANON_KEY, token, user.id, clinicId);
    if (!member) {
      return json(403, { ok: false, error: 'not an active member of this clinic' });
    }

    if (action === 'unpublish') {
      let result;
      try {
        result = await callRpc(SUPABASE_URL, ANON_KEY, token, 'unpublish_case', {
          p_case_id: caseId,
          p_clinic_id: clinicId
        });
      } catch (err) {
        return json(400, { ok: false, error: `unpublish refused: ${err.message}` });
      }
      await deletePublic(SUPABASE_URL, SERVICE_KEY, [
        result.removed_before_path,
        result.removed_after_path
      ]);
      return json(200, {
        ok: true,
        action: 'unpublish',
        case_id: caseId,
        removed: [result.removed_before_path, result.removed_after_path].filter(Boolean),
        note: 'Removed from SkinDay surfaces. Copies already cached by browsers, CDNs, or search engines cannot be recalled.'
      });
    }

    // publish: read the case's private paths through RLS with the caller's token.
    const caseUrl =
      `${SUPABASE_URL}/rest/v1/clinic_reference_cases` +
      `?id=eq.${encodeURIComponent(caseId)}` +
      `&clinic_id=eq.${encodeURIComponent(clinicId)}` +
      `&select=before_path,after_path`;
    const caseRes = await fetch(caseUrl, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY }
    });
    const caseRows = caseRes.ok ? await caseRes.json() : [];
    if (!Array.isArray(caseRows) || caseRows.length === 0) {
      return json(404, { ok: false, error: 'case not found' });
    }
    const before = caseRows[0].before_path;
    const after = caseRows[0].after_path;
    if (!before || !after) {
      return json(400, { ok: false, error: 'case has no stored images' });
    }

    // Fresh random publication id. Never derived from the case id or private path.
    const pubId = crypto.randomBytes(12).toString('hex');
    const pubBefore = `${clinicId}/${pubId}/before.jpg`;
    const pubAfter = `${clinicId}/${pubId}/after.jpg`;

    let beforeBuf;
    let afterBuf;
    try {
      beforeBuf = await downloadPrivate(SUPABASE_URL, SERVICE_KEY, before);
      afterBuf = await downloadPrivate(SUPABASE_URL, SERVICE_KEY, after);
    } catch (err) {
      return json(502, { ok: false, error: err.message });
    }

    try {
      await uploadPublic(SUPABASE_URL, SERVICE_KEY, pubBefore, beforeBuf);
    } catch (err) {
      return json(502, { ok: false, error: err.message });
    }
    try {
      await uploadPublic(SUPABASE_URL, SERVICE_KEY, pubAfter, afterBuf);
    } catch (err) {
      await deletePublic(SUPABASE_URL, SERVICE_KEY, [pubBefore]);
      return json(502, { ok: false, error: err.message });
    }

    let result;
    try {
      result = await callRpc(SUPABASE_URL, ANON_KEY, token, 'publish_case', {
        p_case_id: caseId,
        p_clinic_id: clinicId,
        p_published_before_path: pubBefore,
        p_published_after_path: pubAfter
      });
    } catch (err) {
      // Consent or membership refused it. Nothing may remain public.
      await deletePublic(SUPABASE_URL, SERVICE_KEY, [pubBefore, pubAfter]);
      return json(403, { ok: false, error: `publish refused: ${err.message}` });
    }

    // A re-publish supersedes older public objects. Remove them.
    await deletePublic(SUPABASE_URL, SERVICE_KEY, [
      result.replaced_before_path,
      result.replaced_after_path
    ]);

    return json(200, {
      ok: true,
      action: 'publish',
      case_id: caseId,
      before_url: publicUrl(SUPABASE_URL, pubBefore),
      after_url: publicUrl(SUPABASE_URL, pubAfter)
    });
  } catch (err) {
    console.error('clinic-case-publish failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

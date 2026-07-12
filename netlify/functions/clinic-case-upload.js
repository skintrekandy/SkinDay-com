// SkinDay M11: clinic-case-upload
//
// Synchronous Netlify function for the Skin Trek proof-of-loop. It secures a
// before/after case and returns a confirmed case id, so a patient standing at
// the desk gets certainty their photos were stored, not a background maybe.
//
// Image sanitization happens in the browser (canvas re-encode), which drops all
// EXIF including GPS and camera identifiers and bakes orientation into the
// pixels. This function therefore has no native image dependency. It verifies
// what it receives: JPEG magic bytes, size bounds, and the absence of an EXIF
// APP1 marker. If a client ever sends unsanitized bytes, the upload is refused
// rather than silently stored.
//
// Order matters and is deliberate. Consent and membership are checked before a
// single byte is persisted, because even temporary storage is processing.
// Storage and the database are not one transaction, so a failed database write
// triggers compensating deletion of the objects just written.
//
// The service role key never leaves this function. The database write goes
// through the create_clinic_case RPC using the caller's own token, so
// authorization binds to the verified user, not to anything in the body.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   CLINIC_CASE_REAL_PATIENT_UPLOADS_ENABLED   ("true" to allow patient uploads)
//
// Expects multipart/form-data with:
//   fields: clinic_id, data_classification, consents (JSON string),
//           treatment?, angle?, phenotype?, source_job_id?
//   files:  before, after   (browser-sanitized JPEG)

const crypto = require('node:crypto');
const busboy = require('busboy');

const PRIVATE_BUCKET = 'clinic-cases-private';
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_BYTES = 1024;
const CLASSIFICATIONS = ['synthetic', 'staff_test', 'paid_model', 'patient'];

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

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = header(event, 'content-type');
    if (!contentType.includes('multipart/form-data')) {
      reject(new Error('expected multipart/form-data'));
      return;
    }
    const bb = busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_BYTES, files: 2 }
    });
    const fields = {};
    const files = {};
    let failed = null;
    bb.on('field', (name, val) => {
      fields[name] = val;
    });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => {
        failed = new Error('file exceeds size limit');
        stream.resume();
      });
      stream.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType
        };
      });
    });
    bb.on('close', () => (failed ? reject(failed) : resolve({ fields, files })));
    bb.on('error', reject);
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'utf8');
    bb.end(body);
  });
}

// The browser canvas re-encode produces a clean JPEG with no EXIF. Verify that
// rather than trust it: correct magic bytes, plausible size, no APP1 segment.
function verifySanitizedJpeg(buf, label) {
  if (!buf || buf.length < MIN_BYTES) {
    return `${label} is missing or too small`;
  }
  if (buf.length > MAX_BYTES) {
    return `${label} exceeds the size limit`;
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    return `${label} is not a JPEG (send a browser-sanitized JPEG)`;
  }
  // Walk the JPEG segment headers looking for APP1 (0xFFE1), which carries EXIF.
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda) break; // start of scan; header section is done
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1) {
      return `${label} still contains EXIF metadata (it was not sanitized)`;
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
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

async function uploadPrivate(supabaseUrl, serviceKey, path, buffer) {
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/${PRIVATE_BUCKET}/${path}`,
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
    throw new Error(`storage upload failed for ${path}: ${res.status} ${detail}`);
  }
}

async function deletePrivate(supabaseUrl, serviceKey, paths) {
  try {
    await fetch(`${supabaseUrl}/storage/v1/object/${PRIVATE_BUCKET}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: paths })
    });
  } catch (err) {
    // Best-effort compensation. Surface it for an operator to reconcile.
    console.error('compensating delete failed', paths, err && err.message);
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
    const REAL_PATIENT_ALLOWED =
      process.env.CLINIC_CASE_REAL_PATIENT_UPLOADS_ENABLED === 'true';

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

    let parsed;
    try {
      parsed = await parseMultipart(event);
    } catch (err) {
      return json(400, { ok: false, error: `bad upload: ${err.message}` });
    }

    const { fields, files } = parsed;
    const clinicId = (fields.clinic_id || '').trim();
    const classification = (fields.data_classification || '').trim();
    const treatment = (fields.treatment || '').trim() || null;
    const subtype = (fields.subtype || '').trim() || null;
    const angle = (fields.angle || '').trim() || null;
    const phenotype = (fields.phenotype || '').trim() || null;
    const sourceJobId = (fields.source_job_id || '').trim() || null;

    if (!clinicId) {
      return json(400, { ok: false, error: 'clinic_id is required' });
    }
    if (!CLASSIFICATIONS.includes(classification)) {
      return json(400, { ok: false, error: 'invalid data_classification' });
    }
    if (classification === 'patient' && !REAL_PATIENT_ALLOWED) {
      return json(403, { ok: false, error: 'real patient uploads are disabled' });
    }
    if (!files.before || !files.after) {
      return json(400, { ok: false, error: 'both before and after files are required' });
    }

    const beforeBuf = files.before.buffer;
    const afterBuf = files.after.buffer;
    const beforeProblem = verifySanitizedJpeg(beforeBuf, 'before');
    if (beforeProblem) {
      return json(400, { ok: false, error: beforeProblem });
    }
    const afterProblem = verifySanitizedJpeg(afterBuf, 'after');
    if (afterProblem) {
      return json(400, { ok: false, error: afterProblem });
    }

    let consents;
    try {
      consents = JSON.parse(fields.consents || '[]');
    } catch (err) {
      return json(400, { ok: false, error: 'consents must be valid JSON' });
    }
    if (!Array.isArray(consents)) {
      return json(400, { ok: false, error: 'consents must be an array' });
    }
    const store = consents.find((c) => c && c.purpose === 'store');
    const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
    if (!store || !store.granted || !nonEmpty(store.version) || !nonEmpty(store.method)) {
      return json(400, {
        ok: false,
        error: 'store consent with version and method is required'
      });
    }

    const member = await isActiveMember(SUPABASE_URL, ANON_KEY, token, user.id, clinicId);
    if (!member) {
      return json(403, { ok: false, error: 'not an active member of this clinic' });
    }

    const caseId = `case_${crypto.randomBytes(8).toString('hex')}`;
    const beforePath = `${clinicId}/${caseId}/before.jpg`;
    const afterPath = `${clinicId}/${caseId}/after.jpg`;

    try {
      await uploadPrivate(SUPABASE_URL, SERVICE_KEY, beforePath, beforeBuf);
    } catch (err) {
      return json(502, { ok: false, error: err.message });
    }
    try {
      await uploadPrivate(SUPABASE_URL, SERVICE_KEY, afterPath, afterBuf);
    } catch (err) {
      await deletePrivate(SUPABASE_URL, SERVICE_KEY, [beforePath]);
      return json(502, { ok: false, error: err.message });
    }

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_clinic_case`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_case_id: caseId,
        p_clinic_id: clinicId,
        p_data_classification: classification,
        p_before_path: beforePath,
        p_after_path: afterPath,
        p_consents: consents,
        p_real_patient_allowed: REAL_PATIENT_ALLOWED,
        p_treatment: treatment,
        p_subtype: subtype,
        p_angle: angle,
        p_phenotype: phenotype,
        p_residency: 'ca',
        p_source_job_id: sourceJobId
      })
    });

    if (!rpcRes.ok) {
      const detail = await rpcRes.text();
      await deletePrivate(SUPABASE_URL, SERVICE_KEY, [beforePath, afterPath]);
      return json(502, { ok: false, error: `case not recorded: ${detail}` });
    }

    return json(200, { ok: true, case_id: caseId, data_classification: classification });
  } catch (err) {
    // Never leak a bare platform 500: return the reason so it is debuggable.
    console.error('clinic-case-upload failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

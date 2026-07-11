// SkinDay M11: clinic-case-upload
//
// Synchronous Netlify function for the Skin Trek proof-of-loop. It secures a
// before/after case and returns a confirmed case id, so a patient standing at
// the desk gets certainty their photos were stored, not a background maybe.
//
// Order matters and is deliberate. Consent and membership are checked before a
// single byte is persisted, because even temporary storage is processing.
// Images are sanitized in memory (EXIF stripped, orientation baked, downsized,
// re-encoded) before they touch the private bucket. Storage and the database
// are not one transaction, so a failed database write triggers compensating
// deletion of the objects just written.
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
//   files:  before, after

const crypto = require('node:crypto');
const busboy = require('busboy');
const sharp = require('sharp');

const PRIVATE_BUCKET = 'clinic-cases-private';
const MAX_EDGE = 2400;
const JPEG_QUALITY = 90;
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
    const bb = busboy({ headers: { 'content-type': contentType } });
    const fields = {};
    const files = {};
    bb.on('field', (name, val) => {
      fields[name] = val;
    });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => reject(new Error('file too large')));
      stream.on('end', () => {
        files[name] = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType
        };
      });
    });
    bb.on('close', () => resolve({ fields, files }));
    bb.on('error', reject);
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'utf8');
    bb.end(body);
  });
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

async function sanitizeImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
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
    throw new Error(`storage upload failed for ${path}: ${res.status} ${await res.text()}`);
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
    console.error('compensating delete failed', paths, err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
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

  let beforeBuf;
  let afterBuf;
  try {
    beforeBuf = await sanitizeImage(files.before.buffer);
    afterBuf = await sanitizeImage(files.after.buffer);
  } catch (err) {
    return json(400, { ok: false, error: `could not process images: ${err.message}` });
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
};

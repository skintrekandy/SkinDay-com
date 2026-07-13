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
//
// M12 adds two fields, crop and series_id.
//
// crop is Studio's preset for every photo in the case. It is validated against a
// closed vocabulary here and again in the database, because an unknown crop is
// not a cosmetic problem: the gallery lays out by it and the reference worker
// decides what a case can ground by it. A silently accepted junk value would
// degrade both without erroring.
//
// series_id groups the cases that came out of one Studio grid: one patient, one
// sitting, several angles or several timepoints. It is a grouping key, not an
// authorization key. It names nothing, grants nothing, and is never trusted for
// access: clinic scope still comes from verified membership, as it always has.
// So it is accepted from the client without ceremony, bounded only in length and
// character set so it cannot be used to smuggle anything into a log.
//
// Expects multipart/form-data with:
//   fields: clinic_id, consents (JSON string),
//           treatment?, subtype?, angle?, phenotype?, source_job_id?,
//           before_date?, after_date?, interval_months?, crop?, series_id?
//   files:  before, after   (browser-sanitized JPEG)

const crypto = require('node:crypto');
const busboy = require('busboy');

const PRIVATE_BUCKET = 'clinic-cases-private';
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_BYTES = 1024;

// Studio's crop presets. 'body' is Studio's Body subject, which does not crop at
// all. Keep this in lockstep with FACE_PRESETS in studio.html and with the crop
// check constraint on clinic_reference_cases.
const CROPS = ['full', 'lower', 'upper', 'eyes', 'body'];

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
    const treatment = (fields.treatment || '').trim() || null;
    const subtype = (fields.subtype || '').trim() || null;
    const angle = (fields.angle || '').trim() || null;
    const beforeDate = (fields.before_date || '').trim() || null;
    const afterDate = (fields.after_date || '').trim() || null;
    const intervalMonths = parseInt(fields.interval_months, 10);
    const phenotype = (fields.phenotype || '').trim() || null;
    const sourceJobId = (fields.source_job_id || '').trim() || null;
    const crop = (fields.crop || '').trim() || null;
    const seriesId = (fields.series_id || '').trim() || null;

    if (!clinicId) {
      return json(400, { ok: false, error: 'clinic_id is required' });
    }
    if (crop && !CROPS.includes(crop)) {
      return json(400, { ok: false, error: `unknown crop: ${crop}` });
    }
    if (seriesId && !/^[A-Za-z0-9_-]{1,64}$/.test(seriesId)) {
      return json(400, { ok: false, error: 'series_id is malformed' });
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
        p_before_path: beforePath,
        p_after_path: afterPath,
        p_consents: consents,
        p_treatment: treatment,
        p_subtype: subtype,
        p_angle: angle,
        p_phenotype: phenotype,
        p_before_date: beforeDate,
        p_after_date: afterDate,
        p_interval_months: Number.isFinite(intervalMonths) ? intervalMonths : null,
        p_crop: crop,
        p_series_id: seriesId,
        p_residency: 'ca',
        p_source_job_id: sourceJobId
      })
    });

    if (!rpcRes.ok) {
      const detail = await rpcRes.text();
      await deletePrivate(SUPABASE_URL, SERVICE_KEY, [beforePath, afterPath]);
      return json(502, { ok: false, error: `case not recorded: ${detail}` });
    }

    return json(200, { ok: true, case_id: caseId });
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

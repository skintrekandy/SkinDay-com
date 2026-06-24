// Netlify Function: /.netlify/functions/manage-reference-cases
// M12: CRUD for clinic_reference_cases and the 'reference-cases' Storage bucket.
//
// Endpoints (all require Supabase account auth via Bearer token):
//
//   GET  (no action / ?action=list)
//        Returns all cases for the authenticated clinic.
//        Query params: treatment_area, angle (optional filters).
//
//   POST ?action=upload  (multipart/form-data)
//        Required fields: treatment_area, angle, ai_consent='true'
//        Optional fields: phenotype, sex, age_band, strength_label, months_after
//        Required files:  before (image), after (image)
//        treatment_type is derived server-side from treatment_area.
//        Returns { id, before_path, after_path }.
//
//   POST ?action=delete  (JSON body: { id })
//        Deletes the Storage objects and the DB row.
//        Returns { deleted: true }.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Required packages: busboy (already installed for start-visualization)

const Busboy    = require('busboy');
const { Readable } = require('stream');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET       = 'reference-cases';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Allowed values -- kept in lockstep with the DB check constraints.
const VALID_AREAS    = new Set(['sculptra','ha_chin','ha_chin_jawline','ha_jawline','ha_nose','ha_lips','ha_cheeks']);
const VALID_ANGLES   = new Set(['frontal','oblique_right','oblique_left']);
const VALID_PHENOTYP = new Set(['hollow_deflated','full_descended','mixed']);
const VALID_SEX      = new Set(['female','male']);
const VALID_AGEBAND  = new Set(['20s','30s','40s','50s','60s']);
const VALID_STRENGTH = new Set(['subtle','expected','strong']);

// Derive the coarse treatment_type from the granular treatment_area.
// Used for the worker's treatment_type index so it does not need to know
// all the granular area names.
function treatmentType(area) {
  return area === 'sculptra' ? 'biostim' : 'filler';
}

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function verifyUser(event) {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  const h = event.headers['authorization'] || event.headers['Authorization'] || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + m[1] }
    });
    if (!res.ok) return null;
    const u = await res.json();
    return (u && u.id) ? u : null;
  } catch (e) { return null; }
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files  = {};
    const busboy = Busboy({ headers: event.headers, limits: { fileSize: MAX_FILE_BYTES } });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, file, info) => {
      const chunks = [];
      let truncated = false;
      file.on('data', chunk => chunks.push(chunk));
      file.on('limit', () => { truncated = true; });
      file.on('end', () => {
        files[name] = { buffer: Buffer.concat(chunks), filename: info.filename || name + '.jpg', mimeType: info.mimeType || 'image/jpeg', truncated };
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, files }));
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body || '');
    Readable.from(body).pipe(busboy);
  });
}

// Upload a file buffer to Supabase Storage. Returns the object path.
async function uploadToStorage(userId, angle, suffix, buffer, mimeType) {
  const ext  = (mimeType || '').includes('png') ? 'png' : 'jpg';
  const name = Date.now() + '_' + Math.random().toString(36).slice(2) + '_' + suffix + '.' + ext;
  const path = userId + '/' + angle + '/' + name;
  const res  = await fetch(
    SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(path),
    {
      method:  'POST',
      headers: {
        apikey:         SERVICE_KEY,
        Authorization:  'Bearer ' + SERVICE_KEY,
        'Content-Type': mimeType || 'image/jpeg',
        'x-upsert':     'false'
      },
      body: buffer
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Storage upload failed: HTTP ' + res.status + ' ' + t.slice(0, 200));
  }
  return path;
}

// Delete a Storage object by path (best-effort, non-throwing).
async function deleteFromStorage(path) {
  try {
    const res = await fetch(
      SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(path),
      { method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) console.warn('[manage-reference-cases] Storage delete HTTP ' + res.status + ' for ' + path);
  } catch (e) {
    console.warn('[manage-reference-cases] Storage delete error:', (e && e.message) || e);
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleList(user, qs) {
  const params = new URLSearchParams({
    select:    'id,treatment_area,treatment_type,angle,phenotype,sex,age_band,strength_label,months_after,before_path,after_path,approved,sort_order,created_at',
    clinic_id: 'eq.' + user.id,
    order:     'treatment_area.asc,angle.asc,sort_order.asc,created_at.asc'
  });
  if (qs.get('treatment_area')) params.set('treatment_area', 'eq.' + qs.get('treatment_area'));
  if (qs.get('angle'))          params.set('angle',          'eq.' + qs.get('angle'));
  const res = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases?' + params.toString(), {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, Accept: 'application/json' }
  });
  if (!res.ok) return json(500, { error: 'DB query failed: HTTP ' + res.status });
  return json(200, await res.json());
}

async function handleUpload(user, event) {
  const { fields, files } = await parseMultipart(event);

  // Required fields.
  const area  = (fields.treatment_area || '').toLowerCase().trim();
  const angle = (fields.angle          || '').toLowerCase().trim();
  const consentRaw = (fields.ai_consent || '').toLowerCase().trim();

  if (!VALID_AREAS.has(area))   return json(400, { error: 'Invalid treatment_area. Must be one of: ' + [...VALID_AREAS].join(', ') });
  if (!VALID_ANGLES.has(angle)) return json(400, { error: 'Invalid angle. Must be frontal, oblique_right, or oblique_left.' });
  if (consentRaw !== 'true')    return json(400, { error: 'ai_consent must be true. Confirm this case may be used as an internal AI reference.' });

  // Optional metadata -- validated if present, stored null if absent/blank.
  const phenotype     = fields.phenotype     && VALID_PHENOTYP.has(fields.phenotype)     ? fields.phenotype     : null;
  const sex           = fields.sex           && VALID_SEX.has(fields.sex)                 ? fields.sex           : null;
  const ageBand       = fields.age_band      && VALID_AGEBAND.has(fields.age_band)        ? fields.age_band      : null;
  const strengthLabel = fields.strength_label && VALID_STRENGTH.has(fields.strength_label) ? fields.strength_label : null;
  const monthsAfter   = fields.months_after  ? parseInt(fields.months_after, 10)           : null;
  const monthsAfterOk = monthsAfter !== null && !isNaN(monthsAfter) && monthsAfter >= 1 && monthsAfter <= 24;

  // File checks.
  const beforeFile = files.before;
  const afterFile  = files.after;
  if (!beforeFile || !beforeFile.buffer.length) return json(400, { error: 'Missing before image.' });
  if (!afterFile  || !afterFile.buffer.length)  return json(400, { error: 'Missing after image.' });
  if (beforeFile.truncated) return json(413, { error: 'Before image exceeds 10 MB.' });
  if (afterFile.truncated)  return json(413, { error: 'After image exceeds 10 MB.' });

  // Cap check (max 5 per clinic + treatment_area + angle) before uploading files.
  const capParams = new URLSearchParams({
    select:         'id',
    clinic_id:      'eq.' + user.id,
    treatment_area: 'eq.' + area,
    angle:          'eq.' + angle
  });
  const capRes = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases?' + capParams.toString(), {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, Accept: 'application/json' }
  });
  if (!capRes.ok) return json(500, { error: 'Cap check failed.' });
  const capRows = await capRes.json();
  if (capRows.length >= 5) return json(409, { error: 'Maximum 5 cases per treatment + angle. Delete one before adding another.' });

  // Upload both files to Storage in parallel.
  const [beforePath, afterPath] = await Promise.all([
    uploadToStorage(user.id, angle, 'before', beforeFile.buffer, beforeFile.mimeType),
    uploadToStorage(user.id, angle, 'after',  afterFile.buffer,  afterFile.mimeType)
  ]);

  // Insert DB row. treatment_type is set by the derive_treatment_type trigger,
  // but we supply it explicitly here so the insert does not rely on the trigger
  // being present -- belt-and-braces.
  const row = {
    clinic_id:      user.id,
    treatment_area: area,
    treatment_type: treatmentType(area),
    angle,
    phenotype,
    sex,
    age_band:       ageBand,
    strength_label: strengthLabel,
    months_after:   (monthsAfterOk ? monthsAfter : null),
    ai_consent:     true,
    approved:       true,
    before_path:    beforePath,
    after_path:     afterPath
  };

  const insRes = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases', {
    method:  'POST',
    headers: {
      apikey:          SERVICE_KEY,
      Authorization:   'Bearer ' + SERVICE_KEY,
      'Content-Type':  'application/json',
      Prefer:          'return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!insRes.ok) {
    await Promise.all([deleteFromStorage(beforePath), deleteFromStorage(afterPath)]);
    const t = await insRes.text();
    if (/maximum 5/i.test(t) || /at most 5/i.test(t)) return json(409, { error: 'Maximum 5 cases per treatment + angle. Delete one before adding another.' });
    return json(500, { error: 'DB insert failed: ' + t.slice(0, 200) });
  }

  const inserted = (await insRes.json())[0] || {};
  return json(200, { id: inserted.id, before_path: beforePath, after_path: afterPath });
}

async function handleDelete(user, body) {
  const id = body && body.id;
  if (!id || typeof id !== 'string') return json(400, { error: 'Missing id.' });

  // Fetch row -- must belong to this clinic.
  const rowParams = new URLSearchParams({ select: 'id,before_path,after_path,clinic_id', id: 'eq.' + id });
  const rowRes = await fetch(SUPABASE_URL + '/rest/v1/clinic_reference_cases?' + rowParams.toString(), {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if (!rowRes.ok) return json(500, { error: 'DB fetch failed.' });
  const rows = await rowRes.json();
  if (!rows.length) return json(404, { error: 'Case not found.' });
  if (rows[0].clinic_id !== user.id) return json(403, { error: 'Forbidden.' });

  await Promise.all([deleteFromStorage(rows[0].before_path), deleteFromStorage(rows[0].after_path)]);

  const delRes = await fetch(
    SUPABASE_URL + '/rest/v1/clinic_reference_cases?id=eq.' + encodeURIComponent(id),
    { method: 'DELETE', headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
  );
  if (!delRes.ok) return json(500, { error: 'DB delete failed.' });
  return json(200, { deleted: true });
}

// ── main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(503, { error: 'Clinic library not available (Supabase not configured).' });
  }

  const user = await verifyUser(event);
  if (!user) return json(401, { error: 'Sign in required.' });

  const method = event.httpMethod;
  const qs     = new URLSearchParams(event.queryStringParameters || {});
  const action = qs.get('action') || '';

  try {
    if (method === 'GET' || action === 'list') return await handleList(user, qs);
    if (method === 'POST' && action === 'upload') return await handleUpload(user, event);
    if (method === 'POST' && action === 'delete') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) { /* ignore */ }
      return await handleDelete(user, body);
    }
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('[manage-reference-cases] error:', (err && err.message) || err);
    return json(500, { error: (err && err.message) || 'Internal error.' });
  }
};

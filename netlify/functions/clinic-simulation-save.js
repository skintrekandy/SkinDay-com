// netlify/functions/clinic-simulation-save.js
//
// SkinDay M13. Save a Visualize generation into a clinic's Library.
//
// The two patients
//   A stored simulation is the record of patient B, the person in the chair, not
//   of patient A whose reference case grounded it. before_path is patient B's
//   photograph. after_path is the generated prediction of patient B's face. Both
//   are held under patient B's store consent, which the clinic attests to here
//   exactly as it attests when saving a photograph from Studio.
//
// What comes from where, and why
//   IMAGES come from the browser. They are the images the clinician actually
//   reviewed: the black-background before that the model saw, and the composited
//   result that was displayed. The raw model output in the blob store is NOT
//   always what was on screen (nose and lip filler are composited client-side),
//   and the record should hold what a human looked at and consented to.
//
//   PROVENANCE comes from the server. treatment, subtype, angle and
//   referenceCaseIds are read off the job's status blob by jobId. Which
//   patient's photograph grounded which simulation is not a thing a browser gets
//   to assert, and the canonical treatment vocabulary has to match the one
//   photographs are filed under or the Library silently splits into two.
//
// Env
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const { getStore, connectLambda } = require('@netlify/blobs');

const PRIVATE_BUCKET = 'clinic-cases-private';
// Must match the store the background worker writes to, exactly.
const BLOB_STORE = 'visualize-jobs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function randomId(prefix) {
  let hex = '';
  const bytes = require('crypto').randomBytes(8);
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return prefix + hex;
}

// A data URL from the browser. Reject anything that is not a jpeg or png, and
// anything oversized, before it reaches storage.
function decodeDataUrl(dataUrl, label) {
  if (typeof dataUrl !== 'string') {
    throw new Error(label + ' is missing');
  }
  const m = /^data:(image\/(?:jpeg|jpg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) {
    throw new Error(label + ' is not a base64 jpeg or png data URL');
  }
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length === 0) throw new Error(label + ' is empty');
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(label + ' exceeds ' + MAX_IMAGE_BYTES + ' bytes');
  }
  return { buffer, contentType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1] };
}

function extFor(contentType) {
  return contentType === 'image/png' ? 'png' : 'jpg';
}

exports.handler = async function (event) {
  // Wire the Blobs context into the classic handler signature, exactly as
  // generate-visualization-background does. Without this, getStore fails.
  connectLambda(event);

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
  const items = Array.isArray(body.items) ? body.items : [];
  const consents = Array.isArray(body.consents) ? body.consents : [];
  const treatmentLabel = body.treatmentLabel ? String(body.treatmentLabel) : null;
  const injectorName = body.injectorName ? String(body.injectorName) : null;

  if (!clinicId) return json(400, { error: 'clinicId is required' });
  if (items.length === 0) return json(400, { error: 'no finished generations to save' });

  // The attestation. create_clinic_simulation enforces this too, and rejects
  // gallery_site and visualize outright, but failing here is cheaper than
  // failing after two images have been uploaded.
  const hasStore = consents.some(function (c) { return c && c.purpose === 'store'; });
  if (!hasStore) {
    return json(400, { error: 'store consent must be attested before a simulation can be saved' });
  }

  // Membership is proved by the caller's own JWT against RLS and the RPC's
  // membership gate, not by trusting body.clinicId. The service-role client is
  // used only for storage writes, which have no user context.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const asService = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const store = getStore(BLOB_STORE);

  // One Visualize run across several angles is one series, exactly as one Studio
  // grid is one series. The Library groups on it.
  const seriesId = items.length > 1 ? randomId('series_sim_') : null;

  const saved = [];
  const failed = [];
  const uploaded = [];

  for (const item of items) {
    const jobId = item && item.jobId ? String(item.jobId) : '';
    if (!jobId) {
      failed.push({ angle: (item && item.angle) || null, error: 'missing jobId' });
      continue;
    }

    const caseId = randomId('case_sim_');

    try {
      // Provenance, server-side. A job with no status blob never finished, or
      // finished so long ago the blob is gone; either way it is not savable.
      let status = null;
      try {
        status = await store.get(jobId + ':status', { type: 'json' });
      } catch (err) {
        status = null;
      }
      if (!status || status.state !== 'done') {
        throw new Error('job ' + jobId + ' has no completed result on the server');
      }

      const before = decodeDataUrl(item.before, 'before image');
      const after = decodeDataUrl(item.after, 'after image');

      const beforePath =
        clinicId + '/' + caseId + '/before.' + extFor(before.contentType);
      const afterPath =
        clinicId + '/' + caseId + '/after.' + extFor(after.contentType);

      const upBefore = await asService.storage
        .from(PRIVATE_BUCKET)
        .upload(beforePath, before.buffer, {
          contentType: before.contentType,
          upsert: false
        });
      if (upBefore.error) throw new Error('before upload failed: ' + upBefore.error.message);
      uploaded.push(beforePath);

      const upAfter = await asService.storage
        .from(PRIVATE_BUCKET)
        .upload(afterPath, after.buffer, {
          contentType: after.contentType,
          upsert: false
        });
      if (upAfter.error) throw new Error('after upload failed: ' + upAfter.error.message);
      uploaded.push(afterPath);

      // The row last. If this fails, the objects above are orphaned under a
      // predictable prefix, which is precisely what the reconcile mode of
      // clinic-case-purge exists to find. Nothing is silently stranded.
      const { error: rpcError } = await asUser.rpc('create_clinic_simulation', {
        p_case_id: caseId,
        p_clinic_id: clinicId,
        p_before_path: beforePath,
        p_after_path: afterPath,
        p_consents: consents,
        p_treatment: status.treatment || null,
        p_subtype: status.subtype || null,
        p_angle: status.angle || item.angle || null,
        p_phenotype: null,
        p_crop: 'full',
        p_series_id: seriesId,
        p_treatment_label: treatmentLabel,
        p_injector_name: injectorName,
        p_reference_case_ids: Array.isArray(status.referenceCaseIds)
          ? status.referenceCaseIds
          : [],
        p_model: status.model || null,
        p_prompt_version: null,
        p_scenario: item.scenario || null,
        p_credits_spent: null,
        p_residency: 'ca',
        p_source_job_id: jobId
      });

      if (rpcError) throw new Error('create_clinic_simulation failed: ' + rpcError.message);

      saved.push({
        case_id: caseId,
        angle: status.angle || item.angle || null,
        treatment: status.treatment || null,
        reference_case_ids: Array.isArray(status.referenceCaseIds)
          ? status.referenceCaseIds
          : [],
        grounded: !!(status.referenceMode === 'clinic_case')
      });
    } catch (err) {
      failed.push({ angle: (item && item.angle) || null, error: err.message });
    }
  }

  if (saved.length === 0) {
    return json(500, { ok: false, saved: [], failed });
  }

  return json(200, {
    ok: true,
    series_id: seriesId,
    saved,
    failed
  });
};

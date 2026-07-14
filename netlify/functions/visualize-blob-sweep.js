// netlify/functions/visualize-blob-sweep.js
//
// SkinDay M13. Retention sweep for the Visualize blob store.
//
// The problem this exists for
//   generate-visualization-background wrote two things per job:
//
//     <jobId>:job     the patient's uploaded photograph, base64
//     <jobId>:result  the generated image of that patient's face
//
//   It deleted <jobId>:job on success, to free a large payload. That was a cost
//   decision, not a privacy one, and it shows: <jobId>:result was never deleted
//   at all, and on a failed or moderation-blocked generation <jobId>:job was not
//   deleted either. So every generation SkinDay has ever run left a face in this
//   store permanently. On success, the AI-rendered one. On failure, the patient's
//   actual photograph, at full upload resolution.
//
//   "Consumer Visualize keeps no storage" is the premise the product is sold on.
//   In the one place where it counts it was not true.
//
// Retention
//   Nothing here needs to outlive the session. pollForResult gives up after six
//   minutes. A clinic saving a simulation to its Library does it in the same
//   sitting. TTL_HOURS is therefore generous at 24, not tight.
//
// Dating a blob
//   Netlify Blobs list() returns keys, not timestamps. A job is datable only via
//   its <jobId>:status record, which carries updatedAt.
//
//   Every :result has a :status, because the worker writes them in the same
//   breath. So everything holding a generated face is datable and is deleted on
//   the first sweep that sees it aged out.
//
//   A :job with no :status is either IN FLIGHT RIGHT NOW or the debris of a
//   crashed invocation, and the key alone cannot tell those apart. Deleting it
//   blindly would destroy a live generation mid-run. So it gets a <jobId>:seen
//   marker on the first sweep and is only removed on a later sweep once that
//   marker has itself aged out. A live job finishes and deletes itself long
//   before the second pass. A dead one ages out. This costs one extra TTL window
//   on the backlog and cannot ever destroy work in progress.
//
// Modes
//   POST { }                          dry run. Reports. Deletes nothing.
//   POST { "dryRun": false }          deletes.
//   POST { "ttlHours": 48 }           override the TTL for this run.
//
// Also runs on a schedule. See the netlify.toml stanza at the foot of this file.
//
// Env
//   PURGE_ADMIN_KEY   required in the x-skinday-admin-key header for HTTP calls.

const { getStore, connectLambda } = require('@netlify/blobs');

const BLOB_STORE = 'visualize-jobs';
const DEFAULT_TTL_HOURS = 24;
const ADMIN_KEY = process.env.PURGE_ADMIN_KEY;

// The suffixes a job can leave behind. :seen is this sweep's own marker.
const SUFFIXES = ['job', 'result', 'status', 'billing', 'seen'];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body, null, 2)
  };
}

function splitKey(key) {
  const i = key.lastIndexOf(':');
  if (i < 1) return null;
  const suffix = key.slice(i + 1);
  if (SUFFIXES.indexOf(suffix) === -1) return null;
  return { jobId: key.slice(0, i), suffix };
}

async function listAll(store) {
  const keys = [];
  let cursor;
  for (;;) {
    const page = await store.list(cursor ? { cursor } : undefined);
    for (const b of (page.blobs || [])) keys.push(b.key);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return keys;
}

async function readJson(store, key) {
  try {
    return await store.get(key, { type: 'json' });
  } catch (err) {
    return null;
  }
}

async function sweep(store, ttlHours, dryRun) {
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff = now - ttlMs;

  const keys = await listAll(store);

  // Group every key under its job.
  const jobs = new Map();
  const unrecognized = [];
  for (const key of keys) {
    const parsed = splitKey(key);
    if (!parsed) { unrecognized.push(key); continue; }
    if (!jobs.has(parsed.jobId)) jobs.set(parsed.jobId, {});
    jobs.get(parsed.jobId)[parsed.suffix] = key;
  }

  const expired = [];      // aged out, datable, delete now
  const live = [];         // datable, still inside the TTL
  const marked = [];       // undatable, marker written this run
  const secondPass = [];   // undatable, marker aged out, delete now
  const waiting = [];      // undatable, marker still fresh

  for (const [jobId, parts] of jobs) {
    // A stray :seen with nothing else left is our own litter. Clean it up.
    if (parts.seen && !parts.job && !parts.result && !parts.status && !parts.billing) {
      expired.push({ jobId, at: null, keys: [parts.seen], reason: 'orphan marker' });
      continue;
    }

    const status = parts.status ? await readJson(store, parts.status) : null;
    const at = status && typeof status.updatedAt === 'number' ? status.updatedAt : null;

    const payload = SUFFIXES
      .filter(sfx => parts[sfx])
      .map(sfx => parts[sfx]);

    if (at !== null) {
      // Datable. Everything holding a face falls here, because the worker writes
      // :status and :result together.
      if (at < cutoff) {
        expired.push({
          jobId,
          at: new Date(at).toISOString(),
          keys: payload,
          holds_image: !!(parts.result || parts.job),
          reason: status.state === 'done' ? 'completed job aged out' : 'failed job aged out'
        });
      } else {
        live.push({ jobId, at: new Date(at).toISOString() });
      }
      continue;
    }

    // Undatable. Could be in flight this second. Two-pass aging.
    const seen = parts.seen ? await readJson(store, parts.seen) : null;
    const seenAt = seen && typeof seen.at === 'number' ? seen.at : null;

    if (seenAt === null) {
      marked.push({ jobId, keys: payload, holds_image: !!parts.job });
      if (!dryRun) {
        try {
          await store.setJSON(jobId + ':seen', { at: now });
        } catch (err) { /* next sweep will retry */ }
      }
      continue;
    }

    if (seenAt < cutoff) {
      secondPass.push({
        jobId,
        first_seen: new Date(seenAt).toISOString(),
        keys: payload,
        holds_image: !!parts.job,
        reason: 'no status was ever written, and it has not moved in a full TTL window'
      });
    } else {
      waiting.push({ jobId, first_seen: new Date(seenAt).toISOString() });
    }
  }

  const toDelete = expired.concat(secondPass);
  const keysToDelete = [];
  for (const j of toDelete) for (const k of j.keys) keysToDelete.push(k);

  const report = {
    dry_run: dryRun,
    ttl_hours: ttlHours,
    cutoff: new Date(cutoff).toISOString(),
    jobs_in_store: jobs.size,
    keys_in_store: keys.length,
    images_recoverable_today: expired
      .concat(secondPass)
      .filter(j => j.holds_image).length,
    expired: expired.length,
    second_pass: secondPass.length,
    marked_this_run: marked.length,
    waiting_for_second_pass: waiting.length,
    within_ttl: live.length,
    unrecognized_keys: unrecognized,
    keys_to_delete: keysToDelete.length
  };

  if (dryRun) {
    report.sample = toDelete.slice(0, 10);
    return report;
  }

  let deleted = 0;
  const errors = [];
  for (const key of keysToDelete) {
    try {
      await store.delete(key);
      deleted += 1;
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  }

  report.deleted = deleted;
  report.errors = errors;
  return report;
}

exports.handler = async function (event) {
  connectLambda(event);

  const store = getStore(BLOB_STORE);

  // Netlify invokes a scheduled function with no admin header. A scheduled run
  // is always a live run at the default TTL, which is the point of scheduling it.
  const isScheduled = !!(event && (event.headers || {})['x-nf-event'] === 'schedule');

  if (isScheduled) {
    try {
      const report = await sweep(store, DEFAULT_TTL_HOURS, false);
      console.log('[blob-sweep] ' + JSON.stringify(report));
      return json(200, report);
    } catch (err) {
      console.error('[blob-sweep] failed:', err.message);
      return json(500, { error: err.message });
    }
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }
  if (!ADMIN_KEY) {
    return json(500, { error: 'missing env: PURGE_ADMIN_KEY' });
  }

  const headers = event.headers || {};
  const supplied = headers['x-skinday-admin-key'] || headers['X-Skinday-Admin-Key'];
  if (!supplied || supplied !== ADMIN_KEY) {
    return json(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { error: 'invalid json body' });
  }

  const dryRun = body.dryRun !== false;
  const ttlHours = Number.isFinite(body.ttlHours) && body.ttlHours > 0
    ? body.ttlHours
    : DEFAULT_TTL_HOURS;

  try {
    return json(200, await sweep(store, ttlHours, dryRun));
  } catch (err) {
    return json(500, { error: err.message });
  }
};

// Runs daily. Add this to netlify.toml:
//
//   [functions."visualize-blob-sweep"]
//     schedule = "0 4 * * *"
//
// A daily cadence with a 24 hour TTL means a blob lives at most 48 hours, and a
// job that never wrote a status lives at most 72. Tighten the schedule before
// tightening the TTL: the TTL is what protects a clinician who steps away from a
// finished simulation and comes back to save it.

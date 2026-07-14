// netlify/functions/clinic-case-purge.js
//
// SkinDay M13. Storage purge for withdrawn and deleted clinic cases.
//
// Phase 2 of the two-phase purge defined in m13_01_purge_lifecycle.sql.
// SQL attests and enumerates. This deletes the bytes. SQL finalizes.
//
// Ordering is load bearing:
//   1. begin_case_purge   hashes the consent history into the tombstone and
//                         persists the object manifest. Destroys nothing.
//   2. this function      removes the objects from both buckets.
//   3. complete_case_purge hard-deletes the case row.
//
// A case row deleted before its published paths are read leaves a public object
// with a random key that no row names. That object can never be found again by
// case id. Read first, delete second, destroy the row last.
//
// Modes
//   case      purge one case
//   sweep     purge the backlog returned by list_pending_purges
//   reconcile find objects in the buckets that no live row references
//
// dryRun defaults to true and performs no mutations of any kind.
//
// Env
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PURGE_ADMIN_KEY            required in the x-skinday-admin-key header

const { createClient } = require('@supabase/supabase-js');

const PRIVATE_BUCKET = 'clinic-cases-private';
const PUBLIC_BUCKET = 'clinic-cases-public';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.PURGE_ADMIN_KEY;

const LIST_PAGE = 100;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body, null, 2)
  };
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Supabase storage list is one level at a time. Folders come back with a null
// id. Walk the tree and return full object keys.
async function listRecursive(db, bucket, prefix) {
  const found = [];
  const queue = [prefix || ''];

  while (queue.length > 0) {
    const dir = queue.shift();
    let offset = 0;

    for (;;) {
      const { data, error } = await db.storage.from(bucket).list(dir, {
        limit: LIST_PAGE,
        offset
      });

      if (error) {
        throw new Error(
          'list failed on bucket ' + bucket + ' at "' + dir + '": ' + error.message
        );
      }
      if (!data || data.length === 0) break;

      for (const entry of data) {
        const key = dir ? dir + '/' + entry.name : entry.name;
        if (entry.id === null || entry.id === undefined) {
          queue.push(key);
        } else {
          found.push(key);
        }
      }

      if (data.length < LIST_PAGE) break;
      offset += LIST_PAGE;
    }
  }

  return found;
}

async function removeAll(db, bucket, keys) {
  const removed = [];
  const errors = [];

  for (let i = 0; i < keys.length; i += LIST_PAGE) {
    const batch = keys.slice(i, i + LIST_PAGE);
    const { data, error } = await db.storage.from(bucket).remove(batch);

    if (error) {
      errors.push({ bucket, batch, message: error.message });
      continue;
    }
    for (const obj of data || []) {
      removed.push(bucket + '/' + obj.name);
    }
  }

  return { removed, errors };
}

function manifestPaths(objects, scope) {
  return (objects || [])
    .filter(function (o) { return o.scope === scope && o.path; })
    .map(function (o) { return o.path; });
}

function uniq(list) {
  return Array.from(new Set(list));
}

// ---------------------------------------------------------------------------
// case
// ---------------------------------------------------------------------------

async function purgeCase(db, caseId, clinicId, dryRun, reason) {
  const prefix = clinicId + '/' + caseId;

  if (dryRun) {
    const { data: row, error } = await db
      .from('clinic_reference_cases')
      .select(
        'id, clinic_id, deleted_at, data_classification, ' +
        'before_path, after_path, published_before_path, published_after_path'
      )
      .eq('id', caseId)
      .eq('clinic_id', clinicId)
      .maybeSingle();

    if (error) throw new Error('row read failed: ' + error.message);

    const privateByPrefix = await listRecursive(db, PRIVATE_BUCKET, prefix);

    const privateKeys = uniq(
      privateByPrefix.concat(
        row ? [row.before_path, row.after_path].filter(Boolean) : []
      )
    );
    const publicKeys = row
      ? [row.published_before_path, row.published_after_path].filter(Boolean)
      : [];

    return {
      case_id: caseId,
      clinic_id: clinicId,
      dry_run: true,
      case_row_exists: Boolean(row),
      soft_deleted: Boolean(row && row.deleted_at),
      would_delete: {
        [PRIVATE_BUCKET]: privateKeys,
        [PUBLIC_BUCKET]: publicKeys
      },
      note: row
        ? null
        : 'Case row is gone. Any published object it once had is unrecoverable ' +
          'by case id. Run reconcile.'
    };
  }

  const { data: begun, error: beginErr } = await db.rpc('begin_case_purge', {
    p_case_id: caseId,
    p_clinic_id: clinicId,
    p_reason: reason || 'storage purge'
  });

  if (beginErr) throw new Error('begin_case_purge failed: ' + beginErr.message);

  if (begun && begun.already_purged) {
    return { case_id: caseId, clinic_id: clinicId, purged: true, note: 'already complete' };
  }

  const objects = (begun && begun.objects) || [];

  // The manifest names what the columns hold. The prefix listing catches
  // anything else that was ever written under this case, which the columns
  // would not know about.
  const privateByPrefix = await listRecursive(db, PRIVATE_BUCKET, prefix);
  const privateKeys = uniq(privateByPrefix.concat(manifestPaths(objects, 'private')));
  const publicKeys = uniq(manifestPaths(objects, 'public'));

  const privateResult = await removeAll(db, PRIVATE_BUCKET, privateKeys);
  const publicResult = await removeAll(db, PUBLIC_BUCKET, publicKeys);

  const errors = privateResult.errors.concat(publicResult.errors);
  const removed = privateResult.removed.concat(publicResult.removed);

  // complete_case_purge refuses to destroy the row if storage reported errors,
  // because the row is the only thing that can drive a retry against a live path.
  const { data: done, error: doneErr } = await db.rpc('complete_case_purge', {
    p_case_id: caseId,
    p_clinic_id: clinicId,
    p_objects_removed: removed.length,
    p_storage_errors: errors.length > 0 ? errors : null
  });

  if (doneErr) {
    return {
      case_id: caseId,
      clinic_id: clinicId,
      purged: false,
      objects_removed: removed.length,
      storage_errors: errors,
      error: doneErr.message
    };
  }

  return {
    case_id: caseId,
    clinic_id: clinicId,
    purged: true,
    objects_removed: removed.length,
    removed,
    consent_record_hash: done && done.consent_record_hash
  };
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

async function sweep(db, clinicId, limit, dryRun) {
  const { data: pending, error } = await db.rpc('list_pending_purges', {
    p_clinic_id: clinicId || null,
    p_limit: limit || 100
  });

  if (error) throw new Error('list_pending_purges failed: ' + error.message);

  const results = [];
  for (const t of pending || []) {
    try {
      results.push(await purgeCase(db, t.case_id, t.clinic_id, dryRun, t.deletion_reason));
    } catch (err) {
      results.push({
        case_id: t.case_id,
        clinic_id: t.clinic_id,
        purged: false,
        error: err.message
      });
    }
  }

  const purged = results.filter(function (r) { return r.purged; }).length;
  const failed = results.filter(function (r) { return r.purged === false; }).length;

  return {
    mode: 'sweep',
    dry_run: dryRun,
    pending_found: (pending || []).length,
    purged,
    failed,
    results
  };
}

// ---------------------------------------------------------------------------
// reconcile
//
// A case whose published paths were nulled before any purge existed left a
// public object at a random key that no row names. It is unfindable by case id.
// The only way to find it is to list the bucket and diff against every path the
// database still references.
//
// Published keys carry no reliable clinic prefix, so the public side of this is
// necessarily global. It cannot be scoped to one clinic without risking the
// deletion of another clinic's objects.
// ---------------------------------------------------------------------------

async function reconcile(db, dryRun) {
  const referencedPublic = new Set();
  const liveCaseIds = new Set();
  const clinicOfCase = new Map();

  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('clinic_reference_cases')
      .select('id, clinic_id, published_before_path, published_after_path')
      .range(from, from + 999);

    if (error) throw new Error('case scan failed: ' + error.message);
    if (!data || data.length === 0) break;

    for (const row of data) {
      liveCaseIds.add(row.clinic_id + '/' + row.id);
      clinicOfCase.set(row.id, row.clinic_id);
      if (row.published_before_path) referencedPublic.add(row.published_before_path);
      if (row.published_after_path) referencedPublic.add(row.published_after_path);
    }

    if (data.length < 1000) break;
    from += 1000;
  }

  const publicKeys = await listRecursive(db, PUBLIC_BUCKET, '');
  const publicOrphans = publicKeys.filter(function (k) {
    return !referencedPublic.has(k);
  });

  const privateKeys = await listRecursive(db, PRIVATE_BUCKET, '');
  const privateOrphans = privateKeys.filter(function (k) {
    const parts = k.split('/');
    if (parts.length < 2) return true;
    return !liveCaseIds.has(parts[0] + '/' + parts[1]);
  });

  const report = {
    mode: 'reconcile',
    dry_run: dryRun,
    live_case_rows: liveCaseIds.size,
    [PUBLIC_BUCKET]: {
      objects_in_bucket: publicKeys.length,
      referenced_by_a_row: referencedPublic.size,
      orphans: publicOrphans
    },
    [PRIVATE_BUCKET]: {
      objects_in_bucket: privateKeys.length,
      orphans: privateOrphans
    }
  };

  if (dryRun) return report;

  const pub = await removeAll(db, PUBLIC_BUCKET, publicOrphans);
  const priv = await removeAll(db, PRIVATE_BUCKET, privateOrphans);

  report.deleted = {
    [PUBLIC_BUCKET]: pub.removed.length,
    [PRIVATE_BUCKET]: priv.removed.length
  };
  report.errors = pub.errors.concat(priv.errors);

  return report;
}

// ---------------------------------------------------------------------------

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  if (!SUPABASE_URL || !SERVICE_KEY || !ADMIN_KEY) {
    return json(500, {
      error: 'missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PURGE_ADMIN_KEY'
    });
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

  // Destructive by exception only. Anything that is not an explicit false is a
  // dry run.
  const dryRun = body.dryRun !== false;
  const db = admin();

  try {
    if (body.mode === 'case') {
      if (!body.caseId || !body.clinicId) {
        return json(400, { error: 'mode "case" requires caseId and clinicId' });
      }
      return json(200, await purgeCase(db, body.caseId, body.clinicId, dryRun, body.reason));
    }

    if (body.mode === 'sweep') {
      return json(200, await sweep(db, body.clinicId || null, body.limit || 100, dryRun));
    }

    if (body.mode === 'reconcile') {
      if (!dryRun && body.confirm !== 'DELETE_ORPHANS') {
        return json(400, {
          error:
            'reconcile is global across all clinics and deletes objects that no ' +
            'row references. To proceed, send confirm: "DELETE_ORPHANS".'
        });
      }
      return json(200, await reconcile(db, dryRun));
    }

    return json(400, { error: 'mode must be one of: case, sweep, reconcile' });
  } catch (err) {
    return json(500, { error: err.message });
  }
};

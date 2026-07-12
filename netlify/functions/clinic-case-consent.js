// SkinDay M11: clinic-case-consent
//
// Grants or revokes a purpose-scoped consent on a case.
//
//   POST /api/clinic-case-consent
//   { action: "grant",  case_id, clinic_id, purpose, version, method }
//   { action: "revoke", case_id, clinic_id, purpose, reason? }
//
// The database RPCs own every invariant (membership, store-consent-as-root,
// store-revocation-cascades-to-soft-delete) and write the audit events. This
// worker exists for the one thing Postgres cannot do: delete storage objects.
// When a revocation orphans a public derivative, the RPC returns its path and
// this worker removes it.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

const PUBLIC_BUCKET = 'clinic-cases-public';

const PURPOSES = [
  'store',
  'visualize',
  'gallery_site',
  'directory_search',
  'skinday_marketing',
  'cross_clinic_training'
];

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
  if (!res.ok) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch (err) {
    return {};
  }
}

async function deletePublic(supabaseUrl, serviceKey, paths) {
  const clean = (paths || []).filter(Boolean);
  if (clean.length === 0) return [];
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
    return clean;
  } catch (err) {
    // The consent change is already committed and logged. A failed object
    // delete must be visible, not silent: it is a live privacy exposure.
    console.error('CONSENT REVOKED BUT PUBLIC OBJECT DELETE FAILED', clean, err && err.message);
    return [];
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
    if (!token) return json(401, { ok: false, error: 'missing bearer token' });

    const user = await verifyUser(SUPABASE_URL, ANON_KEY, token);
    if (!user) return json(401, { ok: false, error: 'invalid token' });

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (err) {
      return json(400, { ok: false, error: 'body must be JSON' });
    }

    const action = (body.action || '').trim();
    const caseId = (body.case_id || '').trim();
    const clinicId = (body.clinic_id || '').trim();
    const purpose = (body.purpose || '').trim();

    if (action !== 'grant' && action !== 'revoke') {
      return json(400, { ok: false, error: 'action must be grant or revoke' });
    }
    if (!caseId || !clinicId) {
      return json(400, { ok: false, error: 'case_id and clinic_id are required' });
    }
    if (!PURPOSES.includes(purpose)) {
      return json(400, { ok: false, error: 'invalid purpose' });
    }

    if (action === 'grant') {
      const version = (body.version || '').trim();
      const method = (body.method || '').trim();
      if (!version || !method) {
        return json(400, { ok: false, error: 'version and method are required' });
      }
      let result;
      try {
        result = await callRpc(SUPABASE_URL, ANON_KEY, token, 'grant_case_consent', {
          p_case_id: caseId,
          p_clinic_id: clinicId,
          p_purpose: purpose,
          p_version: version,
          p_method: method
        });
      } catch (err) {
        return json(403, { ok: false, error: `grant refused: ${err.message}` });
      }
      return json(200, { ok: true, action: 'grant', result });
    }

    let result;
    try {
      result = await callRpc(SUPABASE_URL, ANON_KEY, token, 'revoke_case_consent', {
        p_case_id: caseId,
        p_clinic_id: clinicId,
        p_purpose: purpose,
        p_reason: (body.reason || '').trim() || null
      });
    } catch (err) {
      return json(403, { ok: false, error: `revoke refused: ${err.message}` });
    }

    const removed = await deletePublic(SUPABASE_URL, SERVICE_KEY, [
      result.removed_before_path,
      result.removed_after_path
    ]);

    return json(200, {
      ok: true,
      action: 'revoke',
      purpose,
      case_id: caseId,
      case_soft_deleted: !!result.case_soft_deleted,
      public_objects_removed: removed,
      note:
        'Removed from SkinDay surfaces. Copies already cached by browsers, CDNs, or search engines cannot be recalled. Private objects are removed by the purge job.'
    });
  } catch (err) {
    console.error('clinic-case-consent failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

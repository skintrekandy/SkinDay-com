// SkinDay M11: clinic-case-image
//
// Streams a PRIVATE case image to an authorized clinic member so the portal can
// display it. Private objects have no public URL by design.
//
//   GET /api/clinic-case-image?case_id=...&which=before|after
//   Authorization: Bearer <user access token>
//
// This PROXIES the bytes rather than minting a signed URL. That is deliberate:
// a signed URL is a shareable, unauthenticated link to a patient's photograph
// that stays valid until it expires, even if keys are rotated. Proxying means no
// such link ever exists. Every single view is authenticated and authorized at
// request time, and the image cannot be forwarded, bookmarked, or leaked as a
// URL. The cost is a little bandwidth through the function, which for thumbnails
// is nothing.
//
// Authorization comes from RLS, not from the request: the case row is read with
// the CALLER'S token, so it only resolves if they are an active member of the
// clinic that owns the case. The clinic id is never taken from the query string.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

const PRIVATE_BUCKET = 'clinic-cases-private';

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

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
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

    const params = event.queryStringParameters || {};
    const caseId = (params.case_id || '').trim();
    const which = (params.which || 'before').trim();
    if (!caseId) return json(400, { ok: false, error: 'case_id is required' });
    if (which !== 'before' && which !== 'after') {
      return json(400, { ok: false, error: 'which must be before or after' });
    }

    // Read the case with the CALLER'S token. RLS returns it only if they are an
    // active member of the owning clinic, so this read is both lookup and
    // authorization. A caller cannot name someone else's case and get bytes.
    const caseRes = await fetch(
      `${SUPABASE_URL}/rest/v1/clinic_reference_cases` +
        `?id=eq.${encodeURIComponent(caseId)}` +
        `&select=before_path,after_path`,
      { headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY } }
    );
    const rows = caseRes.ok ? await caseRes.json() : [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return json(404, { ok: false, error: 'case not found' });
    }

    const path = which === 'before' ? rows[0].before_path : rows[0].after_path;
    if (!path) return json(404, { ok: false, error: 'image not stored' });

    // Fetch the object with the service role and hand the bytes straight back.
    const objRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${PRIVATE_BUCKET}/${path}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (!objRes.ok) {
      return json(502, {
        ok: false,
        error: `could not read object: ${objRes.status}`
      });
    }

    const buf = Buffer.from(await objRes.arrayBuffer());
    const contentType = objRes.headers.get('content-type') || 'image/jpeg';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        // Patient imagery: never cached by shared or intermediary caches.
        'Cache-Control': 'private, no-store'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    console.error('clinic-case-image failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

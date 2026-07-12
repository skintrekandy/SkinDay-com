// SkinDay M11: clinic-gallery
//
// Public JSON endpoint for a clinic's published before/after cases.
//
//   GET /api/clinic-gallery?clinic_id=386
//
// No authentication. This is the developer-facing tier of gallery delivery: a
// clinic's own developer can call it and build any layout they like. The embed
// script (gallery-embed.js) and the hosted gallery page both consume this too.
//
// Security: this endpoint holds only the ANON key. The consent filter is
// enforced inside the get_clinic_gallery database function, which cannot return
// an unconsented, unpublished, or deleted case. No service-role credential is
// present in this path, deliberately: a public endpoint should not be able to
// read anything a stranger should not see, even if it is misused.
//
// CORS is open because clinic websites on their own domains embed this.
// Everything it returns is already consented to public disclosure.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const PUBLIC_BUCKET = 'clinic-cases-public';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      CORS,
      extraHeaders || {}
    ),
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'GET') {
      return json(405, { ok: false, error: 'method not allowed' });
    }

    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !ANON_KEY) {
      return json(500, { ok: false, error: 'server not configured' });
    }

    const params = event.queryStringParameters || {};
    const clinicId = (params.clinic_id || '').trim();
    if (!clinicId) {
      return json(400, { ok: false, error: 'clinic_id is required' });
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_clinic_gallery`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_clinic_id: clinicId })
    });

    if (!res.ok) {
      const detail = await res.text();
      return json(502, { ok: false, error: `gallery unavailable: ${detail}` });
    }

    const rows = await res.json();
    const cases = (Array.isArray(rows) ? rows : []).map((r) => ({
      case_id: r.case_id,
      treatment: r.treatment,
      angle: r.angle,
      phenotype: r.phenotype,
      before_url: `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${r.published_before_path}`,
      after_url: `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${r.published_after_path}`,
      created_at: r.created_at
    }));

    return json(
      200,
      { ok: true, clinic_id: clinicId, count: cases.length, cases },
      // Short cache: an unpublish should disappear quickly, not linger for hours.
      { 'Cache-Control': 'public, max-age=60, s-maxage=60' }
    );
  } catch (err) {
    console.error('clinic-gallery failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

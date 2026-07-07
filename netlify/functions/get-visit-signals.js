// netlify/functions/get-visit-signals.js
//
// Batch version of get-visit-signal (singular). The directory grid renders many
// clinic cards at once and needs the would-return counts for all of them in one
// request, rather than one HTTP call per card.
//
// POST /api/get-visit-signals
//   body: { clinic_ids: ["123", "456", ...] }
//   ->    { signals: [ { clinic_id, yes_count, no_count, total } ] }
//
// M36 moderation model (identical to the singular function):
//   A vote counts unless it has been HIDDEN. `flagged` means "needs review" and
//   still counts. Exclusion keys off `hidden=not.is.true` only.
//   Requires the `hidden` column on clinic_visits.
//
// clinic_visits.clinic_id is TEXT. The `in.(...)` filter values are passed as
// strings and URL-encoded.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const clinicIds = Array.isArray(body.clinic_ids) ? body.clinic_ids : [];
  if (!clinicIds.length) {
    return { statusCode: 200, body: JSON.stringify({ signals: [] }) };
  }

  // Normalise to strings (clinic_id is TEXT), dedupe, and cap to a sane batch
  // size so a malformed request can't ask for tens of thousands of rows.
  const ids = [...new Set(clinicIds.map(id => String(id)))].slice(0, 200);

  // PostgREST in.(...) list. Each value is URL-encoded; commas separate values.
  const inList = ids.map(id => encodeURIComponent(id)).join(',');

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clinic_visits?clinic_id=in.(${inList})&hidden=not.is.true&select=clinic_id,would_return`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!res.ok) {
    console.error('get-visit-signals fetch error:', await res.text());
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }

  const rows = await res.json();

  // Tally per clinic_id.
  const tally = {};
  for (const id of ids) tally[id] = { clinic_id: id, yes_count: 0, no_count: 0, total: 0 };
  for (const r of rows) {
    const t = tally[String(r.clinic_id)];
    if (!t) continue;
    if (r.would_return === 'yes') t.yes_count++;
    else if (r.would_return === 'no') t.no_count++;
    t.total++;
  }

  // Same short cache window as the singular function.
  const headers = { 'Cache-Control': 'public, max-age=10' };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ signals: Object.values(tally) })
  };
};

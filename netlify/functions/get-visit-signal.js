// netlify/functions/get-visit-signal.js
//
// Returns the public would-return signal for a clinic.
//
// M36 - moderation model.
// A vote counts publicly unless it has been HIDDEN (by an admin after
// review, or by a hard integrity rule). The old behaviour excluded any
// `flagged` vote; `flagged` now means "needs review" and still counts.
// Exclusion is driven solely by `hidden`.
//
//   old:  &flagged=not.is.true   (suspicion = excluded)
//   new:  &hidden=not.is.true    (only a decision removes a vote)
//
// Three display phases based on counted response volume:
//
//   0 votes      -> { signal: null, ghost: true }
//   1-19 votes   -> { signal: { yes, no, total, phase: 'counts' } }
//   20+ votes    -> { signal: { yes, no, total, pct, phase: 'pct' } }
//
// Query: GET /api/get-visit-signal?clinic_id=123
//
// NOTE: requires the `hidden` column on clinic_visits (see M36 schema step).
// Deploy the ALTER TABLE first, or this query returns a 500 for every clinic.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const clinic_id = event.queryStringParameters?.clinic_id;
  if (!clinic_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing clinic_id' }) };
  }

  // clinic_visits.clinic_id is TEXT. eq. on a text column is correct here.
  // Exclusion now keys off `hidden`, not `flagged`. `not.is.true` keeps the
  // query NULL-safe: any row where hidden is false OR null is counted.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clinic_visits?clinic_id=eq.${encodeURIComponent(clinic_id)}&hidden=not.is.true&select=would_return`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!res.ok) {
    console.error('get-visit-signal fetch error:', await res.text());
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }

  const rows  = await res.json();
  const total = rows.length;
  const yes   = rows.filter(r => r.would_return === 'yes').length;
  const no    = rows.filter(r => r.would_return === 'no').length;

  // Lowered from 30s to 10s for M36. Votes now count by default, so a real
  // patient who just voted expects to see the signal move quickly. 10s keeps
  // most of the CDN/DB relief while cutting the "did my vote register?" lag.
  // CDN edge caching can still add a little on top of this.
  const headers = { 'Cache-Control': 'public, max-age=10' };

  // Phase 0 - no votes yet
  if (total === 0) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ signal: null, ghost: true })
    };
  }

  // Phase 1 - counts only (1-19 votes)
  if (total < 20) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        signal: { yes, no, total, phase: 'counts' }
      })
    };
  }

  // Phase 2 - percentage primary + counts supporting (20+ votes)
  const scored = yes + no;
  const pct    = scored > 0 ? Math.round((yes / scored) * 100) : null;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      signal: { yes, no, total, pct, phase: 'pct' }
    })
  };
};

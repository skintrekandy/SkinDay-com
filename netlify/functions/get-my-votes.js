// netlify/functions/get-my-votes.js
//
// Returns the authenticated user's own votes for a set of clinics, so the
// directory grid can show which button (yes/no) the user already pressed.
//
// POST /api/get-my-votes
//   body: { clinic_ids: ["123", ...], access_token }
//   ->    { votes: [ { clinic_id, would_return } ] }
//
// The frontend reads `would_return` as a BOOLEAN (v.would_return ? yes : no),
// so this function converts the stored string ('yes'/'no') to true/false.
// Only 'yes' and 'no' votes are returned; 'unsure' rows are omitted since the
// grid has no state for them.
//
// This is the user's OWN vote, so `hidden`/`flagged` are irrelevant here: a user
// always sees the state of the button they pressed, even if it is under review.
//
// Unauthenticated requests get an empty list (200), not a 401: the grid calls
// this opportunistically and simply shows no pressed state when signed out.
//
// clinic_visits.clinic_id and user_id are TEXT / uuid. eq/in filters use strings.

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

  const clinicIds   = Array.isArray(body.clinic_ids) ? body.clinic_ids : [];
  const accessToken = body.access_token;

  // Signed out or nothing to look up -> empty, not an error.
  if (!accessToken || !clinicIds.length) {
    return { statusCode: 200, body: JSON.stringify({ votes: [] }) };
  }

  // Verify the user from their JWT.
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${accessToken}`
    }
  });
  if (!userRes.ok) {
    // Bad/expired token -> treat as signed out, empty list.
    return { statusCode: 200, body: JSON.stringify({ votes: [] }) };
  }
  const userData = await userRes.json();
  const userId   = userData?.id;
  if (!userId) {
    return { statusCode: 200, body: JSON.stringify({ votes: [] }) };
  }

  const ids    = [...new Set(clinicIds.map(id => String(id)))].slice(0, 200);
  const inList = ids.map(id => encodeURIComponent(id)).join(',');

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/clinic_visits?user_id=eq.${encodeURIComponent(userId)}&clinic_id=in.(${inList})&select=clinic_id,would_return`,
    {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!res.ok) {
    console.error('get-my-votes fetch error:', await res.text());
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }

  const rows = await res.json();

  const votes = rows
    .filter(r => r.would_return === 'yes' || r.would_return === 'no')
    .map(r => ({
      clinic_id:     String(r.clinic_id),
      would_return:  r.would_return === 'yes'   // string -> boolean for the grid
    }));

  // Per-user data: never cache at the CDN.
  const headers = { 'Cache-Control': 'private, no-store' };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ votes })
  };
};

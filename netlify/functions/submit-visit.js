// netlify/functions/submit-visit.js
//
// Inserts a clinic_visits row for the authenticated user.
// Enforces one response per user per clinic via DB unique constraint
// (one_response_per_user_per_clinic). This hard rule never changes.
//
// M36 - auth contract cleanup.
// Every authentication failure now returns 401 with a single stable shape:
//   { error: 'auth_required', message: 'Sign in to record your visit.' }
// so the client can reliably show a "sign in to vote" prompt and revert its
// optimistic state instead of falsely showing success. A missing access_token
// is now treated as an auth failure (401), not a generic bad request (400).
//
// The DB trigger may set `flagged = true` on soft-signal submissions. Under
// the M36 moderation model `flagged` means "needs admin review," NOT excluded.
// Exclusion from the public count is driven solely by the `hidden` column.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Single source of truth for the auth-failure response, so all three auth
// branches below return an identical, client-parseable shape.
const AUTH_REQUIRED = {
  statusCode: 401,
  body: JSON.stringify({
    error:   'auth_required',
    message: 'Sign in to record your visit.'
  })
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { clinic_id, visit_month, treatment_type, would_return, access_token } = body;

  // Validate required NON-AUTH fields first (structural correctness).
  if (!clinic_id || !would_return) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const validTreatments = ['Botox', 'Filler', 'Laser', 'Other'];
  const validResponses  = ['yes', 'no', 'unsure'];

  if (treatment_type && !validTreatments.includes(treatment_type)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid treatment_type' }) };
  }
  if (!validResponses.includes(would_return)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid would_return value' }) };
  }

  // Auth check. A missing token is an auth failure, not a bad request, so the
  // client shows the sign-in prompt rather than a generic error.
  if (!access_token) {
    return AUTH_REQUIRED;
  }

  // Verify JWT and get user via Supabase Auth API.
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${access_token}`
    }
  });

  if (!userRes.ok) {
    return AUTH_REQUIRED;
  }

  const userData = await userRes.json();
  const userId   = userData?.id;

  if (!userId) {
    return AUTH_REQUIRED;
  }

  // Insert row
  const insertRes = await fetch(
    `${SUPABASE_URL}/rest/v1/clinic_visits`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({
        user_id:           userId,
        clinic_id:         String(clinic_id),
        visit_month:       visit_month || null,
        treatment_type:    treatment_type || null,
        would_return,
        response_source:   'immediate',
        confidence_weight: 1.0
      })
    }
  );

  if (!insertRes.ok) {
    const errText = await insertRes.text();

    // Unique constraint violation - already submitted for this clinic.
    if (insertRes.status === 409 || errText.includes('23505')) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'already_submitted' })
      };
    }

    console.error('submit-visit insert error:', errText);
    return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true })
  };
};

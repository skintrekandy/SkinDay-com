// netlify/functions/submit-visit.js
//
// Inserts a clinic_visits row for the authenticated user.
// Enforces one response per user per clinic via DB unique constraint.
// Auto-flag for rapid submissions handled by DB trigger.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── Parse body ──
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { clinic_id, visit_month, treatment_type, would_return, access_token } = body;

  // ── Validate required fields ──
  if (!clinic_id || !would_return || !access_token) {
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

  // ── Verify JWT and get user via Supabase Auth admin API ──
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${access_token}`
    }
  });

  if (!userRes.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const userData = await userRes.json();
  const userId   = userData?.id;

  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  // ── Insert row ──
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

    // Unique constraint violation — already submitted for this clinic
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

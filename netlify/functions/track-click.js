exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { clinic_id, click_type, neighbourhood } = JSON.parse(event.body || '{}');

    if (!clinic_id || !click_type) {
      return { statusCode: 400, body: 'Missing required fields' };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    await fetch(`${SUPABASE_URL}/rest/v1/click_tracking`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        clinic_id: Number(clinic_id),
        click_type,
        neighbourhood: neighbourhood || null
      })
    });

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    // Silent fail — never block the redirect
    return { statusCode: 200, body: 'ok' };
  }
};

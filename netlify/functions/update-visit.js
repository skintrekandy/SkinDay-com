// netlify/functions/update-visit.js
//
// Handles vote changes for authenticated users.
// POST body: { clinic_id, action, would_return?, access_token }
//
// action = 'delete' → remove vote (user clicked same button = undo)
// action = 'update' → change vote (user clicked opposite button = switch)

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// M36: single stable auth-failure shape, matching submit-visit.js, so the
// client can branch on 401 the same way for every vote action.
const AUTH_REQUIRED = {
  statusCode: 401,
  body: JSON.stringify({
    error:   'auth_required',
    message: 'Sign in to record your vote.'
  })
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { clinic_id, action, would_return, access_token } = body;

  if (!clinic_id || !action) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  if (!access_token) {
    return AUTH_REQUIRED;
  }

  if (!['delete', 'update'].includes(action)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  if (action === 'update' && !['yes', 'no'].includes(would_return)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid would_return value' }) };
  }

  // Verify user
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${access_token}` }
  });
  if (!userRes.ok) return AUTH_REQUIRED;
  const { id: userId } = await userRes.json();
  if (!userId) return AUTH_REQUIRED;

  if (action === 'delete') {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/clinic_visits?user_id=eq.${userId}&clinic_id=eq.${encodeURIComponent(String(clinic_id))}`,
      {
        method: 'DELETE',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        }
      }
    );
    if (!res.ok) {
      const err = await res.text();
      console.error('update-visit delete error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, action: 'deleted' }) };
  }

  if (action === 'update') {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/clinic_visits?user_id=eq.${userId}&clinic_id=eq.${encodeURIComponent(String(clinic_id))}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ would_return })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      console.error('update-visit patch error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, action: 'updated' }) };
  }
};

// netlify/functions/submit-claim.js
// Receives clinic ownership claims from skinday-claim.html.
// Inserts a 'pending' row into the claims table.
// Sends email notification to admin via Resend.
//
// POST /api/submit-claim
// Body (JSON): { clinic_id, clinic_name, clinic_neighbourhood, owner_name, owner_email, owner_role }
// Response: { success: true } | { error: string }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REQUIRED_FIELDS = ['clinic_id', 'clinic_name', 'owner_name', 'owner_email', 'owner_role'];

// M23: this function is now deployed on skinday.com as well as skinday.ca, and
// both write to the same claims table. Nothing here needs to branch on country,
// but the notification should SAY which country the claim came from, because
// the review step and the portal the clinic ends up in both depend on it.
const ADMIN_REVIEW_URL = process.env.ADMIN_REVIEW_URL || 'https://skinday.ca/skinday-admin.html';

// Best effort. A claim is not worth failing over a label in an email.
async function lookupCountry(clinicId) {
  try {
    const { data } = await supabase
      .from('clinics')
      .select('country')
      .eq('id', String(clinicId))
      .maybeSingle();
    return data?.country || null;
  } catch (err) {
    console.error('country lookup failed:', err.message);
    return null;
  }
}

// For chains: check each location for existing claims, return first conflict found
async function checkChainConflicts(clinicIds) {
  for (const id of clinicIds) {
    const { data } = await supabase
      .from('claims')
      .select('clinic_id, clinic_name, status')
      .eq('clinic_id', String(id))
      .in('status', ['pending', 'approved'])
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

// Send email via Resend
async function sendNotification(claim, country) {
  const countryTag = country ? ` [${String(country).toUpperCase()}]` : '';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'SkinDay <onboarding@resend.dev>',
        to:   process.env.ADMIN_EMAIL,
        subject: claim.is_chain
          ? `New chain claim (${JSON.parse(claim.chain_clinic_ids || '[]').length} locations) — ${claim.clinic_name}${countryTag}`
          : `New clinic claim — ${claim.clinic_name}${countryTag}`,
        html: `
          <p>A new clinic claim has been submitted${claim.is_chain ? ' <strong>(chain/group)</strong>' : ''}.</p>
          <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
            <tr><td style="padding:6px 16px 6px 0;color:#888">Primary clinic</td><td><strong>${claim.clinic_name}</strong>${claim.clinic_neighbourhood ? ` — ${claim.clinic_neighbourhood}` : ''}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#888">Primary ID</td><td>${claim.clinic_id}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#888">Country</td><td>${country || 'unknown'}</td></tr>
            ${claim.is_chain && claim.chain_clinic_ids ? `<tr><td style="padding:6px 16px 6px 0;color:#888">All location IDs</td><td>${JSON.parse(claim.chain_clinic_ids).join(', ')}</td></tr>` : ''}
            <tr><td style="padding:6px 16px 6px 0;color:#888">Owner</td><td>${claim.owner_name}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#888">Email</td><td>${claim.owner_email}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#888">Role</td><td>${claim.owner_role}</td></tr>
          </table>
          <p style="margin-top:24px">
            <a href="${ADMIN_REVIEW_URL}" style="background:#C8725A;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-family:sans-serif;font-size:14px">
              Review in Admin Dashboard →
            </a>
          </p>
        `
      })
    });
  } catch (err) {
    // Non-fatal — claim is already saved. Just log.
    console.error('Resend notification failed:', err.message);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Validate required fields
  const missing = REQUIRED_FIELDS.filter(f => !body[f] || String(body[f]).trim() === '');
  if (missing.length > 0) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` })
    };
  }

  // Basic email format check
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(body.owner_email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address' }) };
  }

  const isChain       = body.is_chain === true;
  const chainIds      = isChain && Array.isArray(body.chain_clinic_ids) && body.chain_clinic_ids.length >= 2
                          ? body.chain_clinic_ids.map(String)
                          : null;

  // Conflict check — for chains, verify every location; for single, just the one
  if (isChain && chainIds) {
    const conflict = await checkChainConflicts(chainIds);
    if (conflict?.status === 'approved') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: `${conflict.clinic_name} has already been claimed.` }) };
    }
    if (conflict?.status === 'pending') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: `A claim for ${conflict.clinic_name} is already under review.` }) };
    }
  } else {
    const { data: existing } = await supabase
      .from('claims')
      .select('id, status')
      .eq('clinic_id', String(body.clinic_id))
      .in('status', ['pending', 'approved'])
      .maybeSingle();

    if (existing?.status === 'approved') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'This clinic has already been claimed.' }) };
    }
    if (existing?.status === 'pending') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'A claim for this clinic is already under review.' }) };
    }
  }

  // Insert claim — chain_clinic_ids stored as JSON array text
  const claim = {
    clinic_id:            String(body.clinic_id),
    clinic_name:          body.clinic_name.trim(),
    clinic_neighbourhood: body.clinic_neighbourhood?.trim() || null,
    owner_name:           body.owner_name.trim(),
    owner_email:          body.owner_email.trim().toLowerCase(),
    owner_role:           body.owner_role.trim(),
    is_chain:             isChain,
    chain_clinic_ids:     chainIds ? JSON.stringify(chainIds) : null,
    status:               'pending'
  };

  const { error } = await supabase.from('claims').insert(claim);

  if (error) {
    console.error('submit-claim insert error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to submit claim.' }) };
  }

  // Send admin notification (non-blocking)
  const country = await lookupCountry(claim.clinic_id);
  await sendNotification(claim, country);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, message: 'Claim submitted. You\'ll hear from us within 1–2 business days.' })
  };
};

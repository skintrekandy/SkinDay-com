// netlify/functions/clinic-enterprise-contact.js
//
// Enterprise is a conversation, not a checkout. This takes the short form from the
// billing panel and emails it to us through Resend, with reply-to set to the
// clinic's own address so a reply goes straight back to them. Owner only, proved
// against the database, not the browser.
//
// Env
//   RESEND_API_KEY            (optional; without it the inquiry is refused clearly)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const { createClient } = require('@supabase/supabase-js');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FROM = 'SkinDay <hello@skinday.com>';
const TO = 'hello@skinday.com';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  if (!SUPABASE_URL || !ANON_KEY) return json(500, { error: 'missing supabase env' });

  const headers = event.headers || {};
  const jwt = (headers.authorization || headers.Authorization || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'missing bearer token' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'invalid json body' }); }

  const clinicId = body.clinicId ? String(body.clinicId) : '';
  const name = (body.name ? String(body.name) : '').slice(0, 200);
  const email = (body.email ? String(body.email) : '').trim().slice(0, 200);
  const locations = (body.locations ? String(body.locations) : '').slice(0, 100);
  const message = (body.message ? String(body.message) : '').slice(0, 4000);
  if (!clinicId) return json(400, { error: 'clinicId is required' });
  if (!email) return json(400, { error: 'an email is required so we can reply' });

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Owner only, proved against the database. Billing is an owner concern.
  const { data: mem } = await asUser
    .from('clinic_memberships')
    .select('role')
    .eq('clinic_id', clinicId)
    .eq('status', 'active')
    .is('revoked_at', null)
    .maybeSingle();

  if (!mem) return json(403, { error: 'not a member of this clinic' });
  if (mem.role !== 'owner') return json(403, { error: 'only an owner can send this' });

  // The clinic's own name, for context in the email.
  let clinicName = clinicId;
  try {
    const { data: c } = await asUser.from('clinics').select('name').eq('id', clinicId).maybeSingle();
    if (c && c.name) clinicName = c.name;
  } catch (e) { /* the id is a fine fallback */ }

  if (!RESEND_API_KEY) {
    return json(200, {
      ok: false,
      reason: 'email is not configured yet',
      hint: 'Please email hello@skinday.com directly and mention Enterprise.'
    });
  }

  const html = [
    '<div style="font-family:Helvetica,Arial,sans-serif;color:#1C1714;font-size:15px;line-height:1.6;">',
    '<h2 style="font-family:Georgia,serif;">Enterprise inquiry</h2>',
    '<p><strong>Clinic:</strong> ' + escapeHtml(clinicName) + ' (id ' + escapeHtml(clinicId) + ')</p>',
    '<p><strong>Name:</strong> ' + escapeHtml(name || 'not given') + '</p>',
    '<p><strong>Email:</strong> ' + escapeHtml(email) + '</p>',
    '<p><strong>Locations:</strong> ' + escapeHtml(locations || 'not given') + '</p>',
    '<p><strong>Message:</strong><br>' + escapeHtml(message || 'none').replace(/\n/g, '<br>') + '</p>',
    '</div>'
  ].join('');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [TO],
        reply_to: email,
        subject: 'Enterprise inquiry: ' + clinicName,
        html
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json(200, {
        ok: false,
        reason: 'email did not send (' + res.status + ')',
        detail: detail.slice(0, 200),
        hint: 'Please email hello@skinday.com directly and mention Enterprise.'
      });
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(200, {
      ok: false,
      reason: 'email error',
      detail: (err && err.message) || String(err),
      hint: 'Please email hello@skinday.com directly and mention Enterprise.'
    });
  }
};

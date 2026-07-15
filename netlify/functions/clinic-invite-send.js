// netlify/functions/clinic-invite-send.js
//
// Sends a branded invitation email through Resend.
//
// The email is a convenience. The token is the authority. This function creates
// the invitation via invite_clinic_member (which enforces owner-only, seats, the
// one-admin rule, and the domain flag) and then emails the resulting link. If the
// email fails, the invitation still exists and the owner can copy the link. The
// email never carries any grant of access on its own; clicking it lands on the
// join page, which redeems the token, which is the only thing that adds a member.
//
// Metadata is decoration. A recipient who somehow altered their own account
// metadata still cannot join a clinic they were not invited to, because
// accept_clinic_invitation checks the token and requires the signed-in email to
// match the invited one. Nothing here trusts anything the browser or the user
// can set.
//
// Until skinday.com is verified in Resend and RESEND_API_KEY is set, this returns
// the invitation and its link with emailed:false, and the portal shows the link
// as the primary path. Nothing breaks while the domain is pending.
//
// Env
//   RESEND_API_KEY            (optional until the domain is verified)
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const { createClient } = require('@supabase/supabase-js');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const FROM = 'SkinDay <hello@skinday.com>';
const REPLY_TO = 'hello@skinday.com';

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

function emailHtml(clinicName, roleLabel, link) {
  const clinic = escapeHtml(clinicName);
  const role = escapeHtml(roleLabel);
  // Inline styles only. Email clients strip <style> and ignore external CSS.
  return [
    '<!DOCTYPE html><html><body style="margin:0;background:#FAF7F2;font-family:Helvetica,Arial,sans-serif;color:#1C1714;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:40px 0;"><tr><td align="center">',
    '<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #EAE2D8;">',
    '<tr><td style="padding:34px 40px 0;">',
    '<div style="font-family:Georgia,serif;font-size:26px;font-weight:600;color:#1C1714;">Skin<span style="color:#C9A96E;">Day</span></div>',
    '</td></tr>',
    '<tr><td style="padding:26px 40px 8px;">',
    '<div style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#1C1714;">You have been invited to join ' + clinic + ' on SkinDay.</div>',
    '</td></tr>',
    '<tr><td style="padding:6px 40px 0;font-size:15px;line-height:1.6;color:#3a3330;">',
    'You have been added as <strong>' + role + '</strong>. Accept below to sign in and join the team. The invitation is for this email address only, and it expires in 14 days.',
    '</td></tr>',
    '<tr><td style="padding:28px 40px;">',
    '<a href="' + link + '" style="display:inline-block;background:#1C1714;color:#FAF7F2;text-decoration:none;padding:14px 28px;font-size:15px;">Accept invitation</a>',
    '</td></tr>',
    '<tr><td style="padding:0 40px 34px;font-size:12.5px;line-height:1.6;color:#8A7B72;">',
    'If the button does not work, paste this into your browser:<br>',
    '<span style="color:#8A7B72;word-break:break-all;">' + escapeHtml(link) + '</span>',
    '</td></tr>',
    '<tr><td style="padding:18px 40px;border-top:1px solid #EAE2D8;font-size:12px;color:#B5A89F;">',
    'If you were not expecting this, you can ignore it. Nothing happens until you accept.',
    '</td></tr>',
    '</table></td></tr></table></body></html>'
  ].join('');
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
  const invitationId = body.invitationId ? String(body.invitationId) : '';
  let email = body.email ? String(body.email).trim() : '';
  const role = body.role ? String(body.role) : 'staff';
  if (!clinicId) return json(400, { error: 'clinicId is required' });

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let inv;

  if (invitationId) {
    // Resend rotates: rotate_invitation issues a new token on the same invitation
    // row and returns it. Any earlier link stops resolving, because its hash no
    // longer matches, which is the safer behavior; the new link is the one that
    // works, and an old link degrades to the join page's "ask for a new one".
    // Owner only, so an admin who tries to resend gets a clear refusal.
    const { data: rotated, error: rErr } = await asUser.rpc('rotate_invitation', {
      p_clinic_id: clinicId, p_invitation_id: invitationId
    });
    if (rErr) return json(403, { error: rErr.message });
    if (!rotated) return json(404, { error: 'that invitation is no longer pending' });
    inv = { token: rotated.token, role: rotated.role, email: rotated.email };
    email = rotated.email;
  } else {
    if (!email) return json(400, { error: 'email is required' });
    // Create the invitation. This RPC is the gate: owner-only, seat limit, one
    // admin, domain flag. Its errors are the ones the owner should see.
    const { data: created, error: invErr } = await asUser.rpc('invite_clinic_member', {
      p_clinic_id: clinicId, p_email: email, p_role: role
    });
    if (invErr) return json(403, { error: invErr.message });
    inv = created;
  }

  const origin =
    headers.origin || headers.Origin ||
    ('https://' + (headers.host || 'skinday.com'));
  const link = origin + '/join-clinic?token=' + encodeURIComponent(inv.token);

  // The clinic's own name, for the email subject and body.
  let clinicName = 'a clinic on SkinDay';
  try {
    const { data: c } = await asUser
      .from('clinics').select('name').eq('id', clinicId).maybeSingle();
    if (c && c.name) clinicName = c.name;
  } catch (e) { /* the generic name is a fine fallback */ }

  const roleLabel = role === 'admin' ? 'an admin' : 'a staff member';

  // No key, or domain not verified yet: the invitation exists, the link works,
  // the email simply has not been sent. The portal shows the link.
  if (!RESEND_API_KEY) {
    return json(200, {
      ok: true,
      emailed: false,
      reason: 'email is not configured yet',
      invitation: inv,
      link
    });
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        reply_to: REPLY_TO,
        subject: 'You have been invited to join ' + clinicName + ' on SkinDay',
        html: emailHtml(clinicName, roleLabel, link)
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // The invitation still stands. Do not fail the whole call over the email;
      // hand back the link so the owner can send it themselves.
      return json(200, {
        ok: true,
        emailed: false,
        reason: 'email did not send (' + res.status + ')',
        detail: detail.slice(0, 200),
        invitation: inv,
        link
      });
    }

    return json(200, { ok: true, emailed: true, invitation: inv, link });
  } catch (err) {
    return json(200, {
      ok: true,
      emailed: false,
      reason: 'email error',
      detail: (err && err.message) || String(err),
      invitation: inv,
      link
    });
  }
};

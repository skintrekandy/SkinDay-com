// netlify/functions/submit-report.js
//
// Visitor-submitted corrections and missing-clinic tips.
//
// ⚠️ WHY THIS IS NOT submit-claim.js.
// A report is not a claim. A claim asserts ownership, needs an owner name,
// email and role, and on approval creates an auth user with write access to a
// clinic. A report grants nothing and usually has no owner behind it at all.
// The two were previously conflated: us-state.html POSTed reports to
// /api/submit-claim with empty owner fields, which that function rejected as
// missing required fields on every single submission. The calls sat inside a
// try that ignored the response, so every visitor was thanked for a report
// that was never recorded. This endpoint exists so a report can be stored on
// its own terms, and so a failure is visible instead of swallowed.
//
// POST /api/submit-report
// Body: { kind: 'error' | 'missing', clinic_id?, clinic_name?, locality?,
//         country?, source_url?, reporter_email?, note? }
// Response: { success: true } | { error: string }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX = { clinic_name: 200, locality: 120, note: 500, source_url: 500 };

// A repeat report about the same clinic inside this window is dropped. It is
// the cheap half of spam control; the expensive half would be storing the
// visitor's IP, which is personal data collected on an unauthenticated form
// and not worth holding for this.
const DEDUPE_HOURS = 24;

function clip(v, n) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, n) : null;
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

  const kind = String(body.kind || '').trim().toLowerCase();
  if (kind !== 'error' && kind !== 'missing') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'kind must be error or missing' }) };
  }

  const clinicId = clip(body.clinic_id, 64);
  let clinicName = clip(body.clinic_name, MAX.clinic_name);
  const email     = clip(body.reporter_email, 200);

  // An error report is about a clinic we list, so it needs the id.
  // A missing report is about one we do not, so it needs a name and a way to
  // reach whoever told us. These mirror the table's check constraint, and
  // failing here gives a readable message instead of a Postgres error.
  if (kind === 'error' && !clinicId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A correction needs a clinic id.' }) };
  }
  if (kind === 'missing') {
    if (!clinicName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please tell us the clinic name.' }) };
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
    }
  }

  // Trust the clinic row over whatever the page said. The page knows which
  // directory it is, but the row knows what the clinic actually is, and a
  // report filed under the wrong country is a report nobody finds.
  let country = clip(body.country, 32);
  if (clinicId) {
    try {
      const { data } = await supabase
        .from('clinics')
        .select('name, country')
        .eq('id', clinicId)
        .maybeSingle();
      if (data) {
        country = data.country || country;
        if (!clinicName) clinicName = clip(data.name, MAX.clinic_name);
      }
    } catch (err) {
      console.error('clinic lookup failed:', err.message);
    }
  }

  // Duplicate check. Returns success without inserting, so a double tap or a
  // bot gets the same response a real report does and learns nothing.
  try {
    const since = new Date(Date.now() - DEDUPE_HOURS * 3600 * 1000).toISOString();
    let q = supabase
      .from('clinic_reports')
      .select('id')
      .eq('kind', kind)
      .gte('created_at', since)
      .limit(1);
    q = clinicId ? q.eq('clinic_id', clinicId) : q.eq('clinic_name', clinicName);
    const { data: recent } = await q;
    if (recent && recent.length > 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
  } catch (err) {
    // A failed dedupe check must not block a real report.
    console.error('dedupe check failed:', err.message);
  }

  const row = {
    kind,
    clinic_id:      clinicId,
    clinic_name:    clinicName,
    locality:       clip(body.locality, MAX.locality),
    country,
    source_url:     clip(body.source_url, MAX.source_url),
    reporter_email: email,
    note:           clip(body.note, MAX.note)
  };

  const { error } = await supabase.from('clinic_reports').insert(row);

  if (error) {
    console.error('submit-report insert error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save that report.' }) };
  }

  // ⚠️ EMAIL ON 'missing' ONLY, and it is a deliberate asymmetry.
  // A missing-clinic tip arrives with an email address and is effectively a
  // lead worth acting on the same day. An error report is a one-tap button on
  // every card in the directory, and mailing those would train you to ignore
  // the inbox. Read them from clinic_reports where status = 'new' instead.
  if (kind === 'missing' && process.env.RESEND_API_KEY && process.env.ADMIN_EMAIL) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'SkinDay <onboarding@resend.dev>',
          to: process.env.ADMIN_EMAIL,
          subject: `Missing clinic${country ? ` [${String(country).toUpperCase()}]` : ''}: ${row.clinic_name}`,
          html: `
            <p>Someone told us about a clinic we do not list.</p>
            <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
              <tr><td style="padding:6px 16px 6px 0;color:#888">Clinic</td><td><strong>${row.clinic_name}</strong></td></tr>
              <tr><td style="padding:6px 16px 6px 0;color:#888">Where</td><td>${row.locality || 'not given'}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;color:#888">Country</td><td>${country || 'unknown'}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;color:#888">From</td><td>${row.reporter_email}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;color:#888">Page</td><td>${row.source_url || 'not given'}</td></tr>
            </table>`
        })
      });
    } catch (err) {
      // Non-fatal. The report is already saved.
      console.error('Resend notification failed:', err.message);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};

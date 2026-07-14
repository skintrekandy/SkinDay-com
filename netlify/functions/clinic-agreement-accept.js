// netlify/functions/clinic-agreement-accept.js
//
// SkinDay M13. Records that a clinic owner accepted an agreement.
//
// Why this is a function and not a direct RPC call from the browser
//   The IP address. A browser cannot be allowed to report its own address into
//   an evidentiary record, because the whole point of the record is that it is
//   evidence. The connection IP is observed here, server side, and passed to the
//   RPC. Everything else the RPC establishes for itself: who the caller is, from
//   their token, and what the document says, from the document.
//
//   The browser never supplies the content hash either. It is read off the
//   document row inside accept_agreement. If the page rendered something other
//   than what is stored, the acceptance still points at what is stored, and the
//   mismatch is discoverable rather than baked in.
//
// Env
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function clientIp(event) {
  const h = event.headers || {};
  // Netlify sets this and it is not spoofable by the client, unlike
  // x-forwarded-for, whose leftmost entry is whatever the caller wrote there.
  const direct = h['x-nf-client-connection-ip'];
  if (direct) return String(direct).trim();

  const fwd = h['x-forwarded-for'];
  if (fwd) {
    // If we must fall back, take the RIGHTMOST hop, which is the one our own
    // edge saw. The leftmost is caller-controlled.
    const parts = String(fwd).split(',').map(function (s) { return s.trim(); });
    return parts[parts.length - 1] || null;
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }
  if (!SUPABASE_URL || !ANON_KEY) {
    return json(500, { error: 'missing env: SUPABASE_URL, SUPABASE_ANON_KEY' });
  }

  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json(401, { error: 'missing bearer token' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { error: 'invalid json body' });
  }

  const clinicId = body.clinicId ? String(body.clinicId) : '';
  const documentId = body.documentId ? String(body.documentId) : '';

  if (!clinicId || !documentId) {
    return json(400, { error: 'clinicId and documentId are required' });
  }

  // The caller's own token. accept_agreement checks that they are an owner of
  // this clinic; nothing here takes body.clinicId on trust.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await asUser.rpc('accept_agreement', {
    p_clinic_id: clinicId,
    p_document_id: documentId,
    p_ip: clientIp(event),
    p_user_agent: headers['user-agent'] || headers['User-Agent'] || null
  });

  if (error) {
    // The owner-only gate lands here for anyone else, with the RPC's own wording,
    // which says why rather than just refusing.
    return json(403, { error: error.message });
  }

  return json(200, { ok: true, acceptance: data });
};

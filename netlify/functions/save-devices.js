const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// M23 - CLINIC-PUBLISHED DEVICES  (skinday.com)
//
// Writes the equipment list a clinic ticks in the portal Devices tab.
//
// THE RULE THIS FUNCTION IMPLEMENTS:
//   clinics.devices_published_at        set once the clinic publishes
//   clinic_devices.declared_at          set on each row the clinic ticked
//
// A clinic with devices_published_at set displays only its declared_at
// rows. Everything else stays in the table with its evidence intact and
// simply stops displaying for that clinic.
//
// ⚠️ WHAT THIS FUNCTION DELIBERATELY DOES NOT DO:
//
// 1. It NEVER DELETES a clinic_devices row. A device the clinic leaves
//    unticked has declared_at cleared, nothing more. The crawl row, its
//    first_seen date, its source_url and its matched_text all survive.
//
// 2. It NEVER CHANGES `source` ON AN EXISTING ROW. If the crawler found
//    a Morpheus8 and the clinic then confirms it, that row keeps
//    source='website' AND gains declared_at. Found by crawl and confirmed
//    by the owner is the strongest evidence pair we hold, and overwriting
//    source to 'clinic' would throw away the crawl half of it.
//
// 3. It NEVER SETS status='verified'. Self-declaration is not independent
//    verification, and verification is the paid tier of the manufacturer
//    product. Declared rows stay 'listed'.
//
// 4. It does NOT write clinic_device_events yet. The event vocabulary on
//    that table has not been read against its constraint, and a rejected
//    enum value would fail the whole save. declared_at timestamps record
//    what happened in the meantime, so nothing is lost permanently.
//
// ⚠️ THIS FILE IS FOR skinday.com AND IS SELF-CONTAINED ON PURPOSE.
// It shares no code with save-clinic.js so that the .ca and .com copies
// of that function can keep diverging without breaking device saves.
// ─────────────────────────────────────────────────────────────

// A clinic publishing more than this is a bug or an attack, not a clinic.
const MAX_DEVICES = 60;

// Resolve every clinic id this authenticated user owns.
// Chain accounts carry them in user_metadata (written by approve-claim.js).
// Single-location and legacy accounts fall back to the claims table.
async function resolveOwnedIds(supabase, user, userEmail) {
  const meta = user.user_metadata || {};
  if (Array.isArray(meta.clinic_ids) && meta.clinic_ids.length > 0) {
    return meta.clinic_ids.map(String);
  }

  const { data: claims } = await supabase
    .from('claims')
    .select('clinic_id, chain_clinic_ids')
    .eq('owner_email', userEmail)
    .limit(1);

  if (!claims || claims.length === 0) return [];

  let ids = [];
  if (claims[0].chain_clinic_ids) {
    try { ids = JSON.parse(claims[0].chain_clinic_ids).map(String); } catch { ids = []; }
  }
  if (ids.length === 0 && claims[0].clinic_id !== null && claims[0].clinic_id !== undefined) {
    ids = [String(claims[0].clinic_id)];
  }
  return ids;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const userToken = authHeader.replace('Bearer ', '');

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser(userToken);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }
    const userEmail = user.email;

    const body = JSON.parse(event.body || '{}');
    const { clinicId, deviceIds } = body;

    if (!clinicId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing clinicId' }) };
    }

    // ── OWNERSHIP ──
    const ownedIds = await resolveOwnedIds(supabase, user, userEmail);
    if (!ownedIds.includes(String(clinicId))) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // ── VALIDATE THE SUBMITTED LIST ──
    // Reference rows only. No free text ever reaches this table.
    if (!Array.isArray(deviceIds)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'deviceIds must be an array' }) };
    }
    if (deviceIds.length > MAX_DEVICES) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `A clinic cannot publish more than ${MAX_DEVICES} devices` }) };
    }

    const wanted = [];
    for (const raw of deviceIds) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid device id: ${raw}` }) };
      }
      if (!wanted.includes(n)) wanted.push(n);
    }

    // Every id must exist in device_reference. A stale or spoofed picker
    // must not be able to invent a device row.
    if (wanted.length > 0) {
      const { data: refRows, error: refError } = await supabase
        .from('device_reference')
        .select('id')
        .in('id', wanted);

      if (refError) {
        console.error('device_reference lookup failed:', refError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not validate devices' }) };
      }
      const known = new Set((refRows || []).map(r => Number(r.id)));
      const unknown = wanted.filter(id => !known.has(id));
      if (unknown.length > 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown device id(s): ${unknown.join(', ')}` }) };
      }
    }

    // ── READ WHAT ALREADY EXISTS FOR THIS CLINIC ──
    // Read before writing so existing rows are UPDATED in place rather than
    // upserted. An upsert with on-conflict would have to restate `source`,
    // which is exactly the column that must not be touched here.
    const { data: existing, error: existingError } = await supabase
      .from('clinic_devices')
      .select('id, device_id, declared_at')
      .eq('clinic_id', String(clinicId));

    if (existingError) {
      console.error('clinic_devices read failed:', existingError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read current devices' }) };
    }

    const existingRows = existing || [];
    const existingByDevice = new Map(existingRows.map(r => [Number(r.device_id), r]));

    const nowIso = new Date().toISOString();
    const today = nowIso.split('T')[0];

    // ── 1. NEW ROWS: devices the clinic ticked that we had no row for ──
    const toInsert = wanted
      .filter(id => !existingByDevice.has(id))
      .map(id => ({
        id: crypto.randomUUID(),
        clinic_id: String(clinicId),
        device_id: id,
        status: 'listed',
        source: 'clinic',
        first_seen: today,
        last_seen: today,
        declared_at: nowIso
      }));

    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from('clinic_devices')
        .insert(toInsert);
      if (insertError) {
        console.error('clinic_devices insert failed:', insertError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: insertError.message }) };
      }
    }

    // ── 2. CONFIRMED ROWS: we already had them, the clinic ticked them ──
    // Only declared_at and last_seen move. source, status, first_seen,
    // source_url and matched_text are left exactly as the crawl left them.
    const toConfirm = wanted
      .filter(id => existingByDevice.has(id))
      .map(id => existingByDevice.get(id).id);

    if (toConfirm.length > 0) {
      const { error: confirmError } = await supabase
        .from('clinic_devices')
        .update({ declared_at: nowIso, last_seen: today })
        .in('id', toConfirm);
      if (confirmError) {
        console.error('clinic_devices confirm failed:', confirmError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: confirmError.message }) };
      }
    }

    // ── 3. OMITTED ROWS: we have them, the clinic did not tick them ──
    // declared_at is CLEARED. The row is not deleted and nothing else on it
    // changes. Under the display rule it simply stops showing for a clinic
    // that has published, which is "superseded, not deleted".
    const toWithdraw = existingRows
      .filter(r => !wanted.includes(Number(r.device_id)) && r.declared_at !== null)
      .map(r => r.id);

    if (toWithdraw.length > 0) {
      const { error: withdrawError } = await supabase
        .from('clinic_devices')
        .update({ declared_at: null })
        .in('id', toWithdraw);
      if (withdrawError) {
        console.error('clinic_devices withdraw failed:', withdrawError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: withdrawError.message }) };
      }
    }

    // ── 4. FLIP THE CLINIC TO PUBLISHED ──
    // Written LAST, on purpose. If any step above failed we returned early,
    // so a clinic is never marked published over a half-written list. The
    // timestamp is refreshed on every save, which is what the change feed
    // reads to know when the clinic last confirmed its equipment.
    const { error: flagError } = await supabase
      .from('clinics')
      .update({ devices_published_at: nowIso })
      .eq('id', clinicId);

    if (flagError) {
      console.error('devices_published_at update failed:', flagError);
      return { statusCode: 500, headers, body: JSON.stringify({ error: flagError.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        published_at: nowIso,
        declared: wanted.length,
        added: toInsert.length,
        confirmed: toConfirm.length,
        withdrawn: toWithdraw.length
      })
    };

  } catch (e) {
    console.error('save-devices error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};

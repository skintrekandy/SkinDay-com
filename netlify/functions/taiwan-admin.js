// netlify/functions/taiwan-admin.js
//
// Backs the Taiwan tab in skinday-global-admin.html.
// Reads and writes clinic_technologies, doctors and clinic_doctors.
// Run taiwan-m18-schema.sql before deploying this.
//
// POST /.netlify/functions/taiwan-admin
// Auth: x-admin-secret, matched against ADMIN_SECRET or VISUALIZE_ADMIN_SECRET
//       so the single Global Admin sign-in covers this tab too.
//
// Every write is service-role, so RLS is bypassed here by design. Nothing in
// this file is reachable without the admin secret.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// The canonical device list. Raw names found on clinic sites get normalised
// to these before they are stored, so the patient-facing filter has one
// spelling per device. Served to the UI via the 'meta' action so the dropdown
// and the importer can never drift apart.
const CANONICAL_TECHNOLOGIES = [
  'Thermage FLX',
  'Ultherapy Prime',
  'Ultherapy',
  'Sofwave',
  'Ultraformer III',
  'Ultraformer MPT',
  'Picosure',
  'PicoWay',
  'Discovery Pico',
  'Fotona 4D',
  'CO2 Fractional Laser',
  'Clear + Brilliant',
  'Fraxel',
  'BBL / IPL',
  'Emsculpt Neo',
  'CoolSculpting'
];

const EVIDENCE_TYPES = [
  { value: 'manufacturer_directory', label: '原廠認證 Manufacturer verified' },
  { value: 'clinic_confirmed',       label: '診所確認 Clinic confirmed' },
  { value: 'clinic_declared',        label: '診所自述 Clinic declared' },
  { value: 'coming_soon',            label: '即將引進 Coming soon' }
];

const LICENSE_TYPES = ['西醫師', '中醫師', '牙醫師', '其他'];

// Fields a doctor row accepts from the form. Anything else is ignored, so a
// stray key in the payload can never write to mohw_verified by accident.
const DOCTOR_FIELDS = [
  'name_zh', 'name_romanized', 'license_type', 'license_number', 'practice_city',
  'board_cert', 'training', 'societies', 'kol_roles', 'publications',
  'source_url', 'evidence_type', 'review_status', 'published'
];

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const valid = [process.env.ADMIN_SECRET, process.env.VISUALIZE_ADMIN_SECRET].filter(Boolean);
  if (!secret || !valid.includes(secret)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
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

  const { action } = body;
  const ok  = (payload) => ({ statusCode: 200, headers, body: JSON.stringify(payload) });
  const bad = (code, msg) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) });

  try {

    // ── META ────────────────────────────────────────────────────────────────
    if (action === 'meta') {
      return ok({
        technologies:  CANONICAL_TECHNOLOGIES,
        evidence_types: EVIDENCE_TYPES,
        license_types: LICENSE_TYPES
      });
    }

    // ── STATS ───────────────────────────────────────────────────────────────
    // Drives the counters at the top of the tab. Each is a HEAD count, so it
    // stays cheap as the tables grow.
    if (action === 'stats') {
      const count = async (table, apply) => {
        let q = supabase.from(table).select('*', { count: 'exact', head: true });
        if (apply) q = apply(q);
        const { count: n, error } = await q;
        if (error) throw error;
        return n || 0;
      };

      const [clinics, verifiedDevices, declaredDevices, doctors, mohwDoctors, needsReview] =
        await Promise.all([
          count('clinics', q => q.eq('country', 'taiwan')),
          count('clinic_technologies', q => q.eq('evidence_type', 'manufacturer_directory')),
          count('clinic_technologies', q => q.neq('evidence_type', 'manufacturer_directory')),
          count('doctors'),
          count('doctors', q => q.eq('mohw_verified', true)),
          count('doctors', q => q.eq('review_status', 'needs_review'))
        ]);

      return ok({
        clinics, verifiedDevices, declaredDevices, doctors, mohwDoctors, needsReview
      });
    }

    // ── SEARCH CLINICS ──────────────────────────────────────────────────────
    if (action === 'search-clinics') {
      const q = clean(body.q);
      let query = supabase
        .from('clinics')
        .select('id,name,neighbourhood,region,website,rating,reviews,claimed,slug')
        .eq('country', 'taiwan')
        .order('reviews', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(body.limit) || 40, 100));

      // Matches Chinese or romanised names, plus the district field.
      if (q) query = query.or(`name.ilike.%${q}%,neighbourhood.ilike.%${q}%`);

      const { data, error } = await query;
      if (error) throw error;
      return ok({ clinics: data || [] });
    }

    // ── GET ONE CLINIC WITH ITS DEVICES AND DOCTORS ─────────────────────────
    if (action === 'get-clinic') {
      const clinicId = clean(body.clinic_id);
      if (!clinicId) return bad(400, 'Missing clinic_id');

      const [clinicRes, techRes, linkRes] = await Promise.all([
        supabase.from('clinics')
          .select('id,name,neighbourhood,region,website,phone,rating,reviews,claimed,slug')
          .eq('id', clinicId).maybeSingle(),
        supabase.from('clinic_technologies')
          .select('*').eq('clinic_id', clinicId).order('evidence_type').order('technology'),
        supabase.from('clinic_doctors')
          .select('id,title,doctor_id,doctors(*)').eq('clinic_id', clinicId)
      ]);

      if (clinicRes.error) throw clinicRes.error;
      if (!clinicRes.data)  return bad(404, 'Clinic not found');
      if (techRes.error)    throw techRes.error;
      if (linkRes.error)    throw linkRes.error;

      return ok({
        clinic: clinicRes.data,
        technologies: techRes.data || [],
        doctors: (linkRes.data || []).map(r => ({
          link_id: r.id, title: r.title, ...(r.doctors || {})
        }))
      });
    }

    // ── SAVE A DEVICE ───────────────────────────────────────────────────────
    if (action === 'save-technology') {
      const clinicId   = clean(body.clinic_id);
      const technology = clean(body.technology);
      if (!clinicId)   return bad(400, 'Missing clinic_id');
      if (!technology) return bad(400, 'Pick a device');

      const row = {
        clinic_id:           clinicId,
        technology,
        evidence_type:       clean(body.evidence_type) || 'clinic_declared',
        source_organization: clean(body.source_organization),
        source_url:          clean(body.source_url),
        verification_status: clean(body.verification_status),
        notes:               clean(body.notes),
        last_verified_at:    new Date().toISOString()
      };

      // A clinic-declared entry needs a citation, otherwise the badge is a
      // claim with nothing behind it.
      if (row.evidence_type === 'clinic_declared' && !row.source_url) {
        return bad(400, 'Clinic-declared devices need the URL of the clinic page that states it');
      }
      if (row.evidence_type === 'manufacturer_directory' && !row.source_organization) {
        return bad(400, 'Manufacturer-verified devices need the source organisation, for example Solta Taiwan');
      }

      if (body.id) {
        const { error } = await supabase.from('clinic_technologies').update(row).eq('id', body.id);
        if (error) throw error;
        return ok({ success: true, message: 'Device updated.' });
      }

      // Upsert on the (clinic_id, technology) unique index, so re-adding a
      // device refreshes it instead of failing.
      const { error } = await supabase
        .from('clinic_technologies')
        .upsert(row, { onConflict: 'clinic_id,technology' });
      if (error) throw error;
      return ok({ success: true, message: 'Device saved.' });
    }

    if (action === 'delete-technology') {
      if (!body.id) return bad(400, 'Missing id');
      const { error } = await supabase.from('clinic_technologies').delete().eq('id', body.id);
      if (error) throw error;
      return ok({ success: true, message: 'Device removed.' });
    }

    // ── SEARCH DOCTORS ──────────────────────────────────────────────────────
    if (action === 'search-doctors') {
      const q = clean(body.q);
      let query = supabase
        .from('doctors')
        .select('*')
        .order('mohw_verified', { ascending: true })
        .order('name_zh')
        .limit(Math.min(Number(body.limit) || 60, 200));

      if (q) query = query.or(`name_zh.ilike.%${q}%,name_romanized.ilike.%${q}%`);

      const filter = body.filter;
      if (filter === 'needs_review') query = query.eq('review_status', 'needs_review');
      if (filter === 'unverified')   query = query.eq('mohw_verified', false);
      if (filter === 'verified')     query = query.eq('mohw_verified', true);

      const { data, error } = await query;
      if (error) throw error;
      return ok({ doctors: data || [] });
    }

    // ── SAVE A DOCTOR ───────────────────────────────────────────────────────
    // Note this never touches mohw_verified. Only verify-doctor can set that,
    // so an attestation cannot be made by editing a text field.
    if (action === 'save-doctor') {
      const nameZh = clean(body.name_zh);
      if (!nameZh) return bad(400, 'A doctor needs a Chinese name');

      const row = {};
      DOCTOR_FIELDS.forEach(f => {
        if (body[f] !== undefined) {
          row[f] = (f === 'published') ? Boolean(body[f]) : clean(body[f]);
        }
      });
      row.name_zh = nameZh;
      if (!row.evidence_type) row.evidence_type = 'clinic_declared';

      // Publishing is what puts a doctor in front of patients, so it requires
      // a completed review.
      if (row.published === true && row.review_status && row.review_status !== 'approved') {
        return bad(400, 'Approve the doctor before publishing');
      }

      if (body.id) {
        const { error } = await supabase.from('doctors').update(row).eq('id', body.id);
        if (error) throw error;
        return ok({ success: true, id: body.id, message: 'Doctor updated.' });
      }

      const { data, error } = await supabase.from('doctors').insert(row).select('id').single();
      if (error) throw error;
      return ok({ success: true, id: data.id, message: 'Doctor added.' });
    }

    if (action === 'delete-doctor') {
      if (!body.id) return bad(400, 'Missing id');
      const { error } = await supabase.from('doctors').delete().eq('id', body.id);
      if (error) throw error;
      return ok({ success: true, message: 'Doctor deleted.' });
    }

    // ── MOHW ATTESTATION ────────────────────────────────────────────────────
    // The registry is CAPTCHA-gated, so this records a person's manual lookup.
    // verified_by is required: an attestation with nobody behind it is not an
    // attestation.
    if (action === 'verify-doctor') {
      const id         = body.id;
      const verifiedBy = clean(body.mohw_verified_by);
      if (!id)         return bad(400, 'Missing id');
      if (!verifiedBy) return bad(400, 'Record who performed the MOHW lookup');

      const row = {
        mohw_verified:    true,
        mohw_verified_at: new Date().toISOString(),
        mohw_verified_by: verifiedBy,
        evidence_type:    'mohw_registry'
      };
      if (clean(body.license_type))   row.license_type   = clean(body.license_type);
      if (clean(body.license_number)) row.license_number = clean(body.license_number);
      if (clean(body.practice_city))  row.practice_city  = clean(body.practice_city);

      const { error } = await supabase.from('doctors').update(row).eq('id', id);
      if (error) throw error;
      return ok({ success: true, message: 'MOHW verification recorded.' });
    }

    // Undo, for a lookup that was recorded against the wrong doctor.
    if (action === 'unverify-doctor') {
      if (!body.id) return bad(400, 'Missing id');
      const { error } = await supabase.from('doctors').update({
        mohw_verified: false,
        mohw_verified_at: null,
        mohw_verified_by: null,
        evidence_type: 'clinic_declared'
      }).eq('id', body.id);
      if (error) throw error;
      return ok({ success: true, message: 'MOHW verification cleared.' });
    }

    // ── LINK AND UNLINK ─────────────────────────────────────────────────────
    if (action === 'link-doctor') {
      const clinicId = clean(body.clinic_id);
      const doctorId = body.doctor_id;
      if (!clinicId || !doctorId) return bad(400, 'Missing clinic_id or doctor_id');

      const { error } = await supabase.from('clinic_doctors').upsert(
        { clinic_id: clinicId, doctor_id: doctorId, title: clean(body.title) },
        { onConflict: 'clinic_id,doctor_id' }
      );
      if (error) throw error;
      return ok({ success: true, message: 'Doctor linked to clinic.' });
    }

    if (action === 'unlink-doctor') {
      if (!body.link_id) return bad(400, 'Missing link_id');
      const { error } = await supabase.from('clinic_doctors').delete().eq('id', body.link_id);
      if (error) throw error;
      return ok({ success: true, message: 'Doctor unlinked.' });
    }

    return bad(400, 'Unknown action: ' + action);

  } catch (err) {
    console.error('taiwan-admin error:', action, err);
    // 42P01 is "relation does not exist", which here means the migration has
    // not been run. Say so plainly rather than returning a generic failure.
    if (err && err.code === '42P01') {
      return bad(500, 'Tables missing. Run taiwan-m18-schema.sql in Supabase first.');
    }
    return bad(500, err.message || 'Request failed');
  }
};

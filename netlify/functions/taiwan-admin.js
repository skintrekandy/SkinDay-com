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
// Canonical device names, Chinese first. Taiwanese patients search 鳳凰電波,
// not Thermage, so the Chinese term leads and the manufacturer name follows
// for clinics and for the English side of the site. This exact string is what
// gets stored in clinic_technologies.technology, so it is also what the
// device pages will be built on.
const CANONICAL_TECHNOLOGIES = [
  '鳳凰電波 Thermage FLX',
  '音波拉提 Ultherapy Prime',
  '索夫波 Sofwave',
  '海芙音波 Ultraformer III',
  '海芙音波 Ultraformer MPT',
  '玩美電波 Oligio',
  '蜂巢皮秒 PicoSure',
  '超皮秒 PicoWay',
  '探索皮秒 Discovery Pico',
  '飛梭雷射 Fraxel',
  '二氧化碳飛梭雷射 CO2 Fractional',
  '脈衝光 BBL / IPL',
  '增肌減脂 Emsculpt Neo',
  '冷凍減脂 CoolSculpting',
  '微波熱能止汗 miraDry'
];

// The device the Solta directory certifies.
const SOLTA_TECHNOLOGY = '鳳凰電波 Thermage FLX';

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


// ============================================================================
// SOLTA IMPORT
// The Solta Taiwan certified clinic list is pasted in from their site rather
// than scraped. The parser below turns those lines into rows, and the two
// actions match them against our Taiwan clinics by phone.
// ============================================================================
// Parser for the Solta Taiwan certified clinic list, as pasted from the site.
// Each line is: name, then phone, then address. Names contain spaces, digits,
// brackets and Latin text, so the address is found first (it always starts
// with a city token) and the phone is then taken from the right hand end of
// what remains. Whatever is left is the name.

const CITIES = [
  '台北市','臺北市','新北市','基隆市','桃園市','新竹市','新竹縣','苗栗縣',
  '台中市','臺中市','彰化縣','南投縣','雲林縣','嘉義市','嘉義縣',
  '台南市','臺南市','高雄市','屏東縣','宜蘭縣','花蓮縣','台東縣','臺東縣',
  '澎湖縣','金門縣','連江縣'
];
const CITY_RE = new RegExp('(' + CITIES.join('|') + ')');

// Allows the punctuation actually seen in the source: full width brackets,
// en dashes, extension markers, stray spaces.
const PHONE_TAIL_RE = /[（(]?0[\d\s\-–—()）#＃*]*\d\s*$/;

function normalisePhone(raw) {
  if (!raw) return null;
  // Anything after an extension marker is not part of the dialable number.
  const main = String(raw).split(/[#＃]/)[0];
  let digits = main.replace(/\D/g, '');
  // Our clinic rows came from Google and carry international format
  // (+886 2 2758 6308), while Solta lists local format (02-2758-6308).
  // Fold both to the local form or nothing matches.
  if (digits.startsWith('886')) digits = '0' + digits.slice(3);
  return digits || null;
}

// Taiwan landlines are 02 plus 8 digits, or another 2 or 3 digit area code
// plus 7. Mobiles are 09 plus 8. Anything else is a typo on the source site
// and gets flagged rather than silently matched.
function phoneLooksValid(digits) {
  if (!digits) return false;
  if (!digits.startsWith('0')) return false;
  if (digits.length < 9 || digits.length > 10) return false;
  // Taipei numbers are 02 plus eight digits. A short one is a typo on the
  // source site, for example 0-2321-8188 where the area code lost a digit.
  if (digits.startsWith('02') && digits.length !== 10) return false;
  return true;
}

function parseLine(line, lineNo) {
  const raw = String(line).replace(/\u00a0/g, ' ').trim();
  if (!raw) return null;

  const cityMatch = raw.match(CITY_RE);
  if (!cityMatch) {
    return { lineNo, raw, error: 'No city found in the address' };
  }

  const addressStart = cityMatch.index;
  const address = raw.slice(addressStart).trim();
  const head = raw.slice(0, addressStart).trim();

  const phoneMatch = head.match(PHONE_TAIL_RE);
  if (!phoneMatch) {
    return { lineNo, raw, name: head, address, error: 'No phone found' };
  }

  const phoneRaw = phoneMatch[0].trim();
  const name = head.slice(0, phoneMatch.index).trim();
  const phone = normalisePhone(phoneRaw);

  const districtMatch = address.match(/^(?:台北市|臺北市|新北市|基隆市|桃園市|新竹市|新竹縣|苗栗縣|台中市|臺中市|彰化縣|南投縣|雲林縣|嘉義市|嘉義縣|台南市|臺南市|高雄市|屏東縣|宜蘭縣|花蓮縣|台東縣|臺東縣|澎湖縣|金門縣|連江縣)([^\d\s]{1,4}?[區市鄉鎮])/);

  return {
    lineNo,
    raw,
    name,
    phone_raw: phoneRaw,
    phone,
    address,
    city: cityMatch[1],
    district: districtMatch ? districtMatch[1] : null,
    warning: name ? (phoneLooksValid(phone) ? null : 'Phone does not look like a Taiwan number') : 'Empty name'
  };
}

function parseSoltaList(text) {
  const rows = [];
  const errors = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const parsed = parseLine(line, i + 1);
    if (!parsed) return;
    if (parsed.error) errors.push(parsed);
    else rows.push(parsed);
  });
  return { rows, errors };
}
// Normalised name, for the fallback match when a phone number is missing or
// mistyped on the source site.
function nameKey(s) {
  return String(s || '').replace(/[\s\u3000()（）【】\[\]・‧,.、,。_-]/g, '').toLowerCase();
}

const SOLTA_SOURCE_URL = 'https://thermageflx.co/';
const SOLTA_ORG        = 'Solta Taiwan';

// Loads every Taiwan clinic once and indexes it by phone and by name.
async function loadTaiwanIndex(supabase) {
  const byPhone = new Map();
  const byName  = new Map();
  const all     = [];          // scanned for prefix and containment matches
  let withPhone = 0;
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('clinics')
      .select('id,name,phone,neighbourhood')
      .eq('country', 'taiwan')
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    data.forEach(c => {
      const p = normalisePhone(c.phone);
      if (p) {
        withPhone++;
        if (!byPhone.has(p)) byPhone.set(p, []);
        byPhone.get(p).push(c);
      }
      const n = nameKey(c.name);
      if (n) {
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(c);
        all.push({ clinic: c, key: n });
      }
    });
    if (data.length < page) break;
  }
  return { byPhone, byName, all, withPhone, total: all.length };
}

// Matches parsed Solta rows against the index. Phone is the strong key; an
// exact unique name is accepted as a fallback. Anything ambiguous is left
// unmatched on purpose, because a wrong match puts a manufacturer verified
// badge on the wrong clinic.
function matchSoltaRows(rows, index) {
  const matched = [];
  const unmatched = [];

  // Our clinic names came from Google and often carry a marketing tail:
  // "東區時尚美學診所｜皮秒雷射｜台北微整形｜鳳凰電波...". Solta lists the bare
  // name. So an exact name comparison misses clinics we genuinely hold, and a
  // prefix or containment check with a uniqueness requirement recovers them
  // without loosening the standard: if more than one clinic could be meant,
  // the row still goes to the queue.
  // Three characters, because plenty of real clinic names are that short
  // (植診所, 勤診所). The uniqueness requirement is what keeps it safe, not
  // the length.
  const MIN_KEY = 3;

  rows.forEach(r => {
    const key = nameKey(r.name);

    const byPhone = r.phone ? (index.byPhone.get(r.phone) || []) : [];
    if (byPhone.length === 1) {
      matched.push({ row: r, clinic: byPhone[0], method: 'phone' });
      return;
    }
    if (byPhone.length > 1) {
      unmatched.push({ row: r, reason: 'Phone matches ' + byPhone.length + ' clinics' });
      return;
    }

    const exact = index.byName.get(key) || [];
    if (exact.length === 1) {
      matched.push({ row: r, clinic: exact[0], method: 'name' });
      return;
    }
    if (exact.length > 1) {
      unmatched.push({ row: r, reason: 'Name matches ' + exact.length + ' clinics' });
      return;
    }

    if (key.length >= MIN_KEY) {
      const prefix = index.all.filter(x => x.key.startsWith(key));
      if (prefix.length === 1) {
        matched.push({ row: r, clinic: prefix[0].clinic, method: 'name start' });
        return;
      }
      if (prefix.length > 1) {
        unmatched.push({ row: r, reason: 'Name starts ' + prefix.length + ' clinic names' });
        return;
      }

      const contains = index.all.filter(x => x.key.indexOf(key) !== -1);
      if (contains.length === 1) {
        matched.push({ row: r, clinic: contains[0].clinic, method: 'name within' });
        return;
      }
      if (contains.length > 1) {
        unmatched.push({ row: r, reason: 'Name appears in ' + contains.length + ' clinic names' });
        return;
      }
    }

    unmatched.push({
      row: r,
      reason: r.phone ? 'No phone or name match' : 'No usable phone, no name match'
    });
  });
  return { matched, unmatched };
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

    // ── SOLTA IMPORT ────────────────────────────────────────────────────────
    // preview does not write. It parses, matches and reports, so the list can
    // be checked before anything lands on a public profile.
    if (action === 'solta-preview' || action === 'solta-commit') {
      const text = body.text;
      if (!text || !String(text).trim()) return bad(400, 'Paste the Solta list first');

      const technology = clean(body.technology) || SOLTA_TECHNOLOGY;
      const { rows, errors } = parseSoltaList(text);
      if (!rows.length) return bad(400, 'Nothing parsed. Check that each line is name, phone, then address.');

      const index = await loadTaiwanIndex(supabase);
      const { matched, unmatched } = matchSoltaRows(rows, index);
      const flagged = rows.filter(r => r.warning);

      const summary = {
        parsed: rows.length,
        unparsed: errors.length,
        matched: matched.length,
        unmatched: unmatched.length,
        flagged: flagged.length,
        byPhone: matched.filter(m => m.method === 'phone').length,
        byName: matched.filter(m => m.method !== 'phone').length,
        clinicsTotal: index.total,
        clinicsWithPhone: index.withPhone
      };

      if (action === 'solta-preview') {
        return ok({
          summary,
          matched: matched.slice(0, 200).map(m => ({
            solta_name: m.row.name, clinic_name: m.clinic.name, clinic_id: m.clinic.id,
            city: m.row.city, district: m.row.district, method: m.method
          })),
          unmatched: unmatched.slice(0, 200).map(u => ({
            name: u.row.name, phone: u.row.phone_raw, city: u.row.city,
            district: u.row.district, address: u.row.address, reason: u.reason
          })),
          flagged: flagged.slice(0, 50).map(r => ({ name: r.name, phone: r.phone_raw, warning: r.warning })),
          errors: errors.slice(0, 50).map(e => ({ line: e.lineNo, error: e.error, raw: e.raw }))
        });
      }

      // Commit. Matched clinics get the device at manufacturer_directory.
      const now = new Date().toISOString();
      const techRows = matched.map(m => ({
        clinic_id:           String(m.clinic.id),
        technology,
        evidence_type:       'manufacturer_directory',
        source_organization: SOLTA_ORG,
        source_url:          SOLTA_SOURCE_URL,
        verification_status: 'currently_listed',
        notes:               'Listed as ' + m.row.name + ' at ' + m.row.address,
        last_verified_at:    now
      }));

      let written = 0;
      for (let i = 0; i < techRows.length; i += 200) {
        const chunk = techRows.slice(i, i + 200);
        const { error } = await supabase
          .from('clinic_technologies')
          .upsert(chunk, { onConflict: 'clinic_id,technology' });
        if (error) throw error;
        written += chunk.length;
      }

      // Unmatched go to the review queue. Nothing is created in clinics.
      const queueRows = unmatched.map(u => ({
        name:       u.row.name,
        phone:      u.row.phone,
        phone_raw:  u.row.phone_raw,
        address:    u.row.address,
        city:       u.row.city,
        district:   u.row.district,
        technology,
        reason:     u.reason,
        status:     'open',
        last_seen_at: now
      }));

      let queued = 0;
      for (let i = 0; i < queueRows.length; i += 200) {
        const chunk = queueRows.slice(i, i + 200);
        const { error } = await supabase.from('solta_unmatched').insert(chunk);
        // A duplicate here just means the row is already queued from a prior run.
        if (error && error.code !== '23505') throw error;
        queued += chunk.length;
      }

      return ok({
        success: true,
        summary,
        written,
        queued,
        message: written + ' clinics marked manufacturer verified, ' + queued + ' sent to the review queue.'
      });
    }

    // ── REVIEW QUEUE ────────────────────────────────────────────────────────
    if (action === 'solta-queue') {
      const { data, error } = await supabase
        .from('solta_unmatched')
        .select('*')
        .eq('status', clean(body.status) || 'open')
        .order('city').order('district').order('name')
        .limit(300);
      if (error) throw error;
      return ok({ queue: data || [] });
    }

    if (action === 'solta-queue-resolve') {
      if (!body.id) return bad(400, 'Missing id');
      const status = clean(body.status);
      if (!['added', 'dismissed', 'open'].includes(status)) return bad(400, 'Invalid status');
      const { error } = await supabase.from('solta_unmatched').update({
        status,
        resolved_clinic_id: clean(body.resolved_clinic_id),
        admin_note: clean(body.admin_note)
      }).eq('id', body.id);
      if (error) throw error;
      return ok({ success: true, message: 'Queue item updated.' });
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

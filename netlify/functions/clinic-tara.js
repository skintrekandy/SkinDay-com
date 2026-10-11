// ============================================================================
// SkinDay Visualize Pro — Tara for clinics  (M29, 2026-10-10)
// ----------------------------------------------------------------------------
// Clinic staff talk to Tara inside the clinic portal. She builds before & after
// images in Studio, sets up AI simulations in Visualize, and finds the clinic's
// own cases in the Library.
//
// ⭐⭐ TARA PLANS, THE PAGE DOES THE WORK. Tara never touches an image. She
// answers with a PLAN (propose_studio / propose_simulation). The plan is
// checked here, sent to the portal, and shown as a card. Nothing happens until
// a person presses the button on that card, and the work is then done by the
// real Studio and the real Visualize, through the same code a person uses. A
// simulation is metered by start-visualization exactly as if it had been
// clicked by hand: same credits, same clinic membership check.
//
// ⭐⭐ NO PATIENT PHOTO IS EVER SENT TO TARA. The portal reads each photo in the
// browser and sends only text: its EXIF date, the angle Visualize's own face
// check measured, and whether a face was found. That is enough to sort before
// from after and to put each angle in its slot. Checking finished images with a
// vision model was considered and deliberately left out for now (it would send
// patient faces to OpenAI for a second purpose the consent did not name).
//
// ⭐ SEPARATE FROM MI TARA. Own instructions, own log table (clinic_tara_log),
// own on/off switch. She can only read this clinic's Library, through the
// clinic's own SECURITY DEFINER functions called AS THE SIGNED-IN USER, so the
// database decides what she may see. She has no market data tools at all.
//
// Same building blocks as MI Tara: OpenAI Responses API in background mode with
// polling ('continue'), previous_response_id for history, voice in and out,
// past chats, answers in the user's language.
//
// Env:
//   OPENAI_API_KEY                required
//   CLINIC_TARA_MODEL             default TARA_MODEL, then 'gpt-5.6-sol'
//   CLINIC_TARA_REASONING         default 'low' ('off' to omit)
//   CLINIC_TARA_EMAILS            users who see Tara, default 'andy@skin-trek.com'
//   CLINIC_TARA_CLINICS           clinic ids switched on for everyone in them
//   CLINIC_TARA_DAILY_LIMIT       questions per user per day, default 100
//   TARA_STT_MODEL / TARA_TTS_MODEL / TARA_VOICE   shared with MI Tara
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================
const { createClient } = require('@supabase/supabase-js');

const OAI = 'https://api.openai.com/v1/responses';
const MAX_ROUNDS = 6;
const OUT_CAP = 12000;
const BUDGET_MS = 7000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function json(status, body) {
  return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}
function nz(v) { if (v === undefined || v === null) return null; const s = String(v).trim(); return s === '' ? null : s; }
function list(env, dflt) { return String(process.env[env] || dflt || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function model() { return process.env.CLINIC_TARA_MODEL || process.env.TARA_MODEL || 'gpt-5.6-sol'; }

// ---- identity ---------------------------------------------------------------
async function verifyUser(event) {
  const h = event.headers || {};
  const m = String(h.authorization || h.Authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !SUPABASE_URL || !SERVICE_KEY) return null;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + m[1] } });
    if (!res.ok) return null;
    const u = await res.json();
    return (u && u.id) ? { id: u.id, email: String(u.email || '').toLowerCase(), jwt: m[1] } : null;
  } catch (e) { return null; }
}

async function buildCtx(sb, event, body) {
  const user = await verifyUser(event);
  if (!user) return { err: 401 };
  const clinicId = String(body.clinicId || '').trim();
  if (!clinicId) return { err: 400 };
  const { data: mem } = await sb.from('clinic_memberships').select('role')
    .eq('user_id', user.id).eq('clinic_id', clinicId).eq('status', 'active').is('revoked_at', null).limit(1);
  if (!mem || !mem.length) return { err: 403 };
  let clinicName = null;
  try { const { data: c } = await sb.from('clinics').select('name').eq('id', clinicId).maybeSingle(); clinicName = c && c.name; } catch (e) {}
  return { sb, user, clinicId, clinicName, role: mem[0].role || null, userKey: user.id };
}
function taraEnabled(ctx) {
  if (ctx.user.email && list('CLINIC_TARA_EMAILS', 'andy@skin-trek.com').includes(ctx.user.email)) return true;
  return list('CLINIC_TARA_CLINICS', '').includes(String(ctx.clinicId).toLowerCase());
}
function dailyLimit() { return parseInt(process.env.CLINIC_TARA_DAILY_LIMIT, 10) || 100; }
async function usedToday(ctx) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count } = await ctx.sb.from('clinic_tara_log').select('id', { count: 'exact', head: true })
    .eq('user_id', ctx.user.id).gte('created_at', since.toISOString());
  return count || 0;
}

// The clinic's own library functions, called AS THE USER. apikey is the service
// key (the gateway only checks it is a valid key); Authorization is the user's
// own token, so PostgREST runs as that user and the SECURITY DEFINER functions
// apply their own clinic membership checks. Tara gets exactly what the portal
// shows this person, never more.
async function rpcAsUser(ctx, fnName, args) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fnName, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + ctx.user.jwt, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error((j && (j.message || j.error)) || ('library read failed (' + res.status + ')'));
  return j;
}

// ---- library ----------------------------------------------------------------
function day(v) { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); }
function patientOf(r) {
  if (r.patient_name && r.patient_ref) return r.patient_name + ' (' + r.patient_ref + ')';
  return r.patient_name || r.patient_ref || null;
}
// Rows (one per angle) into cases (one per series), newest first.
function groupCases(rows) {
  const by = new Map();
  (rows || []).forEach(r => {
    const key = r.series_id || ('c:' + (r.case_id || r.id));
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  });
  return [...by.entries()].map(([key, rs]) => {
    const f = rs[0];
    return {
      key, kind: f.kind || null, patient: patientOf(f), treatment: f.treatment || null, subtype: f.subtype || null,
      label: f.treatment_label || null, injector: f.injector_name || null, consultant: f.consultant_name || null,
      saved: day(f.created_at), before_date: f.before_date || null, after_date: f.after_date || null,
      angles: rs.map(r => r.angle).filter(Boolean), _created: f.created_at || null,
      // What the viewer needs to show the images. Never sent to the model.
      _rows: rs.map(r => ({ case_id: r.case_id || r.id, kind: r.kind || f.kind || 'photograph', angle: r.angle || null,
        before_date: r.before_date || null, after_date: r.after_date || null }))
    };
  }).sort((a, b) => new Date(b._created || 0) - new Date(a._created || 0));
}
async function findCases(ctx, a) {
  const kind = a.kind === 'simulation' ? 'simulation' : (a.kind === 'photograph' ? 'photograph' : null);
  const limit = Math.max(1, Math.min(parseInt(a.limit, 10) || 10, 25));
  const q = String(a.query || '').trim();
  let rows = [];
  if (q.length >= 2) {
    rows = await rpcAsUser(ctx, 'search_clinic_library', { p_clinic_id: ctx.clinicId, p_query: q, p_limit: 120 }) || [];
    if (kind) rows = rows.filter(r => !r.kind || r.kind === kind);
  } else {
    const kinds = kind ? [kind] : ['photograph', 'simulation'];
    for (const k of kinds) {
      const summary = await rpcAsUser(ctx, 'get_clinic_library_summary', { p_clinic_id: ctx.clinicId, p_kind: k }) || [];
      const want = a.treatment ? summary.filter(g => String(g.treatment || '').toLowerCase().includes(String(a.treatment).toLowerCase())) : summary;
      const per = await Promise.all(want.slice(0, 20).map(g =>
        rpcAsUser(ctx, 'get_clinic_library_cases', { p_clinic_id: ctx.clinicId, p_kind: k, p_treatment: g.treatment, p_limit: 100 })
          .then(x => (x || []).map(r => Object.assign({ kind: k }, r))).catch(() => [])));
      rows = rows.concat(per.flat());
    }
  }
  const cases = groupCases(rows);
  const shown = cases.slice(0, limit);
  return {
    total_cases: cases.length,
    cases: shown.map(c => { const o = Object.assign({}, c); delete o._rows; delete o._created; return o; }),
    __panel: { type: 'cases', cases: shown.map(c => ({ key: c.key, kind: c.kind, title: c.patient || c.label || c.treatment || 'Case',
      meta: [c.label && c.patient ? c.label : null, c.treatment, c.injector ? 'by ' + c.injector : null, c.saved].filter(Boolean).join(' · '),
      rows: c._rows })) }
  };
}
async function libraryOverview(ctx) {
  const out = {};
  for (const k of ['photograph', 'simulation']) {
    const s = await rpcAsUser(ctx, 'get_clinic_library_summary', { p_clinic_id: ctx.clinicId, p_kind: k }) || [];
    out[k === 'photograph' ? 'before_and_after' : 'simulations'] = s.map(g => ({ treatment: g.treatment, cases: g.case_count != null ? g.case_count : null, series: g.series_count != null ? g.series_count : null }));
  }
  return out;
}

// ---- plans ------------------------------------------------------------------
// Everything a plan may contain, spelled exactly as Studio and Visualize spell
// it. A plan that does not fit goes back to the model as an error to fix, so the
// card a person sees is always one the tool can actually carry out.
const STUDIO_LAYOUTS = { '2h': 2, '2v': 2, '3h': 3, '2x2': 4, '2x3': 6, '2x5': 10 };
const STUDIO_ROW_LAYOUTS = { '2x2': 2, '2x3': 3, '2x5': 5 };
const STUDIO_CROPS = ['full', 'lower', 'upper', 'eyes'];
const POSITIONS = ['tl', 'tr', 'bl', 'br', 'center'];
const VIS_ANGLES = ['frontal', 'r45', 'l45', 'r90', 'l90'];
const FILLER_AREAS = ['chin_jawline', 'chin', 'jawline', 'cheeks', 'temple', 'nose', 'tear_trough', 'lips', 'nasolabial_folds'];
const ADDONS = ['add_chin_jaw_filler', 'add_chin_filler', 'add_jawline_filler', 'add_cheek_filler', 'add_temple_support', 'add_tear_trough',
  'add_nasolabial_filler', 'add_nose_filler', 'add_lips_filler', 'add_biostim_lift', 'add_rf', 'add_hifu', 'add_masseter', 'add_nefertiti'];

function parseDate(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) throw new Error('Dates must be YYYY-MM-DD, YYYY-MM or YYYY, got "' + t + '".');
  const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
  if (mo && (mo < 1 || mo > 12)) throw new Error('Month out of range in "' + t + '".');
  if (d && (d < 1 || d > 31)) throw new Error('Day out of range in "' + t + '".');
  return { y: String(y), m: mo ? String(mo) : '', d: d ? String(d) : '' };
}

function checkStudio(a, photos) {
  const ids = new Set(photos.map(p => p.id));
  const layout = String(a.layout || '');
  const count = STUDIO_LAYOUTS[layout];
  if (!count) throw new Error('layout must be one of ' + Object.keys(STUDIO_LAYOUTS).join(', '));
  const slots = Array.isArray(a.slots) ? a.slots.map(String) : [];
  if (slots.length !== count) throw new Error('Layout ' + layout + ' has ' + count + ' photo slots; slots lists ' + slots.length + '. Pick a layout that matches the photos, or ask the user.');
  slots.forEach(id => { if (!ids.has(id)) throw new Error('No photo called ' + id + '. Photos in this chat: ' + ([...ids].join(', ') || 'none') + '.'); });
  const subject = a.subject === 'body' ? 'body' : 'face';
  const crop = subject === 'face' ? (STUDIO_CROPS.includes(a.crop) ? a.crop : 'full') : null;
  const rowCols = STUDIO_ROW_LAYOUTS[layout] || 0;
  const dates = Array.isArray(a.dates) ? a.dates : [];
  const labels = Array.isArray(a.labels) ? a.labels.map(x => String(x || '').slice(0, 40)) : [];
  const rowLabels = rowCols ? (Array.isArray(a.row_labels) && a.row_labels.length === 2 ? a.row_labels.map(x => String(x || '').slice(0, 40)) : ['Before', 'After']) : null;
  const out = slots.map((id, i) => {
    let date = null;
    // On row layouts the caption, and so the date, belongs to the row's first photo.
    if (!rowCols || i % rowCols === 0) date = parseDate(dates[rowCols ? i / rowCols : i]);
    return { photo: id, label: rowCols ? null : (labels[i] || null), date };
  });
  const plan = {
    grid: layout, subject, preset: crop, slots: out, rowLabels,
    background: a.background === 'black' ? 'black' : 'original',
    treatmentLabel: nz(a.treatment_label) ? String(a.treatment_label).slice(0, 60) : null,
    wmPos: (POSITIONS.concat(['tile'])).includes(a.watermark_position) ? a.watermark_position : null,
    logoPos: POSITIONS.includes(a.logo_position) ? a.logo_position : null,
    format: ['square', 'portrait', 'story', 'free'].includes(a.export_format) ? a.export_format : null,
    norm: typeof a.match_brightness === 'boolean' ? a.match_brightness : null,
    enhance: [0, 1, 2].includes(a.enhance) ? a.enhance : null,
    clinicName: nz(a.clinic_name) ? String(a.clinic_name).slice(0, 60) : null,
    injectorName: nz(a.injector_name) ? String(a.injector_name).slice(0, 60) : null
  };
  return plan;
}

function checkSimulation(a, photos) {
  const ids = new Set(photos.map(p => p.id));
  const type = String(a.treatment || '');
  if (!['biostim', 'filler', 'laser', 'tox'].includes(type)) throw new Error('treatment must be biostim, filler, laser or tox.');
  const ph = Array.isArray(a.photos) ? a.photos : [];
  if (!ph.length) throw new Error('A simulation needs at least one photo. Ask the user to add one.');
  const seen = new Set();
  const pairs = ph.map(p => {
    const id = String(p.photo || ''); const angle = String(p.angle || '');
    if (!ids.has(id)) throw new Error('No photo called ' + id + '.');
    if (!VIS_ANGLES.includes(angle)) throw new Error('angle must be one of ' + VIS_ANGLES.join(', '));
    if (seen.has(angle)) throw new Error('Two photos for the ' + angle + ' angle. Use one photo per angle.');
    seen.add(angle);
    return { photo: id, angle };
  });
  const addons = (Array.isArray(a.addons) ? a.addons : []).map(String);
  addons.forEach(k => { if (!ADDONS.includes(k)) throw new Error('Unknown add-on ' + k + '. Valid: ' + ADDONS.join(', ')); });
  if (addons.length > 2) throw new Error('At most 2 add-on treatments.');
  if (type === 'filler' && !FILLER_AREAS.includes(a.area)) throw new Error('Filler needs one area: ' + FILLER_AREAS.join(', '));
  return {
    planMode: addons.length ? 'combo' : 'single', type,
    product: type === 'biostim' ? (a.product === 'hdr' ? 'hdr' : 'sculptra') : null,
    area: type === 'filler' ? a.area : null,
    volume: type === 'filler' ? (a.volume === 'enhanced' ? 'enhanced' : 'moderate') : null,
    sex: ['female', 'male'].includes(a.sex) ? a.sex : null,
    laserType: type === 'laser' ? (a.energy_type === 'hifu' ? 'hifu' : 'rf') : null,
    toxMode: type === 'tox' ? (['masseter', 'nefertiti', 'combined'].includes(a.tox_mode) ? a.tox_mode : 'combined') : null,
    concern: type === 'biostim' && ['hollow_deflated', 'full_descended', 'mixed'].includes(a.concern) ? a.concern : null,
    age: Number.isInteger(a.patient_age) && a.patient_age >= 18 && a.patient_age <= 99 ? a.patient_age : null,
    addons, photos: pairs
  };
}

// ---- tools ------------------------------------------------------------------
function fn(name, description, props, required) {
  return { type: 'function', name, description, strict: false,
    parameters: { type: 'object', properties: props || {}, required: required || [], additionalProperties: false } };
}
const TOOLS = [
  fn('find_cases', 'Find cases in THIS clinic’s Library. With query: searches patient name, reference, treatment, injector and date. Without: newest cases, optionally one treatment. Returns cases (one per patient case, with its angles). The app lists them under your answer with a View button each.',
    { query: { type: 'string', description: 'Name, reference, treatment, injector or date text. At least 2 characters.' },
      kind: { type: 'string', enum: ['photograph', 'simulation'], description: 'photograph = real before & after; simulation = saved AI simulations. Omit for both.' },
      treatment: { type: 'string', description: 'Only without query: limit to one treatment' },
      limit: { type: 'integer', description: 'Cases to return, default 10, max 25' } }),
  fn('library_overview', 'How many cases this clinic has kept, per treatment, for real before & afters and for simulations.', {}),
  fn('propose_studio', 'Put a before & after build plan in front of the user as a card. Nothing happens until they press Build. Studio then loads the photos, finds faces, applies the background, crops, labels, dates and brands the image, and renders it.',
    { layout: { type: 'string', enum: Object.keys(STUDIO_LAYOUTS), description: '2h = side by side (2), 2v = stacked (2), 3h = three across (3), 2x2 / 2x3 / 2x5 = top row before, bottom row after (2, 3 or 5 angles)' },
      slots: { type: 'array', items: { type: 'string' }, description: 'Photo ids in slot order, left to right, top to bottom. Exactly as many as the layout has.' },
      subject: { type: 'string', enum: ['face', 'body'] },
      crop: { type: 'string', enum: STUDIO_CROPS, description: 'Face only. full = head to chin, lower = cheeks to jaw, upper = forehead to brows, eyes = brows to nose.' },
      labels: { type: 'array', items: { type: 'string' }, description: '2h, 2v, 3h only: caption per slot. Default Before / After.' },
      row_labels: { type: 'array', items: { type: 'string' }, description: '2x2, 2x3, 2x5 only: [top row, bottom row]. Default ["Before","After"].' },
      dates: { type: 'array', items: { type: 'string' }, description: 'Caption dates, YYYY-MM-DD or YYYY-MM or "" for none. One per slot for 2h/2v/3h; one per ROW for 2x layouts.' },
      background: { type: 'string', enum: ['black', 'original'], description: 'black = remove the background on the device and replace it with black' },
      treatment_label: { type: 'string', description: 'Optional line at the top, e.g. "Sculptra · 3 sessions"' },
      watermark_position: { type: 'string', enum: POSITIONS.concat(['tile']), description: 'Only if the user asks. Uses the clinic/injector name saved in Studio.' },
      logo_position: { type: 'string', enum: POSITIONS, description: 'Only if the user asks.' },
      export_format: { type: 'string', enum: ['square', 'portrait', 'story', 'free'], description: 'Only if the user asks. square 1:1, portrait 4:5, story 9:16, free = match crop.' },
      match_brightness: { type: 'boolean', description: 'Only if the user asks or the case is pigmentation, redness or vascular (then false).' },
      enhance: { type: 'integer', enum: [0, 1, 2], description: 'Only if the user asks. 0 none, 1 subtle, 2 strong. Applied to every panel equally.' },
      clinic_name: { type: 'string', description: 'Only if the user gives one for the watermark' },
      injector_name: { type: 'string', description: 'Only if the user gives one for the watermark' } },
    ['layout', 'slots']),
  fn('propose_simulation', 'Put an AI simulation plan in front of the user as a card. Visualize fills in its form, shows the exact credit cost and balance, and runs only when the user ticks consent and presses Run.',
    { treatment: { type: 'string', enum: ['biostim', 'filler', 'laser', 'tox'] },
      photos: { type: 'array', description: 'One photo per angle', items: { type: 'object', properties: {
        photo: { type: 'string', description: 'Photo id' }, angle: { type: 'string', enum: VIS_ANGLES } }, required: ['photo', 'angle'] } },
      product: { type: 'string', enum: ['sculptra', 'hdr'], description: 'biostim only: sculptra = PLLA (Sculptra, Lanluma); hdr = hyperdilute CaHA (Radiesse)' },
      concern: { type: 'string', enum: ['hollow_deflated', 'full_descended', 'mixed'], description: 'biostim only, optional: volume loss, sagging, mixed' },
      area: { type: 'string', enum: FILLER_AREAS, description: 'filler only: exactly one area' },
      volume: { type: 'string', enum: ['moderate', 'enhanced'], description: 'filler only: moderate (shown as Natural) or enhanced' },
      sex: { type: 'string', enum: ['female', 'male'] },
      patient_age: { type: 'integer' },
      energy_type: { type: 'string', enum: ['rf', 'hifu'], description: 'laser (energy-based devices) only' },
      tox_mode: { type: 'string', enum: ['masseter', 'nefertiti', 'combined'], description: 'tox only' },
      addons: { type: 'array', items: { type: 'string', enum: ADDONS }, description: 'Combination plan: up to 2 complementary treatments on top of the primary. Each adds a pass and costs credits.' } },
    ['treatment', 'photos'])
];
const STATUS_TEXT = { find_cases: 'Looking in your Library', library_overview: 'Counting your cases', propose_studio: 'Preparing the plan', propose_simulation: 'Preparing the plan' };

async function runTool(ctx, name, a) {
  switch (name) {
    case 'find_cases': return await findCases(ctx, a || {});
    case 'library_overview': return await libraryOverview(ctx);
    case 'propose_studio': {
      const plan = checkStudio(a || {}, ctx.photos);
      return { shown: true, note: 'The user now sees a Build card. Wait for them; do not say it is done.', __action: { kind: 'studio', plan } };
    }
    case 'propose_simulation': {
      const plan = checkSimulation(a || {}, ctx.photos);
      return { shown: true, note: 'The user now sees a card with the exact credit cost. Nothing runs until they tick consent and press Run.', __action: { kind: 'simulation', plan } };
    }
  }
  return { error: 'unknown tool' };
}

// ---- instructions -----------------------------------------------------------
function instructions(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are Tara, the assistant inside ' + (ctx.clinicName ? ctx.clinicName + '’s ' : 'a clinic’s ') + 'SkinDay Visualize Pro portal. Today is ' + today + '. You help clinic staff (injectors, nurses, coordinators, front desk) with three things: building before & after images in Studio, setting up AI treatment simulations in Visualize, and finding their own past cases in the Library.',
    '',
    'HOW YOU WORK',
    '- You operate the clinic’s tools; you never edit an image yourself and never claim to. You propose a plan with propose_studio or propose_simulation. The user sees it as a card and presses a button; the tool then does the work. Until they press it, nothing has happened: say "here is the plan", never "done".',
    '- You never see the photos. The user’s message ends with a PHOTOS list: an id per photo (p1, p2...), its file name, the date it was taken (from the camera, when the file has one), the angle Visualize’s face check measured, whether a face was found, and a rough colour of the clothing, plus the photos grouped into sessions by date. Work only from that, and never describe or claim anything about a photo that the list does not say.',
    '- Before vs after, in this order: (1) what the user says always wins, even over the dates. (2) If they identify the photos by something visible, such as clothing, hair or background, match it only against the clothing colour in the list; if that does not settle it for every photo, ask one short question by session and ids ("Is the 27 Feb 2024 set, p1 to p3, the before?"). Never say you matched by shirt or anything else you cannot see. (3) With no instruction, the earlier session is before. (4) No dates and nothing to go on: ask.',
    '- When the user’s instruction and the dates disagree, follow the user and mention the dates in a few words ("the camera dates say the other way round, so check them") without asking them to justify it.',
    '- Angles: frontal → frontal. three-quarter with the patient’s RIGHT cheek toward the camera → r45, LEFT → l45. profile right/left → r90/l90. "no face found" or an unclear angle: ask.',
    '- Ask at most one short question at a time, and only when the answer changes the plan. If the request is clear, propose straight away.',
    '- When a card is already showing and the user changes something, propose again with the change; the new card replaces the old one.',
    '',
    'STUDIO (before & after, free, all on the device)',
    '- Layouts: 2h two side by side; 2v two stacked; 3h three across (e.g. before, mid-course, after); 2x2, 2x3, 2x5: top row before, bottom row after, 2, 3 or 5 angles, the SAME angle order in both rows (frontal, right 45, left 45, right 90, left 90 as available). Pick the layout from the photos: one before + one after = 2h unless they ask for stacked.',
    '- Crop presets for faces: full face (default), lower face (cheeks to jaw: chin, jawline, lower-face cases), upper face (forehead to brows: brow and forehead toxin), eye area. Body photos are not cropped. Studio aligns the photos by the eyes automatically.',
    '- Background: black removes the background on the device and puts black behind the patient on every photo; original keeps it. Use black if they ask, otherwise original.',
    '- Captions: Before / After by default; 2x layouts caption each row once. Dates come from the camera dates; captions show month and year or the full date. Leave a date empty rather than invent one.',
    '- Branding uses the clinic name, injector name and logo saved in Studio; only set watermark or logo positions, export format, brightness matching or enhancement when asked. Brightness matching (on by default) evens out lighting between sessions; for pigmentation, redness or vascular cases suggest turning it off, because the brightness change can be the result.',
    '- After Build, Studio shows the finished image with download buttons, and a save form below it to keep the case in the Library.',
    '',
    'VISUALIZE (AI simulations, uses credits)',
    '- Treatments: biostim (product: PLLA / Sculptra, or hyperdilute CaHA / Radiesse) simulates a FULL-FACE collagen pattern with no area selection, optional primary concern (volume loss, sagging, mixed), sex and age. filler (HA) treats exactly ONE area: chin_jawline, chin, jawline, cheeks, temple, nose, tear_trough, lips, nasolabial_folds; volume moderate (shown as Natural) or enhanced. laser (energy-based devices): RF or HIFU tightening of the lower face and jawline. tox: masseter slimming, Nefertiti lift, or both combined.',
    '- Combination plan: one primary treatment plus up to 2 add-ons (add_chin_jaw_filler, add_chin_filler, add_jawline_filler, add_cheek_filler, add_temple_support, add_tear_trough, add_nasolabial_filler, add_nose_filler, add_lips_filler, add_biostim_lift, add_rf, add_hifu, add_masseter, add_nefertiti). Each add-on is another pass: more credits and slightly softer image quality. Visualize drops add-ons that do not fit the primary and the card says so.',
    '- Mapping requests: "Sculptra in the temples and cheeks" is biostim/sculptra (full face already includes temples and lateral cheeks); say so in one sentence, and mention add_temple_support or add_cheek_filler only as an option if they want those areas emphasised. "Filler in the cheeks and lips" is two areas: filler on one plus the other as an add-on, or ask which matters most.',
    '- Strength: biostim, laser and tox always generate the realistic expected response, which is what "moderate" or "natural" means; there is no strength setting for them. If the user wants a stronger look, say that once the result is ready Visualize offers a "Stronger response" scenario, which they start in Visualize and which costs another credit. For filler use volume: subtle, natural or moderate → moderate (shown as Natural); strong, full or dramatic → enhanced.',
    '- Cost: 1 credit per angle per pass (the card shows the exact number and the balance). Never run anything yourself: the card asks the user to confirm the patient’s consent and press Run.',
    '- Simulations are consultation illustrations, not a promised result. Never recommend doses, syringes or vials; that is the clinician’s call.',
    '',
    'LIBRARY',
    '- Use find_cases to find this clinic’s own cases. The app lists them under your answer with a View button (full screen, swipe between images). You may link one inline as [label](case:KEY) using the key from the tool. Do not repeat the whole list.',
    '- You only ever see this clinic’s own cases. You have no market data and no other clinics’ information; if asked, say so plainly.',
    '',
    'WRITING',
    '- Short and practical, like a capable colleague at the next desk. Lead with what you are doing or the one question you need answered. No headings. Bullets only for a plan summary. Never use italics. Write "before & after".',
    '- Patient names and photos are confidential: use a name only when the user gave it or it came from find_cases.',
    '- Reply in the language the user writes in.',
    '- End every answer with one final line in exactly this form: [[next]] first || second || third',
    '  Three short things the user would likely say next, in their language. Nothing after that line.'
  ].join('\n');
}

// What the page knows right now, as plain text: the photos (metadata only) and
// what happened since the last answer. Added to the question, never stored.
function photoLines(photos) {
  if (!photos.length) return 'PHOTOS: none attached.';
  const lines = photos.map(p => {
    const bits = [p.id, '"' + p.name + '"', p.date ? 'taken ' + p.date : 'no date in file'];
    if (p.face === false) bits.push('no face found');
    else if (p.view) bits.push('angle ' + p.view + (p.yaw != null ? ' (~' + p.yaw + '°)' : ''));
    else bits.push('angle not measured');
    if (p.clothes) bits.push('clothing looks ' + p.clothes + ' (colour estimate)');
    if (p.size) bits.push(p.size);
    return '- ' + bits.join(', ');
  });
  // Sessions: photos taken the same day belong together.
  const by = new Map();
  photos.forEach(p => { const k = p.date ? p.date.slice(0, 10) : 'no date'; if (!by.has(k)) by.set(k, []); by.get(k).push(p.id); });
  const sessions = [...by.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([k, ids]) => '- ' + k + ': ' + ids.join(', '));
  return 'PHOTOS:\n' + lines.join('\n') + '\nSESSIONS (by camera date, earliest first):\n' + sessions.join('\n');
}
const LANG_NAMES = { en: 'English', 'zh-hant': 'Traditional Chinese', 'zh-hans': 'Simplified Chinese', fr: 'French', ko: 'Korean', es: 'Spanish', ja: 'Japanese', vi: 'Vietnamese' };
function askNotes(body, photos) {
  const notes = [photoLines(photos)];
  const ev = Array.isArray(body.events) ? body.events.map(x => String(x).slice(0, 300)).slice(0, 6) : [];
  if (ev.length) notes.push('SINCE YOUR LAST ANSWER:\n' + ev.map(x => '- ' + x).join('\n'));
  if (nz(body.tab)) notes.push('The user is on the ' + String(body.tab).slice(0, 20) + ' tab.');
  if (body.via === 'voice') notes.push('Asked by voice. Keep the reply to about 60 words of plain spoken sentences. If a word in the transcript looks odd, assume the closest treatment or product name.');
  const lang = LANG_NAMES[String(body.reply_lang || '').toLowerCase()];
  if (lang) notes.push('Reply in ' + lang + '.');
  return '\n\n---\n' + notes.join('\n\n');
}
function cleanPhotos(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 12).map((p, i) => ({
    id: /^p\d{1,2}$/.test(String(p.id || '')) ? String(p.id) : ('p' + (i + 1)),
    name: String(p.name || 'photo').replace(/["\n\r]/g, '').slice(0, 60),
    date: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(String(p.date || '')) ? String(p.date) : null,
    view: ['frontal', 'three-quarter right', 'three-quarter left', 'profile right', 'profile left', 'turned too far'].includes(p.view) ? p.view : null,
    yaw: Number.isFinite(p.yaw) ? Math.round(p.yaw) : null,
    face: p.face === false ? false : (p.face === true ? true : null),
    clothes: ['black or navy', 'white', 'grey', 'red', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'].includes(p.clothes) ? p.clothes : null,
    size: /^\d{2,5}x\d{2,5}$/.test(String(p.size || '')) ? String(p.size) : null
  }));
}

// ---- OpenAI -----------------------------------------------------------------
async function oaiFetch(path, opts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(OAI + (path || ''), Object.assign({ signal: ac.signal,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' } }, opts));
    const text = await r.text();
    let j = {}; try { j = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, j, text };
  } finally { clearTimeout(t); }
}
async function oaiCreate(ctx, payload) {
  const body = Object.assign({ model: model(), background: true, store: true,
    instructions: instructions(ctx), tools: TOOLS, max_output_tokens: 4000 }, payload);
  const eff = (process.env.CLINIC_TARA_REASONING || 'low').toLowerCase();
  if (eff !== 'off') body.reasoning = { effort: eff };
  let r = await oaiFetch('', { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok && body.reasoning && /reasoning/i.test(r.text)) { delete body.reasoning; r = await oaiFetch('', { method: 'POST', body: JSON.stringify(body) }); }
  if (!r.ok && body.previous_response_id && /previous_response/i.test(r.text)) { delete body.previous_response_id; r = await oaiFetch('', { method: 'POST', body: JSON.stringify(body) }); }
  if (!r.ok) throw new Error((r.j.error && r.j.error.message) || ('OpenAI error ' + r.status));
  return r.j;
}
async function oaiGet(id) {
  const r = await oaiFetch('/' + encodeURIComponent(id), { method: 'GET' });
  if (!r.ok) throw new Error((r.j.error && r.j.error.message) || ('OpenAI error ' + r.status));
  return r.j;
}
function outText(resp) {
  let s = '';
  (resp.output || []).forEach(o => {
    if (o.type === 'message') (o.content || []).forEach(c => { if (c.type === 'output_text' && c.text) s += c.text; });
  });
  return s.trim();
}

async function advance(ctx, row, t0) {
  const sb = ctx.sb;
  const save = fields => sb.from('clinic_tara_log').update(Object.assign({ updated_at: new Date().toISOString() }, fields)).eq('id', row.id);
  // Photos travel with the row so a 'continue' can still check a plan against them.
  ctx.photos = cleanPhotos(row.photos);
  while (Date.now() - t0 < BUDGET_MS) {
    let r;
    try { r = await oaiGet(row.response_id); }
    catch (e) { if (Date.now() - t0 > BUDGET_MS - 1500) break; await sleep(600); continue; }
    if (r.status === 'queued' || r.status === 'in_progress') { await sleep(650); continue; }

    const u = r.usage || {};
    if (row._counted !== r.id) {
      row._counted = r.id;
      row.input_tokens = (row.input_tokens || 0) + (u.input_tokens || 0);
      row.output_tokens = (row.output_tokens || 0) + (u.output_tokens || 0);
    }
    const calls = (r.output || []).filter(o => o.type === 'function_call');
    if (r.status !== 'completed' || !calls.length) {
      const text = outText(r);
      if (text) Object.assign(row, { status: 'done', answer: text, answer_chars: text.length, final_response_id: r.id });
      else Object.assign(row, { status: 'error', error: (r.error && r.error.message) || ('ended: ' + r.status) });
      await save({ status: row.status, answer: row.answer || null, answer_chars: row.answer_chars || null,
        final_response_id: row.final_response_id || null, error: row.error || null,
        input_tokens: row.input_tokens, output_tokens: row.output_tokens });
      return row;
    }
    if (Date.now() - t0 > 3500) break;
    const outputs = await Promise.all(calls.map(async c => {
      let args = {}; try { args = JSON.parse(c.arguments || '{}'); } catch (e) {}
      const started = Date.now();
      let result, err = null;
      try { result = await runTool(ctx, c.name, args); }
      catch (e) { err = String(e.message || e); result = { error: err }; }
      const panel = result && result.__panel; if (panel) delete result.__panel;
      const action = result && result.__action; if (action) delete result.__action;
      row.tools = (row.tools || []).concat([{ name: c.name, args, ms: Date.now() - started, error: err || undefined,
        panel: panel || undefined, action: action || undefined }]);
      let s = JSON.stringify(result);
      if (s.length > OUT_CAP) s = s.slice(0, OUT_CAP) + '... [cut off: ask a narrower question]';
      return { type: 'function_call_output', call_id: c.call_id, output: s };
    }));
    row.rounds = (row.rounds || 0) + 1;
    const next = await oaiCreate(ctx, { previous_response_id: r.id, input: outputs,
      tool_choice: row.rounds >= MAX_ROUNDS ? 'none' : 'auto' });
    row.response_id = next.id;
    await save({ response_id: row.response_id, rounds: row.rounds, tools: row.tools,
      input_tokens: row.input_tokens, output_tokens: row.output_tokens });
  }
  return row;
}

function splitFollowups(text) {
  let t = String(text || '');
  let followups = [];
  const i = t.lastIndexOf('[[next]]');
  if (i !== -1) {
    followups = t.slice(i + 8).split('||').map(x => x.replace(/^[\s\-•*\d.)]+/, '').trim()).filter(x => x && x.length < 160).slice(0, 3);
    t = t.slice(0, i);
  }
  return { answer: t.replace(/\[\[more\]\]/g, '').trim(), followups };
}
function reply(row, extra) {
  const tl = row.tools || [];
  const last = tl[tl.length - 1];
  const done = row.status === 'done';
  const sp = done ? splitFollowups(row.answer) : { answer: null, followups: [] };
  let cases = null, action = null;
  if (done) {
    for (let i = tl.length - 1; i >= 0; i--) {
      if (!cases && tl[i] && tl[i].panel) cases = tl[i].panel;
      if (!action && tl[i] && tl[i].action) action = tl[i].action;
    }
  }
  return Object.assign({
    id: row.id, thread_id: row.thread_id, done: row.status !== 'running',
    answer: done ? sp.answer : null, followups: sp.followups, cases, action,
    error: row.status === 'error' ? 'Tara could not finish that one. Please try again.' : null,
    status_text: row.status === 'running' ? ((last && STATUS_TEXT[last.name]) || 'Thinking') : null
  }, extra || {});
}

// ---- voice ------------------------------------------------------------------
const VOICE_TERMS = ['SkinDay', 'Tara', 'Visualize', 'Studio', 'Sculptra', 'Lanluma', 'Radiesse', 'CaHA', 'PLLA', 'HA filler', 'Botox',
  'Dysport', 'Xeomin', 'Nefertiti', 'masseter', 'Juvederm', 'Restylane', 'Thermage', 'Ultherapy', 'HIFU', 'RF', 'tear trough',
  'nasolabial', 'jawline', 'temples', 'before and after'];
async function transcribe(buf, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : (/mpeg|mp3/.test(mime) ? 'mp3' : (/wav/.test(mime) ? 'wav' : 'webm'));
  const type = ext === 'm4a' ? 'audio/mp4' : (ext === 'mp3' ? 'audio/mpeg' : (ext === 'wav' ? 'audio/wav' : 'audio/webm'));
  const send = async (rich) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type }), 'question.' + ext);
    fd.append('model', process.env.TARA_STT_MODEL || 'gpt-transcribe');
    fd.append('response_format', 'json');
    fd.append('prompt', 'Aesthetic clinic staff asking an assistant to build before and after photos or run treatment simulations.' + (rich ? '' : ' Terms: ' + VOICE_TERMS.join(', ') + '.'));
    if (rich) VOICE_TERMS.forEach(t => fd.append('keywords[]', t));
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8500);
    try {
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', signal: ac.signal, headers: { 'Authorization': 'Bearer ' + key }, body: fd });
      const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) {}
      return { ok: r.ok, j, txt };
    } finally { clearTimeout(tm); }
  };
  let r = await send(true);
  if (!r.ok && /keyword/i.test(r.txt)) r = await send(false);
  if (!r.ok) throw new Error((r.j.error && r.j.error.message) || 'Could not hear that.');
  return String(r.j.text || '').trim();
}
function speechText(md) {
  let t = splitFollowups(md).answer
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '').replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?。！？])\.\s/g, '$1 ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > 1000) { const cut = t.slice(0, 1000); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。')); t = (end > 300 ? cut.slice(0, end + 1) : cut); }
  return t;
}
async function speak(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', signal: ac.signal,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.TARA_TTS_MODEL || 'gpt-4o-mini-tts', voice: process.env.TARA_VOICE || 'marin',
        input: text, response_format: 'mp3',
        instructions: 'Calm, warm and clear, like a helpful colleague in a clinic. Natural pace. Speak in the language of the text.' }) });
    if (!r.ok) throw new Error('Could not read that aloud.');
    return Buffer.from(await r.arrayBuffer()).toString('base64');
  } finally { clearTimeout(tm); }
}

// ---- handler ----------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  const t0 = Date.now();
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'not configured' });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const ctx = await buildCtx(sb, event, body);
  if (ctx.err === 401) return json(401, { error: 'unauthorized' });
  if (ctx.err === 400) return json(400, { error: 'clinicId required' });
  if (ctx.err === 403) return json(403, { error: 'You are not a member of this clinic.', code: 'CLINIC_FORBIDDEN' });
  ctx.photos = [];

  const action = body.action;
  try {
    if (action === 'status') {
      if (!taraEnabled(ctx)) return json(200, { enabled: false });
      return json(200, { enabled: true, used: await usedToday(ctx), limit: dailyLimit(), voice: true });
    }
    if (!taraEnabled(ctx)) return json(403, { error: 'Tara is not switched on for this clinic yet.' });

    if (action === 'ask') {
      const question = String(body.question || '').trim().slice(0, 2000);
      if (!question) return json(400, { error: 'Ask something first.' });
      const limit = dailyLimit();
      const used = await usedToday(ctx);
      if (used >= limit) return json(429, { error: 'You have used today’s ' + limit + ' questions. They reset at midnight UTC.' });
      const thread = /^[a-z0-9-]{8,64}$/i.test(String(body.thread_id || '')) ? String(body.thread_id)
        : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      const { data: prev } = await sb.from('clinic_tara_log').select('final_response_id')
        .eq('user_id', ctx.user.id).eq('clinic_id', ctx.clinicId).eq('thread_id', thread).eq('status', 'done')
        .order('id', { ascending: false }).limit(1);
      const prevId = prev && prev[0] && prev[0].final_response_id;
      const photos = cleanPhotos(body.photos);
      ctx.photos = photos;
      const base = { clinic_id: ctx.clinicId, user_id: ctx.user.id, email: ctx.user.email || null, thread_id: thread,
        question, model: model(), photos };
      let first;
      try {
        first = await oaiCreate(ctx, Object.assign({ input: [{ role: 'user', content: question + askNotes(body, photos) }] }, prevId ? { previous_response_id: prevId } : {}));
      } catch (e) {
        await sb.from('clinic_tara_log').insert(Object.assign({}, base, { status: 'error', error: String(e.message || e) }));
        return json(502, { error: 'Tara is not available right now. Please try again shortly.' });
      }
      const { data: ins, error: insErr } = await sb.from('clinic_tara_log')
        .insert(Object.assign({}, base, { status: 'running', response_id: first.id, tools: [] })).select('*').single();
      if (insErr) return json(500, { error: 'Could not start that question.', detail: insErr.message });
      const row = await advance(ctx, ins, t0);
      return json(200, reply(row, { used: used + 1, limit }));
    }

    if (action === 'continue') {
      const id = parseInt(body.id, 10);
      const { data: row } = await sb.from('clinic_tara_log').select('*').eq('id', id).eq('user_id', ctx.user.id).eq('clinic_id', ctx.clinicId).maybeSingle();
      if (!row) return json(404, { error: 'not found' });
      if (row.status !== 'running') return json(200, reply(row));
      return json(200, reply(await advance(ctx, row, t0)));
    }

    if (action === 'feedback') {
      const id = parseInt(body.id, 10);
      const rating = body.rating === 1 || body.rating === -1 ? body.rating : null;
      await sb.from('clinic_tara_log').update({ rating, feedback: nz(body.note) ? String(body.note).slice(0, 1000) : null })
        .eq('id', id).eq('user_id', ctx.user.id);
      return json(200, { ok: true });
    }

    // What happened when the user pressed a card's button, kept with the answer
    // that proposed it, so the log shows plan AND outcome.
    if (action === 'outcome') {
      const id = parseInt(body.id, 10);
      const outcome = String(body.outcome || '').slice(0, 500);
      if (id && outcome) await sb.from('clinic_tara_log').update({ outcome, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', ctx.user.id);
      return json(200, { ok: true });
    }

    if (action === 'transcribe') {
      const b64 = String(body.audio || '');
      if (!b64) return json(400, { error: 'No recording received.' });
      if (b64.length > 5500000) return json(413, { error: 'That recording is too long. Please keep it under a minute.' });
      return json(200, { text: await transcribe(Buffer.from(b64, 'base64'), String(body.mime || 'audio/webm')) });
    }

    // The text comes from the log, never from the browser.
    if (action === 'speak') {
      const id = parseInt(body.id, 10);
      const { data: row } = await sb.from('clinic_tara_log').select('answer').eq('id', id).eq('user_id', ctx.user.id).maybeSingle();
      if (!row || !row.answer) return json(404, { error: 'not found' });
      return json(200, { audio: await speak(speechText(row.answer)), mime: 'audio/mpeg' });
    }

    if (action === 'threads') {
      const { data } = await sb.from('clinic_tara_log').select('id, thread_id, question, created_at')
        .eq('user_id', ctx.user.id).eq('clinic_id', ctx.clinicId).order('id', { ascending: false }).limit(400);
      const by = new Map();
      (data || []).forEach(r => {
        const t = by.get(r.thread_id);
        if (!t) by.set(r.thread_id, { thread_id: r.thread_id, title: r.question, last_at: r.created_at, count: 1 });
        else { t.title = r.question; t.count++; }
      });
      return json(200, { threads: [...by.values()].slice(0, 40) });
    }
    if (action === 'thread') {
      const tid = String(body.thread_id || '');
      const { data } = await sb.from('clinic_tara_log').select('*')
        .eq('user_id', ctx.user.id).eq('clinic_id', ctx.clinicId).eq('thread_id', tid).order('id', { ascending: true }).limit(60);
      // Past cards come back as a record of what was proposed, never as live
      // buttons: the photos they referred to are no longer on the page.
      return json(200, { thread_id: tid, turns: (data || []).map(r => Object.assign({ question: r.question, rating: r.rating, outcome: r.outcome || null }, reply(r))) });
    }

    return json(400, { error: 'unknown action' });
  } catch (e) {
    return json(500, { error: 'Something went wrong.', detail: String(e.message || e) });
  }
};

// For tests.
exports._internal = { checkStudio, checkSimulation, parseDate, groupCases, cleanPhotos, photoLines, splitFollowups };

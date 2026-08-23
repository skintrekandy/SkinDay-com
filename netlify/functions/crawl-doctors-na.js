// netlify/functions/crawl-doctors-na.js
//
// Reads a clinic's OWN website for the providers it publishes. North American
// sibling of crawl-doctors.js. NO API KEY AND NO PER-PAGE COST: a parser.
//
// ⭐⭐ WHY THIS IS A SEPARATE FILE, when crawl-socials.js is one file switched by
// country. Socials differ only in CONFIGURATION — the Facebook and Instagram
// parsing is byte-identical in every market, so forking it would mean
// maintaining the same regex twice. Doctors differ in LOGIC. crawl-doctors.js is
// a Chinese name parser with a crawler wrapped around it: a surname table, the
// 醫師/院長/主任 title ranks, and run-of-CJK-characters logic to tell 皮膚科醫師
// from a person. None of that survives translation, and an English parser
// anchors on something else entirely (see below). Forcing both into one file
// would mean every Taiwan re-crawl risks a regression in code only North America
// uses. The rule: fork when the logic differs, switch when only the config does.
//
// ⭐ WHAT ANCHORS AN ENGLISH NAME. In Chinese the TITLE marks the person —
// 王小明醫師. In English the CREDENTIAL does — "Rachel Careccia, MD". So this
// parser is built on the same credential regex the M20 entity classifier uses to
// separate individual_provider rows from clinic_location rows, which has already
// been run against ~33,000 US Google listings.
//
// ⛔ THIS IS A COVERAGE TOOL, NOT A COLD START. The M20 screen already produced
// ~4,400 US providers, 2,606 of them linked to a specific clinic, purely from
// Google listings. What this adds is the associates who have no Google listing
// of their own, plus job titles. Judge a run against that baseline: a host that
// returns only names already in `doctors` is not a failure, it is agreement.
//
// Environment variables, all already set:
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ADMIN_SECRET
//
// Requires (migration ships with this file):
//   doctors.name_en text · doctors.credentials text · doctors.country text
//   doctors.name_zh must be NULLABLE — it is NOT NULL for the Taiwan rows.

// ⛔ SIZED FOR NETLIFY'S SYNCHRONOUS FUNCTION LIMIT (10s default, 26s max).
// The Taiwan file uses batch 5 at a 12s timeout — up to 120 SECONDS of work —
// and only got away with it because Taiwanese clinic sites are small and fast.
// A US medspa on a bloated theme is not. 3 hosts x 2 pages x 6s = 36s worst
// case, and the per-host budget below caps it harder than that.
const BATCH_DEFAULT = 3;
const FETCH_TIMEOUT_MS = 6000;
// Whole-run budget. When it is gone the function returns what it has instead of
// being killed mid-flight, which is what leaves rows stuck in 'running' and the
// browser showing a bare "Failed to fetch" with no status code.
const RUN_BUDGET_MS = 18000;

// A large US dermatology group genuinely lists 25+ providers on one page —
// Schweiger and Advanced Dermatology both do — so this sits well above the
// Taiwan file's 15. Above it, the page is a directory or a blog index, not a
// roster, and nothing lands.
const MAX_PLAUSIBLE_TEAM = 30;

// If the same person appears on this many unrelated clinics, the match is a
// parser artefact, not a doctor with many jobs. Same shape of output check as
// crawl-socials.js's MAX_SHARED_CLINICS.
const MAX_SHARED_CLINICS = 4;

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Credentials ─────────────────────────────────────────────────────────────
// ⛔⛔ "P.A." IS NOT ON THIS LIST AND MUST NEVER BE. In Florida a professional
// association is written exactly like a credential — "Advanced Dermatology,
// P.A." is a COMPANY. Only PA-C, the certified physician assistant, is a person.
// This exact ambiguity moved 101 rows between buckets during the M20 Florida
// classification; here it would invent a doctor named "Advanced Dermatology".
const CRED = String.raw`(?:M\.?D\.?|D\.?O\.?|D\.?D\.?S\.?|D\.?M\.?D\.?|PA-C|ARNP|APRN|` +
             String.raw`FNP-?C?|DNP|CRNA|D\.?P\.?M\.?|Ph\.?D\.?|MBBS|` +
             String.raw`FAAD|FACS|FACMS|FAACS|RN|LME|LE)`;

// ── Words that mean this is a BUSINESS, not a person ────────────────────────
// Checked against the captured name itself. "Miami Skin Institute, MD" is not a
// doctor; "Coral Gables Dermatology" is not a doctor.
const BUSINESS_WORD = /\b(derm\w*|center|centre|centro|clinic|clinica|cl[ií]nica|spa|medspa|aesthetic\w*|esthetic\w*|est[eé]tica|surgery|surgical|institute|instituto|group|associates|partners|practice|studio|salon|laser|skin|beauty|belleza|wellness|health|medical|medicine|plastic|cosmetic|care|pllc|llc|inc|corp|pa|pc|university|college|school|hospital|academy|foundation|therapy|massage|certified|board)\b/i;

// ⛔ WORDS THAT PRECEDE A NAME AND ARE NOT PART OF IT. The first New York run
// produced "Meet Kristina Christopher, FNP-C", "About Jennifer Geiger, MD" and
// "NYC Dr. Richard Swift, MD" — the lead-in was captured because the name window
// preferred the LONGEST plausible match. Stripped here, and the preference is
// reversed below.
const LEAD_IN = /^(?:(?:meet|about|our|the|dr|drs|doctor|welcome|introducing|nyc|ny|new york|contact|call|book|see|visit|with|by|from|team|staff|provider|providers)\b[\s.,:-]*)+/i;

// Words that appear where a name should be, on pages that are not rosters.
const NOT_A_NAME = /\b(privacy|policy|terms|copyright|reserved|appointment|schedule|consultation|financing|gallery|before|after|reviews?|testimonial|patient|contact|location|hours|insurance|careers|blog|news)\b/i;

// ── Role / title, captured separately from the credential ───────────────────
// A rep cares whether the person is the medical director or the aesthetician,
// and that is not derivable from the credential alone.
const ROLE_HINTS = [
  ['medical director', 100], ['founder', 95], ['owner', 90], ['practice manager', 40],
  ['board-certified dermatologist', 90], ['dermatologist', 80],
  ['plastic surgeon', 85], ['facial plastic surgeon', 88], ['oculoplastic', 80],
  ['mohs surgeon', 85], ['dermatopathologist', 70],
  ['nurse practitioner', 70], ['physician assistant', 70], ['registered nurse', 60],
  ['injector', 75], ['master injector', 85],
  ['aesthetician', 60], ['esthetician', 60], ['laser technician', 55],
  ['physician', 65], ['provider', 40]
];

// ── Team page hints, English ────────────────────────────────────────────────
// Wholesale replacement for the Chinese list. "Meet the team" and "our
// providers" are the two dominant US phrasings; "staff" scores low because it
// is as often a careers page.
const TEAM_HINTS = [
  ['meet-the-team', 100], ['meet-our-team', 100], ['our-providers', 100],
  ['our-team', 95], ['our-physicians', 95], ['meet-the-doctors', 95],
  ['providers', 90], ['physicians', 90], ['our-doctors', 90], ['medical-team', 90],
  ['practitioners', 85], ['our-staff', 60], ['doctors', 75], ['team', 70],
  ['about-us', 45], ['about', 35], ['staff', 30]
];

// ── Supabase ────────────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ── Fetching, with a timeout so one dead host cannot stall the batch ────────
async function getPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SkinDayBot/1.0; +https://skinday.com)',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    const html = await r.text();
    return { ok: true, html, finalUrl: r.url || url };
  } catch (e) {
    return { ok: false, error: String(e.name === 'AbortError' ? 'timeout' : (e.message || e)).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // ⭐ Break on block tags BEFORE stripping. A roster is usually one provider
    // per card, and without this "Jane Doe, MDJohn Roe, DO" runs together and
    // neither parses.
    .replace(/<\/(p|div|li|h[1-6]|td|tr|section|article|span)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;|&apos;|&rsquo;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ── Team page picker ────────────────────────────────────────────────────────
function findTeamUrl(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    // ⛔ NEVER FOLLOW CONTENT URLS. A post titled "Meet Dr. Smith, Our New
    // Injector" scores as high as a team page and is full of other clinics'
    // doctors. Same guard as the Taiwan file, English paths.
    if (/\/(blog|news|article|articles|post|posts|category|tag|archive|press|faq|case|cases|video|event|promo|specials|shop|store|product)(\/|$|\?)/i.test(href)
        || /[?&]p=\d|[?&]page_id=/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    try { if (new URL(abs).hostname !== new URL(baseUrl).hostname) continue; } catch { continue; }
    // ⛔ decodeURIComponent THROWS on a stray '%' in a href ("URI malformed"),
    // which killed an otherwise healthy host on the first run.
    let decoded = abs;
    try { decoded = decodeURIComponent(abs); } catch (_) {}
    const hay = (decoded + ' ' + label).toLowerCase();
    let score = 0;
    for (const [word, w] of TEAM_HINTS) if (hay.includes(word)) score = Math.max(score, w);
    if (score) links.push({ abs, score });
  }
  links.sort((x, y) => y.score - x.score);
  return links.length ? links[0].abs : null;
}

// ── The parser ──────────────────────────────────────────────────────────────
// Two shapes, in priority order:
//   1. "Rachel Careccia, MD, FAAD"     name then credential stack
//   2. "Dr. Seth Forman"               title then name, no credential
// Shape 1 is far more reliable; shape 2 only runs on lines shape 1 did not
// claim, because "Dr." is also a brand prefix ("Dr. Freeze CoolSculpting
// Center" was a false catch in California).
const NAME_TOKEN = String.raw`[A-Z][A-Za-zÀ-ÿ'’\-]*\.?`;
const NAME_ONLY = new RegExp(`^${NAME_TOKEN}$`);
// ⛔ [ \t] NOT \s. \b and \s both cross newlines, and a roster is one provider
// per line — "Our Providers\nRachel Careccia, MD" matched as a single four-word
// name until this was fixed. Everything below works LINE BY LINE for the same
// reason.
const DR_LINE = new RegExp(`\\bDr\\.?\\s+(${NAME_TOKEN}(?:[ \\t]+${NAME_TOKEN}){1,2})\\b`);

// ⭐⭐ ONE PERSON, ONE ROW. The first run created four rows for one surgeon —
// "John Gerard Hunter", "Dr. John Hunter, MD, FACS", "John Hunter", "John G.
// Hunter" — because dedupe compared raw strings. The key drops punctuation,
// lowercases, and REMOVES SINGLE-LETTER MIDDLE INITIALS, so all four collapse
// to "john hunter". First and last token only: that is the part a person keeps.
function identityKey(name) {
  const t = String(name || '')
    .toLowerCase()
    .replace(/[.,''’-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 1);            // drops "j", "g", initials
  if (t.length < 2) return t.join(' ');
  return t[0] + ' ' + t[t.length - 1];
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[\s,\-–—]+|[\s,\-–—]+$/g, '')
    .trim();
}

function plausibleName(name) {
  if (!name) return false;
  const parts = name.split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;      // "Jane Doe" .. "A. Jane Q. Doe"
  if (BUSINESS_WORD.test(name)) return false;                  // a practice, not a person
  if (NOT_A_NAME.test(name)) return false;                     // nav furniture
  if (/\d/.test(name)) return false;
  // ALL-CAPS runs are headings ("MEET OUR PROVIDERS"), not names.
  if (name === name.toUpperCase() && name.replace(/[^A-Z]/g, '').length > 4) return false;
  if (!parts.every(p => NAME_ONLY.test(p))) return false;
  // ⛔ A BARE SINGLE LETTER IS NOT A NAME TOKEN. "Should I, DO" produced a
  // doctor called "Should I" on the first run. An initial is written "G." — with
  // the dot — so length 1 and no dot is rejected.
  if (!parts.every(p => p.length >= 2 || p.endsWith('.'))) return false;
  // A name needs at least one token of real length; "A. B." is initials alone.
  return parts.some(p => p.replace(/\./g, '').length >= 2);
}

// ⭐ SHRINK TO FIT. Strip lead-in words FIRST, then take the LONGEST plausible
// window and fall back to shorter ones.
// ⛔ ORDER MATTERS AND BOTH HALVES ARE LOAD-BEARING. Longest-first alone gave
// "Meet Kristina Christopher" — the lead-in is three capitalised tokens and
// passes every other test. Shortest-first alone gave "Gerard Hunter" for "John
// Gerard Hunter" — it drops the FIRST name, not the lead-in. Stripping lead-ins
// and then going longest-first gets both, and still lets "Dermatologist Seth
// Forman, DO" fall back to the two-token window rather than being swallowed.
function nameBefore(segment) {
  const tokens = cleanName(segment).replace(LEAD_IN, '').split(' ').filter(Boolean);
  for (let take = Math.min(4, tokens.length); take >= 2; take--) {
    const cand = tokens.slice(tokens.length - take).join(' ');
    if (plausibleName(cand)) return cand;
  }
  return null;
}

// Roles are printed under the name on a provider card, so look at THIS line and
// the next one only — a wider window reads the next provider's title.
function roleNear(lines, i) {
  const hay = (lines[i] + ' ' + (lines[i + 1] || '')).toLowerCase();
  let best = null, bestScore = 0;
  for (const [word, w] of ROLE_HINTS) {
    if (hay.includes(word) && w > bestScore) { best = word; bestScore = w; }
  }
  return best;
}

function extractProviders(text) {
  const out = new Map();
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);

  // Shape 1 — name then credential stack. The reliable one.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A line can hold two providers ("Jane Doe, MD  ·  John Roe, DO"), so scan
    // every credential occurrence rather than the first.
    // ⛔⛔ LOOKAROUNDS ARE LOAD-BEARING. Without them these two-letter
    // credentials match INSIDE ordinary words: LE inside "Coral Gables", RN
    // inside "Fernández", DO inside "Doe" — which silently truncated names to
    // "Coral Gab" and "Luis Fe", and swallowed "Jane Doe, MD" entirely.
    // ⛔ BOUNDARIES ARE LOAD-BEARING: without them these two-letter credentials
    // match INSIDE ordinary words — LE in "Coral Gables", RN in "Fernández", DO
    // in "Doe" — truncating names to "Coral Gab" and swallowing "Jane Doe, MD".
    // ⚠️ Written as a CAPTURE GROUP rather than a lookbehind. Lookbehind needs
    // Node 16+, and a regex that throws at module load takes the whole function
    // down before the handler can report anything.
    const credRe = new RegExp(
      `([^A-Za-zÀ-ÿ]|^)(${CRED}(?:[,\\s\\.]+${CRED})*)(?![A-Za-zÀ-ÿ])`, 'gi');
    let m, cursor = 0;
    while ((m = credRe.exec(line)) !== null) {
      // m[1] is the boundary character, m[2] the credential stack.
      const before = line.slice(cursor, m.index + m[1].length);
      const name = nameBefore(before);
      cursor = m.index + m[0].length;
      if (!name) continue;
      const key = identityKey(name);
      const creds = cleanName(m[2]).replace(/\s*,\s*/g, ', ').toUpperCase();
      const prev = out.get(key);
      if (prev) {
        // Same person seen again: keep the fuller name and fill blank creds.
        if (name.length > prev.name_en.length) prev.name_en = name;
        if (!prev.credentials && creds) prev.credentials = creds;
        if (!prev.title) prev.title = roleNear(lines, i);
        continue;
      }
      out.set(key, { name_en: name, credentials: creds, title: roleNear(lines, i) });
    }
  }

  // Shape 2 — "Dr. Name", no credential. Only for people shape 1 missed:
  // "Dr." is also a brand prefix ("Dr. Freeze CoolSculpting Center").
  for (let i = 0; i < lines.length; i++) {
    const m = DR_LINE.exec(lines[i]);
    if (!m) continue;
    const name = cleanName(m[1]).replace(LEAD_IN, '');
    if (!plausibleName(name)) continue;
    const key = identityKey(name);
    if (out.has(key)) continue;
    out.set(key, { name_en: name, credentials: null, title: roleNear(lines, i) });
  }

  return [...out.values()];
}

// ── Plausibility on the OUTPUT, before anything publishes ───────────────────
async function isSharedPerson(name, country, excludeClinicId) {
  const rows = await sb(
    `doctors?select=id&country=eq.${encodeURIComponent(country)}` +
    `&identity_key=eq.${encodeURIComponent(identityKey(name))}&limit=${MAX_SHARED_CLINICS + 1}`);
  if (!rows || rows.length <= 1) return false;
  const links = await sb(
    `clinic_doctors?select=clinic_id&doctor_id=in.(${rows.map(r => r.id).join(',')})&limit=50`);
  const distinct = new Set((links || [])
    .map(l => String(l.clinic_id))
    .filter(id => id !== String(excludeClinicId)));
  return distinct.size >= MAX_SHARED_CLINICS;
}

// ── Landing ─────────────────────────────────────────────────────────────────
async function land(providers, clinicId, country, sourceUrl) {
  let created = 0, linked = 0, skipped = 0;

  for (const p of providers) {
    const name = (p.name_en || '').trim();
    if (!name) continue;

    if (await isSharedPerson(name, country, clinicId)) { skipped++; continue; }

    // ⚠️ IDENTITY IS SCOPED TO COUNTRY, AND THAT IS A KNOWN COMPROMISE. Chinese
    // names are distinctive enough that the Taiwan file dedupes on the name
    // alone; "John Smith, MD" is not. Two unrelated John Smiths in Florida and
    // New York would collapse into one row here. Cross-clinic identity
    // resolution is a real problem and is NOT solved in this file — it is left
    // visible rather than papered over with a guess.
    // ⭐ MATCH ON THE IDENTITY KEY, NOT THE RAW STRING. Within one page the
    // parser already collapses variants; across pages and hosts this is what
    // stops "John Hunter" and "John G. Hunter" becoming two rows. `identity_key`
    // is stored so the match is an indexed equality rather than a scan.
    const key = identityKey(name);
    const found = await sb(
      `doctors?select=id,credentials,name_en&country=eq.${encodeURIComponent(country)}` +
      `&identity_key=eq.${encodeURIComponent(key)}&limit=1`);
    let id = found && found.length ? found[0].id : null;

    if (!id) {
      const made = await sb('doctors', {
        method: 'POST',
        body: JSON.stringify({
          name_en: name,
          identity_key: key,
          credentials: p.credentials || null,
          country,
          source_url: sourceUrl,
          // Set explicitly; never rely on a column default.
          evidence_type: 'clinic_declared',
          review_status: 'approved',
          published: true
        })
      });
      id = made && made[0] && made[0].id;
      if (id) created++;
    } else {
      // Fill blanks, never overwrite. Same rule as the socials crawler. A fuller
      // spelling of the same person is an improvement, not a conflict.
      const patch = {};
      if (p.credentials && !found[0].credentials) patch.credentials = p.credentials;
      if (name.length > String(found[0].name_en || '').length) patch.name_en = name;
      if (Object.keys(patch).length) {
        await sb(`doctors?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal',
                                          body: JSON.stringify(patch) });
      }
    }
    if (!id) continue;

    const link = await sb(
      `clinic_doctors?select=id&clinic_id=eq.${encodeURIComponent(clinicId)}&doctor_id=eq.${id}&limit=1`);
    if (!link || !link.length) {
      await sb('clinic_doctors', {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ clinic_id: clinicId, doctor_id: id, title: p.title || null })
      });
      linked++;
    }
  }

  return { created, linked, skipped };
}

// ── One domain ──────────────────────────────────────────────────────────────
async function crawlOne(row) {
  const country = String(row.country || 'usa').toLowerCase();

  const home = await getPage(row.home_url);
  if (!home.ok) return { status: 'error', last_error: `home: ${home.error}` };

  const teamUrl = findTeamUrl(home.html, home.finalUrl) || home.finalUrl;
  const page = teamUrl === home.finalUrl ? home : await getPage(teamUrl);
  if (!page.ok) return { status: 'error', team_url: teamUrl, last_error: `team: ${page.error}` };

  const text = toText(page.html);
  if (text.length < 200) {
    // A JavaScript shell yields a title and a copyright line and nothing else.
    return { status: 'needs_render', team_url: teamUrl, last_error: 'page has almost no text' };
  }

  let providers = extractProviders(text);
  // A single-provider practice often names its doctor only on the homepage.
  if (!providers.length && teamUrl !== home.finalUrl) providers = extractProviders(toText(home.html));
  if (!providers.length) return { status: 'empty', team_url: teamUrl, doctors_found: 0 };

  if (providers.length > MAX_PLAUSIBLE_TEAM) {
    return {
      status: 'suspicious', team_url: teamUrl, doctors_found: providers.length,
      last_error: `yielded ${providers.length} names — likely a directory, not a roster; nothing landed`
    };
  }

  const { created, linked, skipped } = await land(providers, row.clinic_id, country, teamUrl);
  return {
    status: 'done', team_url: teamUrl, doctors_found: providers.length,
    created, linked, skipped,
    names: providers.slice(0, 6).map(p => p.name_en + (p.credentials ? ', ' + p.credentials : '')).join(' · ')
  };
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const json = (code, body) => ({
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const given = (event.headers || {})['x-admin-secret'] || (event.headers || {})['X-Admin-Secret'];
  if (!ADMIN_SECRET || given !== ADMIN_SECRET) return json(401, { error: 'unauthorised' });

  if (!SB || !SB_KEY) return json(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}

  // ⭐ PING: proves auth, deployment and env in one call, without a network
  // fetch or a queue claim. When a run fails with a bare "Failed to fetch" and
  // no status code, this separates "the function is unreachable" from "the
  // function is timing out doing real work".
  if (body.mode === 'ping') {
    return json(200, {
      ok: true, fn: 'crawl-doctors-na',
      node: process.version,
      has_supabase_url: !!SB, has_service_key: !!SB_KEY,
      batch_default: BATCH_DEFAULT, fetch_timeout_ms: FETCH_TIMEOUT_MS,
      run_budget_ms: RUN_BUDGET_MS
    });
  }

  const batch = Math.min(Math.max(parseInt(body.batch, 10) || BATCH_DEFAULT, 1), 8);
  const retry = body.retry === true;

  // ⭐⭐ COUNTRY IS REQUIRED, AND DEFAULTS TO NOTHING. crawl_queue is
  // multi-country now, and this file's parser is English-only — an unscoped
  // claim would happily run it over Taiwan hosts and write Latin-alphabet
  // fragments of Chinese pages into `doctors`. The Taiwan queue belongs to
  // crawl-doctors.js and this function must never touch it.
  const country = String(body.country || '').trim().toLowerCase();
  if (!country) return json(400, { error: 'country is required (usa | canada)' });
  if (country === 'taiwan' || country === 'hongkong') {
    return json(400, { error: `${country} uses crawl-doctors.js — this parser is English-only` });
  }
  const scope = `&country=eq.${encodeURIComponent(country)}`;

  // Optional second axis: the US is ~30,000 hosts, far too many for one sitting.
  const state = String(body.state || '').trim().toLowerCase();

  try {
    const want = retry ? 'in.(pending,error)' : 'eq.pending';
    let path = `crawl_queue?select=*&status=${want}${scope}&order=id.asc&limit=${batch}`;
    if (state) path += `&state=eq.${encodeURIComponent(state)}`;
    const claim = await sb(path);
    if (!claim || !claim.length) {
      return json(200, {
        done: true, processed: [], remaining: 0,
        note: `doctor queue empty for ${country}${state ? ' / ' + state : ''}`
      });
    }

    const ids = claim.map(r => r.id);
    await sb(`crawl_queue?id=in.(${ids.join(',')})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ status: 'running' })
    });

    const processed = [];
    const deadline = Date.now() + RUN_BUDGET_MS;
    for (const row of claim) {
      // Out of budget: hand the row back as pending rather than dying with it
      // marked 'running', which is unrecoverable without a manual reset.
      if (Date.now() > deadline) {
        await sb(`crawl_queue?id=eq.${row.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'pending' })
        });
        continue;
      }
      let result;
      try { result = await crawlOne(row); }
      catch (e) { result = { status: 'error', last_error: String(e.message || e).slice(0, 400) }; }

      await sb(`crawl_queue?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({
          status: result.status,
          team_url: result.team_url || null,
          doctors_found: result.doctors_found || 0,
          last_error: result.last_error || null,
          attempts: (row.attempts || 0) + 1,
          fetched_at: new Date().toISOString()
        })
      });

      processed.push({
        domain: row.domain,
        status: result.status,
        found: result.doctors_found || 0,
        created: result.created || 0,
        linked: result.linked || 0,
        skipped_as_shared: result.skipped || 0,
        team_url: result.team_url || null,
        names: result.names || null,
        error: result.last_error || null
      });
    }

    let pendPath = `crawl_queue?select=id&status=eq.pending${scope}`;
    if (state) pendPath += `&state=eq.${encodeURIComponent(state)}`;
    const pending = await sb(pendPath, { prefer: 'count=exact' });
    return json(200, {
      done: false, processed,
      remaining: (pending || []).length,
      country, state: state || 'all'
    });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 500) });
  }
};

// netlify/functions/crawl-socials.js
//
// Reads a clinic's OWN website for its official Facebook page, Instagram
// profile and LINE account. NO API KEY AND NO PER-PAGE COST: the extraction is
// a parser, exactly like crawl-doctors.js.
//
// Why only the clinic's own site. A social link on a clinic's own homepage IS
// that clinic's official account, by definition. Handles taken from search
// results or beauty aggregators are frequently a fan page, an agency's page, or
// a competitor, and there is no way to tell from the outside. So this function
// never searches for anything; it reads the page the clinic published.
//
// Contacts PUBLISH immediately, same reasoning as the doctors: a clinic
// advertising its own LINE account on its own website is public information and
// SkinDay republishes it rather than vouching for it.
//
// This function NEVER OVERWRITES an existing value. It only fills a column that
// is currently NULL, so the 405 contacts recovered in Phase 1 cannot be clobbered
// by a worse guess from a homepage footer.
//
// Queue: it claims on `social_status`, NOT on `status`. The doctor run's own
// per-domain history is left completely alone and either pass can be re-run.
//
// Environment variables, all three already set, nothing new needed:
//   SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · ADMIN_SECRET

const BATCH_DEFAULT = 5;
const FETCH_TIMEOUT_MS = 12000;

// If the same handle turns up on this many OTHER clinics, it is a shared
// plugin, an aggregator or a marketing agency's own account, not this clinic's.
// The doctor crawl's hard lesson was that any bulk extraction needs a
// plausibility check on its OUTPUT before it publishes.
const MAX_SHARED_CLINICS = 3;

// Chain domains are in the social queue (they were only ever excluded because a
// DOCTOR cannot be attributed to a branch; a chain's Facebook page can). When a
// domain is shared by several clinic rows, the contacts found on it are applied
// to every branch.
//
// LINE is the one channel where that is arguable, because branch-specific LINE
// accounts are common in Taiwan and a filled column will not be overwritten
// later by a better one. Set this to false to find chain LINE accounts and
// deliberately NOT land them; the log still names every one it saw.
const CHAIN_LINE_TO_ALL_BRANCHES = true;

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ── Encoding repair, identical in effect to the Phase 1 SQL ──────────────────
// %25 -> %  undoes double-encoding (%2540 -> %40).  %3F/%3D/%26 were reserved
// characters that something encoded by mistake. UTF-8 runs like %E5%85%89 are
// LEFT alone: that form is valid in a URL and works in a browser.
// Hrefs in real Taiwan clinic HTML arrive with HTML entities still in them, so
// `?a=1&#038;b=2` was being stored verbatim. Decode before anything parses it.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#0*38;|&amp;/gi, '&')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*35;/gi, '#')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

// A trailing %20 or stray whitespace makes the link 404.
function trimTail(u) {
  return String(u || '').replace(/(?:%20|\s|%09)+$/i, '');
}

// Any social "account" whose path is an asset is a button image, an embed
// script or a tracking pixel, never an account.
const ASSET_TAIL = /\.(gif|png|jpe?g|webp|svg|js|css|ico|json)$/i;

// Handles that belong to the tooling a clinic's site was built with, not to the
// clinic. Every one of these was actually landed by the first pass.
const VENDOR_HANDLE = new Set([
  'wix', 'settings', 'qr', 'simplybook', 'ancorathemes', 'squarespace',
  'shopify', 'wordpress', 'bio.sites', 'embed.js', 'facebook', 'instagram',
  'line', 'google', 'sharer', 'plugins', 'tr', 'business'
]);

function firstSeg(path) {
  return String(path || '').split('/')[0].split('?')[0].toLowerCase();
}

function repairEncoding(u) {
  return String(u || '')
    .replace(/%25/g, '%')
    .replace(/%3F/gi, '?')
    .replace(/%3D/gi, '=')
    .replace(/%26/gi, '&');
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

// Hostname with www. dropped, to compare against crawl_queue.domain, which is
// stored lowercased and www-stripped.
function bareHost(u) {
  try { return new URL(repairEncoding(String(u || ''))).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function pathOf(u) {
  try { return new URL(u).pathname.replace(/^\/+/, ''); } catch { return ''; }
}

// ── Facebook ────────────────────────────────────────────────────────────────
const FB_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|facebook\.net)$/;

// Anything here is not a clinic's page: share widgets, tracking pixels, the
// login wall, and content URLs. A GROUP is a forum and a POST is not a page.
const FB_REJECT = /\/(sharer|share_channel|dialog|plugins|tr|l\.php|login|recover|help|policies|privacy|terms|watch|events?|groups|marketplace|gaming|hashtag|story\.php|permalink\.php|photo|photos|video|videos|media|notes|reviews_page|pages\/create)(\/|$|\?|\.php)/i;

const FB_HOST_REJECT = /^(l|lm|developers|business|business-help|web|apps|connect|static|scontent|m\.static)\./i;

function fbCanon(raw) {
  const u = repairEncoding(raw);
  const host = hostOf(u);
  if (!FB_HOSTS.test(host)) return '';
  if (FB_HOST_REJECT.test(host)) return '';
  if (FB_REJECT.test(u)) return '';
  // A shared POST is not a page. share/<token>/ resolves to a page; share/p/ is a post.
  if (/\/share\/p\//i.test(u)) return '';

  let path = pathOf(u);
  path = path.split('#')[0];
  if (!path) return '';                       // bare facebook.com identifies nobody
  if (/\s|%20/.test(path)) return '';         // two urls jammed into one field
  if (ASSET_TAIL.test(path)) return '';       // an image or a script
  if (VENDOR_HANDLE.has(firstSeg(path))) return '';   // facebook.com/wix, /settings, /qr
  if (/^messages(\/|$)/i.test(path)) return '';       // a Messenger thread, not a page

  let out;
  if (/^profile\.php/i.test(path)) {
    const id = (u.match(/[?&]id=(\d+)/) || [])[1];
    if (!id) return '';
    out = 'profile.php?id=' + id;             // mibextid / locale / eav are tracking
  } else {
    // Drop a trailing page sub-tab so the link lands on the page itself.
    out = path.replace(/(posts|timeline|about|photos|videos|reviews|community)\/?$/i, '');
    if (!out || out === '/') return '';
  }
  return 'https://www.facebook.com/' + out;
}

// ── Instagram ───────────────────────────────────────────────────────────────
const IG_HOSTS = /(^|\.)(instagram\.com|instagr\.am)$/;
const IG_REJECT = /^(p|reel|reels|stories|explore|tv|accounts|direct|about|developer|legal|topics|directory)(\/|$)/i;

function igCanon(raw) {
  const u = repairEncoding(raw);
  if (!IG_HOSTS.test(hostOf(u))) return '';
  let path = pathOf(u).split('#')[0];
  if (!path) return '';
  path = path.replace(/profilecard\/?$/i, '');   // a share widget, not the profile
  if (!path || IG_REJECT.test(path)) return '';
  if (/\s|%20/.test(path)) return '';
  if (ASSET_TAIL.test(path)) return '';               // instagram.com/embed.js
  if (VENDOR_HANDLE.has(firstSeg(path))) return '';   // instagram.com/wix, /bio.sites
  return 'https://www.instagram.com/' + path.replace(/\/+$/, '');
}

// ── LINE ────────────────────────────────────────────────────────────────────
// The hard one, because a LINE account is very often NOT a URL at all.
// EXACT host whitelist, not a suffix match. The first pass landed
// tr.line.me tracking pixels, page-share.line.me og-images, an oashop.line.me
// storefront and a biz.line.naver.jp button IMAGE as clinic contacts, all of
// which are subdomains of a LINE domain and none of which is an account.
const LINE_HOSTS = new Set([
  'line.me', 'www.line.me', 'lin.ee', 'www.lin.ee',
  'page.line.me', 'liff.line.me', 'line.naver.jp', 'www.line.naver.jp'
]);
const LINE_REJECT = /\/(R\/msg|R\/share|R\/nv|R\/oaMessage|share|about|terms|privacy|download|ch\/sticker)(\/|$|\?)/i;

// Placeholder ids left in a template. Landed verbatim by the first pass.
const NOT_A_LINE_ID = new Set([
  '@12345678', '@1234567', '@abc123', '@yourid', '@lineid', '@line',
  '@callmeback', '@xxxx', '@0000000', '@example'
]);

function lineFromUrl(raw) {
  const u = repairEncoding(raw);
  const host = hostOf(u);
  if (!LINE_HOSTS.has(host)) return null;
  if (LINE_REJECT.test(u)) return null;
  const path = pathOf(u);
  if (!path) return null;                        // line.me itself is not an account
  if (ASSET_TAIL.test(path)) return null;        // a button image or a tracking gif

  // Query strings on a LINE link are tracking (openQrModal, oat_content, ts,
  // from=page). The only one that carries meaning is liff's accountId.
  const keepQuery = host === 'liff.line.me' && /accountId=/i.test(u);
  // line.naver.jp is LINE's legacy domain. It still resolves but redirects, so
  // fold it to line.me and keep one shape in the column.
  // A '#' fragment is never part of a LINE account, and every LINE host serves
  // https, so force it rather than storing whatever scheme the page used.
  const clean = trimTail(keepQuery ? u : u.split('?')[0])
    .split('#')[0]
    .replace(/^https?:\/\/(www\.)?line\.naver\.jp\//i, 'https://line.me/')
    .replace(/^http:\/\//i, 'https://');

  // An @id spelled out in the URL is the one thing we can claim as an id. A
  // lin.ee or page.line.me slug is NOT assumed to be the @id: it is a short
  // code, and inventing an id from it would send patients to a stranger.
  const at = (clean.match(/(?:%40|@|~%40|~@)([A-Za-z0-9._-]{2,20})/) || [])[1] || '';
  const id = at ? '@' + at : '';
  return { line_url: clean, line_id: NOT_A_LINE_ID.has(id.toLowerCase()) ? '' : id };
}

// A bare @id written next to the word LINE. "官方LINE：@abc123", "加LINE @xyz".
// The proximity requirement is what keeps a Facebook vanity handle or an email
// local-part out: one real clinic name in this directory reads 預約請加@ugb9932c
// and its FACEBOOK page is facebook.com/ugb9932c, so an @ on its own proves
// nothing about which platform it belongs to.
//
// TWO OF THESE KEYWORDS WERE TOO LOOSE, AND BOTH FIRE ON REAL DIRECTORY DATA.
// Found in M18.4 while mining clinics.name for the same handles:
//
//   1. Bare /line/i matches INSIDE ordinary words: online, timeline, guideline,
//      hairline, airline, headline. "線上預約 / online booking @handle" would be
//      read as a LINE id, and an online-booking line sits on a large share of
//      Taiwanese clinic sites. Now anchored \b on both sides, which still
//      matches "LINE：", "LINE官方" and "line@" because a full-width colon and
//      a CJK character are not ASCII word characters. \bline\s*id\b is kept
//      ahead of it so the run-together spelling "LINEID" still matches.
//
//   2. Bare 賴 is a COMMON TAIWANESE SURNAME, not only LINE slang. Across
//      clinics.name in this directory, 12 of the 16 hits on 賴 were doctors -
//      賴俊元 賴憲宏 賴柏如 賴炳文 賴雅薇 張賴妙珣 賴政光 - plus 信賴診所 and
//      博愛信賴美學, where 信賴 simply means "trust". On a page for 賴柏如醫師,
//      any @handle within 40 characters would have been written to that clinic
//      as its LINE id. 賴 now counts only when qualified - 加賴 官方賴 我的賴
//      私賴 搜尋賴 好友賴, or 賴 followed by id / 帳號. A surname is never
//      preceded by those, and the slang usage effectively always is.
//
// Duplicate 官方帳號 dropped, and line@ removed as redundant under \bline\b.
const LINE_NEAR = /(\bline\s*id\b|\bline\b|加好友|加入好友|官方帳號|(?:加|官方|我的|私|搜尋|好友)賴|賴\s*(?:id|帳號))/i;
const TLD_TAIL = /\.(com|net|org|tw|co|io|jp|kr|cn|edu|gov|me)$/i;

function lineFromText(text) {
  const re = /@([A-Za-z0-9._-]{3,20})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (TLD_TAIL.test(id)) continue;                       // an email address
    const before = text.charAt(m.index - 1);
    if (/[A-Za-z0-9._%+-]/.test(before)) continue;         // also an email address
    const ctx = text.slice(Math.max(0, m.index - 40), m.index + id.length + 10);
    if (!LINE_NEAR.test(ctx)) continue;
    if (NOT_A_LINE_ID.has(('@' + id).toLowerCase())) continue;
    return { line_url: '', line_id: '@' + id };
  }
  return null;
}

// ── Extraction ──────────────────────────────────────────────────────────────
function hrefs(html) {
  const out = [];
  const re = /(?:href|content|data-href|src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(trimTail(decodeEntities(m[1])));
  return out;
}

// Among several valid candidates, the shortest path is the account root:
// /drskin.ks beats /drskin.ks/photos, and a page beats a deep link.
function shortestPath(list) {
  return list.sort((a, b) =>
    (pathOf(a).split('/').filter(Boolean).length - pathOf(b).split('/').filter(Boolean).length)
    || (a.length - b.length))[0] || '';
}

function extractSocials(html, baseUrl, text) {
  const abs = [];
  for (const h of hrefs(html)) {
    if (!h || h.startsWith('#') || /^(mailto|tel|javascript):/i.test(h)) continue;
    try { abs.push(new URL(repairEncoding(h), baseUrl).href); } catch { /* ignore */ }
  }

  const fb = [...new Set(abs.map(fbCanon).filter(Boolean))];
  const ig = [...new Set(abs.map(igCanon).filter(Boolean))];

  const lineHits = abs.map(lineFromUrl).filter(Boolean);
  // A url that spells out an @id is worth more than a bare short code.
  lineHits.sort((a, b) => (b.line_id ? 1 : 0) - (a.line_id ? 1 : 0));
  const line = lineHits[0] || lineFromText(text) || null;

  return {
    facebook_url: shortestPath(fb),
    instagram_url: shortestPath(ig),
    line_url: line ? line.line_url : '',
    line_id: line ? line.line_id : ''
  };
}

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

async function getPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'SkinDayBot/1.0 (+https://skinday.com)' }
    });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    const html = await r.text();
    return { ok: true, html, finalUrl: r.url || url };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 120000);
}

// Socials usually sit in the header or footer of the homepage. When the
// homepage gives nothing, a contact page is the one other place worth a look,
// and only then, so the common case still costs a single fetch.
const CONTACT_HINTS = [
  ['聯絡我們', 100], ['聯絡方式', 100], ['預約諮詢', 95], ['線上預約', 95],
  ['聯絡', 85], ['預約', 80], ['諮詢', 75], ['contact', 85], ['booking', 70], ['about', 40]
];

function findContactUrl(html, baseUrl) {
  const links = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    if (/\/(blog|news|article|articles|post|posts|category|tag|archive|column|case|cases|video|activity|event|promo)(\/|$|\?)/i.test(href)
        || /[?&]p=\d|[?&]page_id=/i.test(href)) continue;
    let a;
    try { a = new URL(href, baseUrl).href; } catch { continue; }
    try { if (new URL(a).hostname !== new URL(baseUrl).hostname) continue; } catch { continue; }
    const hay = (decodeURIComponent(a) + ' ' + label).toLowerCase();
    let score = 0;
    for (const [w, s] of CONTACT_HINTS) if (hay.includes(w.toLowerCase())) score = Math.max(score, s);
    if (score) links.push({ a, score });
  }
  links.sort((x, y) => y.score - x.score);
  return links.length ? links[0].a : null;
}

// ── Plausibility, before anything publishes ─────────────────────────────────
// A chain's page legitimately appears on all of its own branches, so the
// branches themselves must be excluded from the count or the second branch
// would look like evidence of a shared plugin.
async function isShared(column, value, excludeIds) {
  let q = `clinics?select=id&country=eq.taiwan&${column}=eq.` + encodeURIComponent(value);
  if (excludeIds.length) q += `&id=not.in.(${excludeIds.map(encodeURIComponent).join(',')})`;
  const rows = await sb(q + `&limit=${MAX_SHARED_CLINICS + 1}`);
  return (rows || []).length >= MAX_SHARED_CLINICS;
}

// ── Who receives what this domain published ─────────────────────────────────
// Every Taiwan clinic whose website sits on this exact host. PostgREST can only
// do a substring match here, and substring-matching a hostname is precisely the
// bug that once killed beautybox.com.tw for containing "x.com", so the host is
// re-checked EXACTLY in JS before any row is accepted as a branch.
async function siblingsFor(domain, clinicId) {
  const cols = 'id,name,website,facebook_url,instagram_url,line_url,line_id';
  const rows = await sb(`clinics?select=${cols}&country=eq.taiwan&website=ilike.`
    + encodeURIComponent('*' + domain + '*') + '&limit=200') || [];
  const sibs = rows.filter(r => bareHost(r.website) === domain);
  if (!sibs.some(r => String(r.id) === String(clinicId))) {
    const own = await sb(`clinics?select=${cols}&country=eq.taiwan`
      + `&id=eq.${encodeURIComponent(clinicId)}`);
    if (own && own.length) sibs.push(own[0]);
  }
  return sibs;
}

// ── Landing. Fills NULL columns only, never overwrites. ─────────────────────
async function land(found, row) {
  const targets = await siblingsFor(row.domain, row.clinic_id);
  if (!targets.length) return { landed: 0, branches: 0, skipped: ['no taiwan clinic on this domain'] };

  const ids = targets.map(t => String(t.id));
  const isChain = targets.length > 1;
  const skipped = [];
  const allow = {};

  if (found.facebook_url) {
    if (await isShared('facebook_url', found.facebook_url, ids)) skipped.push('facebook shared');
    else allow.facebook_url = found.facebook_url;
  }
  if (found.instagram_url) {
    if (await isShared('instagram_url', found.instagram_url, ids)) skipped.push('instagram shared');
    else allow.instagram_url = found.instagram_url;
  }
  const lineBlocked = isChain && !CHAIN_LINE_TO_ALL_BRANCHES;
  if (lineBlocked && (found.line_url || found.line_id)) {
    skipped.push('chain LINE found but held back by CHAIN_LINE_TO_ALL_BRANCHES');
  } else {
    if (found.line_url) {
      if (await isShared('line_url', found.line_url, ids)) skipped.push('line shared');
      else allow.line_url = found.line_url;
    }
    if (found.line_id && !skipped.includes('line shared')) allow.line_id = found.line_id;
  }

  let landed = 0, branches = 0;
  const fieldNames = new Set();

  for (const t of targets) {
    const patch = {};
    for (const k of Object.keys(allow)) if (!t[k]) patch[k] = allow[k];
    const keys = Object.keys(patch);
    if (!keys.length) continue;
    await sb(`clinics?id=eq.${encodeURIComponent(t.id)}&country=eq.taiwan`, {
      method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch)
    });
    landed += keys.length;
    branches += 1;
    keys.forEach(k => fieldNames.add(k));
  }

  return { landed, branches, skipped, fields: [...fieldNames], isChain, targetCount: targets.length };
}

// ── One domain ──────────────────────────────────────────────────────────────
async function crawlOne(row) {
  const home = await getPage(row.home_url);
  if (!home.ok) return { social_status: 'error', social_error: `home: ${home.error}` };

  const homeText = toText(home.html);
  let found = extractSocials(home.html, home.finalUrl, homeText);
  let source = home.finalUrl;

  const nothing = f => !f.facebook_url && !f.instagram_url && !f.line_url && !f.line_id;

  if (nothing(found)) {
    const contactUrl = findContactUrl(home.html, home.finalUrl);
    if (contactUrl && contactUrl !== home.finalUrl) {
      const page = await getPage(contactUrl);
      if (page.ok) {
        const t = toText(page.html);
        const second = extractSocials(page.html, page.finalUrl, t);
        if (!nothing(second)) { found = second; source = page.finalUrl; }
      }
    }
  }

  if (nothing(found)) {
    if (homeText.length < 200) {
      return { social_status: 'needs_render', socials_found: 0,
               social_error: 'page has almost no text' };
    }
    return { social_status: 'empty', socials_found: 0 };
  }

  const { landed, branches, skipped, fields, targetCount } = await land(found, row);

  if (!landed && skipped.length) {
    return { social_status: 'suspicious', socials_found: 0, branches: 0,
             social_error: 'nothing landed: ' + skipped.join(', ') };
  }
  if (!landed) {
    // Everything found was already on file. Not a failure, and not new data.
    return { social_status: 'done', socials_found: 0, branches: 0,
             social_error: 'all channels already on file', found, source };
  }

  return {
    social_status: 'done',
    socials_found: landed,
    branches,
    social_error: skipped.length ? 'partly held back: ' + skipped.join(', ') : null,
    fields: fields || [],
    targetCount,
    found,
    source
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
  const batch = Math.min(Math.max(parseInt(body.batch, 10) || BATCH_DEFAULT, 1), 8);
  const retry = body.retry === true;

  try {
    const want = retry ? 'in.(pending,error)' : 'eq.pending';
    const claim = await sb(`crawl_queue?select=*&social_status=${want}&order=id.asc&limit=${batch}`);
    if (!claim || !claim.length) {
      return json(200, { done: true, processed: [], remaining: 0, note: 'social queue empty' });
    }

    const ids = claim.map(r => r.id);
    await sb(`crawl_queue?id=in.(${ids.join(',')})`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ social_status: 'running' })
    });

    const processed = [];
    for (const row of claim) {
      let result;
      try { result = await crawlOne(row); }
      catch (e) { result = { social_status: 'error', social_error: String(e.message || e).slice(0, 400) }; }

      await sb(`crawl_queue?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({
          social_status: result.social_status,
          socials_found: result.socials_found || 0,
          social_error: result.social_error || null,
          social_fetched_at: new Date().toISOString()
        })
      });

      const f = result.found || {};
      processed.push({
        domain: row.domain,
        status: result.social_status,
        found: result.socials_found || 0,
        fields: (result.fields || []).join(', '),
        branches: result.branches || 0,
        clinics_on_domain: result.targetCount || 0,
        facebook: f.facebook_url || null,
        instagram: f.instagram_url || null,
        line: f.line_url || f.line_id || null,
        source: result.source || null,
        error: result.social_error || null
      });
    }

    const pending = await sb('crawl_queue?select=id&social_status=eq.pending',
      { prefer: 'count=exact' });
    return json(200, { done: false, processed, remaining: (pending || []).length });
  } catch (e) {
    return json(500, { error: String(e.message || e).slice(0, 500) });
  }
};

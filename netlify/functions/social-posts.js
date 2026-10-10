// ===========================================================================
// social-posts.js  -  SkinDay M25 social media crawl (Netlify Function)
//
// Deploy to /netlify/functions/social-posts.js. Driven by the Social tab in
// skinday-global-admin.html, gated on x-admin-secret.
//
// Reads recent posts from clinics' own Facebook pages and Instagram accounts
// through Apify, finds device mentions in them, and holds every mention for
// approve / reject. Approved mentions go into clinic_devices with
// source = 'social', dated to the day the POST was published, so the dashboard
// sees a device within days of a clinic announcing it.
//
// Apify runs take minutes, longer than a function may live, so the flow is:
//   start   -> sends the pages to Apify, stores the run
//   poll    -> asks Apify whether the run has finished
//   collect -> reads the finished run 400 posts per call (the tab loops it)
//
// The device list is READ FROM device_reference at runtime (model, aliases and
// the Chinese name_zh), so a wrong alias is a SQL update, never a redeploy.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_SECRET (already set)
//      APIFY_TOKEN  (from apify.com -> Settings -> API & Integrations)
//      SCRAPECREATORS_API_KEY  (second provider, 2026-09-28)
//
// SCRAPECREATORS is a plain API: one request returns a page of posts straight
// away (Instagram ~12, Facebook 3), 1 credit each. There is no run to wait for,
// so the flow is sc-start (picks the accounts) then sc-step repeatedly, a few
// accounts per call, until the run is done.
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');

// Bump whenever matching changes, so two runs are only compared like for like.
const MATCHER_VERSION = '2026-09-26-social-v3';   // v3: hashtags count

const ACTORS = {
  facebook: 'apify~facebook-posts-scraper',
  instagram: 'apify~instagram-post-scraper'
};
const APIFY = 'https://api.apify.com/v2';
const SCRAPECREATORS = 'https://api.scrapecreators.com';
// One call must finish inside the function limit (26s): no new request starts
// after SC_FETCH_MS, and no single request may run past SC_REQUEST_MS, which
// leaves time to save and match what was read. At 5.5s a Facebook account got
// two requests (6 posts) before the clock stopped it.
const SC_FETCH_MS = 14000;
const SC_REQUEST_MS = 7000;
// Accounts read at once per call. They run side by side, so three Facebook
// accounts take no longer than one did.
const SC_BATCH = { instagram: 10, facebook: 8 };
// An account the clock cut off is picked up again from where it stopped, at
// most this many times, instead of being left short.
const SC_MAX_RESUMES = 2;

const COLLECT_PAGE = 400;
const MAX_PAGES_PER_RUN = 1000;
const MAX_POSTS_PER_PAGE = 50;

// Single English words that are also ordinary words. A bare hit on one of these
// is not evidence of a machine. Same list as the website crawler.
const RISKY_SINGLE_WORD = new Set([
  'elite', 'icon', 'halo', 'forma', 'genius', 'evolve', 'opus', 'clarity',
  'prime', 'secret', 'legacy', 'bliss', 'versa', 'accent', 'harmony', 'hybrid',
  'tetra', 'spectra', 'mosaic', 'profound', 'ultra'
]);

// A post carrying one of these is a comparison or an explainer ("鳳凰電波 vs
// 美國音波 差在哪"), not an announcement. Its mentions are kept but flagged, and
// "approve all" leaves them for a human.
const COMPARISON_CUES = [
  ' vs ', 'vs.', 'versus', '比較', '差別', '差異', '哪個好', '差在哪', '怎麼選',
  '選哪', 'compare', 'difference'
];

// ---------------------------------------------------------------------------
// Text normalisation and matching
// ---------------------------------------------------------------------------

const CJK = /[㐀-鿿]/;

// NFKC folds full-width letters (ＵＬＴＨＥＲＡＰＹ) and full-width digits to ASCII,
// which Taiwanese posts use constantly. 臺 is folded to 台 so either spelling hits.
function base(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[®™℠©]/g, ' ')
    .replace(/臺/g, '台')
    .toLowerCase();
}
// Spaced form: anything that is not a letter, digit or CJK becomes one space.
function spaced(s) {
  return ' ' + base(s).replace(/\+/g, ' plus ').replace(/[^a-z0-9㐀-鿿]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
// Jammed form: spaces removed, for Chinese names that posts write with or
// without spaces ("E電波", "E 電波").
function jammed(s) {
  return spaced(s).replace(/ /g, '');
}

function buildMatcher(devices) {
  const entries = [];
  for (const d of devices) {
    if (d.active === false) continue;
    const corrob = new Set((d.corroborate_aliases || []).map(a => spaced(a).trim()));
    const excl = (d.exclusion_phrases || []).map(p => jammed(p)).filter(Boolean);
    const names = [d.model, ...(d.model_aliases || [])];
    if (d.name_zh) names.push(d.name_zh);
    // The Chinese label wins a tie with another device's alias: 鳳凰電波 is the
    // label on Thermage FLX and also an alias on the older Thermage row.
    const zh = d.name_zh ? spaced(d.name_zh).trim().replace(/ /g, '') : null;
    const seen = new Set();
    for (const name of names) {
      if (!name) continue;
      const hasCjk = CJK.test(name);
      const variants = new Set([spaced(name).trim()]);
      if (!hasCjk) {
        // Morpheus8 / Morpheus 8
        const v = spaced(name).trim();
        variants.add(v.replace(/([a-z]) (\d)/g, '$1$2'));
        variants.add(v.replace(/([a-z])(\d)/g, '$1 $2'));
      }
      for (const tok of variants) {
        if (!tok || seen.has(tok)) continue;
        seen.add(tok);
        if (hasCjk) {
          const j = tok.replace(/ /g, '');
          if (j.length < 3) continue;                           // G動28, E電波, 索夫波 are the short ones
          entries.push({ kind: 'cjk', token: j, device_id: d.id, surface: name, excl, prio: j === zh ? 1 : 0 });
        } else {
          if (tok.length < 3) continue;
          const single = tok.indexOf(' ') === -1;
          // A bare single word that is also an ordinary word never counts here:
          // unlike the website crawl there is no review page context to lean on.
          if (single && (d.name_is_also_generic || RISKY_SINGLE_WORD.has(tok) || corrob.has(tok))) continue;
          entries.push({ kind: 'latin', token: tok, device_id: d.id, surface: name, excl, prio: 0 });
        }
      }
    }
  }
  // Longest first, so "thermage flx" claims the span before "thermage" can.
  entries.sort((a, b) => (b.token.length - a.token.length) || (b.prio - a.prio));
  return entries;
}

function overlaps(spans, a, b) {
  return spans.some(([s, e]) => a < e && b > s);
}

function isLatinChar(c) { return !!c && /[a-z0-9]/.test(c); }

function nearExclusion(hayJ, at, len, excl) {
  if (!excl || !excl.length) return false;
  const win = hayJ.slice(Math.max(0, at - 30), Math.min(hayJ.length, at + len + 30));
  return excl.some(x => x && win.indexOf(x) !== -1);
}

// Returns [{device_id, surface}] for one post, plus a comparison flag.
function matchPost(text, matcher) {
  const hayS = spaced(text);
  const hayJ = jammed(text);
  const spansS = [], spansJ = [];
  const hits = new Map();
  for (const e of matcher) {
    if (e.kind === 'latin') {
      const needle = ' ' + e.token + ' ';
      let from = 0;
      for (;;) {
        const at = hayS.indexOf(needle, from);
        if (at === -1) break;
        from = at + 1;
        const a = at + 1, b = at + 1 + e.token.length;
        if (overlaps(spansS, a, b)) continue;
        spansS.push([a, b]);
        const jAt = hayJ.indexOf(e.token.replace(/ /g, ''));
        if (jAt !== -1 && nearExclusion(hayJ, jAt, e.token.length, e.excl)) continue;
        if (!hits.has(e.device_id)) hits.set(e.device_id, e.surface);
      }
    } else {
      let from = 0;
      for (;;) {
        const at = hayJ.indexOf(e.token, from);
        if (at === -1) break;
        from = at + 1;
        const b = at + e.token.length;
        // A token that starts or ends with a Latin letter must not sit inside a
        // longer word: "E電波" must not fire on "LINE電波".
        if (isLatinChar(e.token[0]) && isLatinChar(hayJ[at - 1])) continue;
        if (isLatinChar(e.token[e.token.length - 1]) && isLatinChar(hayJ[b])) continue;
        if (overlaps(spansJ, at, b)) continue;
        spansJ.push([at, b]);
        if (nearExclusion(hayJ, at, e.token.length, e.excl)) continue;
        if (!hits.has(e.device_id)) hits.set(e.device_id, e.surface);
      }
    }
  }
  const low = ' ' + base(text) + ' ';
  const comparison = hits.size >= 1 && COMPARISON_CUES.some(c => low.indexOf(c) !== -1);
  return { hits: [...hits].map(([device_id, surface]) => ({ device_id, surface })), comparison };
}

// ---------------------------------------------------------------------------
// Evidence type (M25 step 38)
//
// Every mention gets a type and a confidence. Only COMPARISON is weak and never
// puts a device on a clinic's profile by itself. hashtag_only (the product only
// appears in the post's hashtags) used to be weak too; Andy, 2026-09-26: a
// clinic tagging a brand on its OWN account counts, same as naming it. Every
// account read here is a clinic's own, so hashtags publish like any mention.
// Rules decide the obvious cases; posts with no cue at all stay "mention" and
// can be refined by the AI pass (classify-ai), which only changes the type used
// for analytics, never what is published.
// ---------------------------------------------------------------------------

const EVIDENCE_CONFIDENCE = {
  announcement: 0.9, promotion: 0.8, before_after: 0.75, education: 0.6,
  mention: 0.55, comparison: 0.3, hashtag_only: 0.2
};
const WEAK_EVIDENCE = new Set(['comparison']);

// Checked near the product (within ~160 characters either side).
const ANNOUNCE_CUES = [
  'now available', 'now offering', 'now offer', 'introducing', 'introduce', 'welcome our new', 'welcoming our new',
  'new to our', 'newest', 'just arrived', 'has arrived', 'finally here', 'now here', 'now at ',
  'excited to announce', 'excited to offer', 'excited to bring', 'excited to introduce', 'excited to share our new',
  'proud to offer', 'proud to announce', 'proud to introduce', 'latest addition', 'new addition', 'new technology',
  'new device', 'new machine', 'new treatment', 'launch', 'maintenant disponible', 'nouveau', 'nouvelle',
  'nous sommes fiers', '新引進', '引進', '全新', '新到', '登場', '正式上線', '新儀器', '新設備'
];
const BEFORE_AFTER_CUES = [
  'before and after', 'before & after', 'before/after', 'before + after', 'b&a', 'before after', 'results after',
  'after 1 session', 'after one session', 'after 2 sessions', 'after two sessions', 'after 3 sessions',
  'avant/après', 'avant et après', 'avant-après', '術前術後', '術前', '術後', '前後對比', '治療前後'
];
// Checked anywhere in the post.
const PROMO_CUES = [
  'book', 'booking', 'appointment', 'dm us', 'dm to', 'call us', 'call now', 'reserve', 'link in bio',
  '% off', 'off ', 'sale', 'special', 'promo', 'offer', 'limited time', 'package', 'save ', 'deal', 'gift card',
  'consultation', 'price', '$', 'réservez', 'rabais', 'promotion', '優惠', '預約', '限時', '特價', '活動價'
];
const EDU_CUES = [
  'what is', "what's", 'how does', 'how it works', 'did you know', 'faq', 'myth', 'benefits of', 'good candidate',
  'who is it for', 'what to expect', 'aftercare', 'downtime', 'qu\'est-ce', '什麼是', '你知道', '原理', '適合'
];

// Runs of two or more hashtags, with whatever emoji or punctuation sits between them.
const HASHTAG_RUN = /(?:#[\p{L}\p{N}_]+(?:[\s\p{S}]|(?!#)\p{P})*){2,}/gu;

function stripHashtagRuns(text) {
  return String(text || '').replace(HASHTAG_RUN, ' ');
}

function anyCue(low, cues) {
  return cues.some(c => low.indexOf(c) !== -1);
}

// text: the whole post; matched: the device ids found in the post WITHOUT its
// hashtag runs (from matchPost on stripHashtagRuns(text)); surface: the name
// that matched; comparison: the post-level flag.
function classifyMention(text, deviceId, surface, comparison, matchedWithoutTags) {
  if (!matchedWithoutTags.has(deviceId)) return 'hashtag_only';
  if (comparison) return 'comparison';
  const low = base(stripHashtagRuns(text));
  const s = base(surface || '').trim();
  let at = s ? low.indexOf(s) : -1;
  if (at === -1 && s) at = low.indexOf(s.split(' ')[0]);
  const near = at === -1 ? low : low.slice(Math.max(0, at - 160), at + s.length + 160);
  if (anyCue(near, ANNOUNCE_CUES)) return 'announcement';
  if (anyCue(near, BEFORE_AFTER_CUES)) return 'before_after';
  if (anyCue(low, PROMO_CUES)) return 'promotion';
  if (anyCue(low, EDU_CUES)) return 'education';
  return 'mention';
}

// Classifies every hit in one post. matcher is the same one matchPost used.
function classifyPost(text, hits, comparison, matcher) {
  const withoutTags = new Set(matchPost(stripHashtagRuns(text), matcher).hits.map(h => h.device_id));
  const out = new Map();
  for (const h of hits) {
    const type = classifyMention(text, h.device_id, h.surface, comparison, withoutTags);
    out.set(h.device_id, { evidence_type: type, confidence: EVIDENCE_CONFIDENCE[type] });
  }
  return out;
}

// Postgres rejects a JSON body holding half an emoji (a lone UTF-16 surrogate)
// or a NUL character: "invalid input syntax for type json". Captions can carry
// either, and cutting text to length can split an emoji in two. Every string
// that goes to the database passes through here, after any cutting.
function clean(v) {
  if (v == null) return v;
  return String(v)
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '')
    .replace(/(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1')
    .replace(/\u0000/g, '');
}

function snippetFor(text, surface) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const lowT = base(t);
  const s = base(surface).trim();
  let at = s ? lowT.indexOf(s) : -1;
  if (at === -1 && s) at = lowT.indexOf(s.split(' ')[0]);
  if (at === -1) return clean(t.slice(0, 160));
  const from = Math.max(0, at - 60);
  return clean((from > 0 ? '…' : '') + t.slice(from, at + s.length + 80) + (at + s.length + 80 < t.length ? '…' : ''));
}

// ---------------------------------------------------------------------------
// Page keys
// ---------------------------------------------------------------------------

// Facebook paths that are never a clinic's page.
const FB_NOT_A_PAGE = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'groups', 'events', 'watch',
  'photo', 'photo.php', 'story.php', 'login', 'login.php', 'dialog', 'search', 'security', 'help',
  'policies', 'privacy', 'legal', 'lite', 'home.php', 'terms', 'about', 'ads', 'settings', 'business', 'plugins', 'tr', 'hashtag', 'marketplace']);
// Website builders, theme sellers and other vendors whose social links sit in
// a template footer and get picked up as the clinic's own account. Found in the
// Canada audit of 28 Sep 2026 (Alibaba was attached to three clinics).
const SOCIAL_VENDORS = new Set(['squarespace', 'wixstudio', 'wix', 'wordpresscom', 'wordpressdotcom',
  'wordpress', 'strikingly', 'qodeinteractive', 'themerex_net', 'themerex', 'shopify', 'godaddy',
  'weebly', 'elementor', 'envato', 'themeforest', 'alibaba.comglobal', 'alibaba.com_official',
  'facebook', 'instagram', 'meta']);

function facebookKey(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname) && !/(^|\.)fb\.com$/i.test(u.hostname)) return null;
  let path = u.pathname.replace(/\/+$/, '');
  try { path = decodeURIComponent(path); } catch (e) {}
  if (/^\/profile\.php$/i.test(path)) {
    const id = u.searchParams.get('id');
    if (!id) return null;
    return { key: 'profile:' + id, url: 'https://www.facebook.com/profile.php?id=' + id };
  }
  // /pages/Name/12345 and /p/Name-12345 keep their full path; otherwise the
  // first segment is the page.
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return null;
  const first = segs[0].toLowerCase();
  if (FB_NOT_A_PAGE.has(first) || SOCIAL_VENDORS.has(first)) return null;
  // /pages/Name/123, /p/Name-123 and /people/Name/123 are real pages only with
  // the name after them. A bare /people or /pages is a link to Facebook itself
  // (26 Canadian clinics had exactly that), and before this every
  // /people/... page collapsed into one key, "/people".
  const nested = (first === 'pages' || first === 'p' || first === 'people');
  if (nested && segs.length < 2) return null;
  const keep = nested ? segs.slice(0, 3) : segs.slice(0, 1);
  const p = '/' + keep.join('/');
  return { key: p.toLowerCase(), url: 'https://www.facebook.com' + encodeURI(p) };
}

function instagramKey(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  const user = segs[0].toLowerCase();
  if (['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv'].includes(user)) return null;
  if (SOCIAL_VENDORS.has(user)) return null;
  if (!/^[a-z0-9._]{1,30}$/.test(user)) return null;
  return { key: user, url: 'https://www.instagram.com/' + user + '/' };
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function pageAll(build, size) {
  const PAGE = size || 1000, out = [];
  for (let from = 0; from < 200000; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function selectIn(supabase, table, cols, col, values) {
  const out = [];
  const vals = [...new Set(values)];
  for (let i = 0; i < vals.length; i += 150) {
    const { data, error } = await supabase.from(table).select(cols).in(col, vals.slice(i, i + 150));
    if (error) throw new Error(error.message);
    out.push(...(data || []));
  }
  return out;
}

async function apify(path, opts) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not set in Netlify environment variables');
  const res = await fetch(APIFY + path, Object.assign({}, opts, {
    headers: Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {})
  }));
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  if (!res.ok) throw new Error('Apify ' + res.status + ': ' + (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)));
  return body;
}


// ---------------------------------------------------------------------------
// ScrapeCreators
// ---------------------------------------------------------------------------

async function scrapeCreators(path, params) {
  const key = process.env.SCRAPECREATORS_API_KEY;
  if (!key) throw new Error('SCRAPECREATORS_API_KEY is not set in Netlify environment variables');
  const qs = new URLSearchParams();
  Object.keys(params || {}).forEach(k => { if (params[k] != null && params[k] !== '') qs.set(k, params[k]); });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SC_REQUEST_MS);
  let res, text;
  try {
    res = await fetch(SCRAPECREATORS + path + '?' + qs.toString(), { headers: { 'x-api-key': key }, signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'ScrapeCreators took longer than ' + (SC_REQUEST_MS / 1000) + 's' : String(e && e.message || e));
  } finally {
    clearTimeout(timer);
  }
  let body; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (!res.ok || body.success === false) {
    const msg = (body && (body.message || body.error)) || String(text).slice(0, 200);
    const err = new Error('ScrapeCreators ' + res.status + ': ' + msg);
    err.status = res.status;
    err.credits = Number(body && body.credits_charged) || 0;
    throw err;
  }
  return body;
}

// "1 month", "3 months", "2 weeks", "30 days" -> the oldest date to keep.
function cutoffFrom(newerThan) {
  const m = String(newerThan || '1 month').match(/(\d+)\s*(day|week|month|year)/i);
  const n = m ? parseInt(m[1], 10) : 1, unit = m ? m[2].toLowerCase() : 'month';
  const days = unit === 'day' ? n : unit === 'week' ? n * 7 : unit === 'year' ? n * 365 : n * 30;
  return new Date(Date.now() - days * 864e5);
}

function scInstagramPost(pageKey, it) {
  const code = it.code || it.shortcode || null;
  const t = it.created_at || (it.taken_at ? new Date(Number(it.taken_at) * 1000).toISOString() : null);
  return {
    page_key: pageKey,
    // Same key Apify stores (the shortcode), so the two providers never
    // save one post twice.
    post_key: String(code || it.pk || it.id || ''),
    post_url: it.url || (code ? 'https://www.instagram.com/p/' + code + '/' : null),
    posted_at: t,
    text: (it.caption && (it.caption.text || '')) || ''
  };
}

function scFacebookPost(pageKey, it) {
  const t = it.publishTime ? new Date(Number(it.publishTime) * 1000).toISOString() : (it.time || null);
  return {
    page_key: pageKey,
    post_key: String(it.post_id || it.id || it.permalink || it.url || ''),
    post_url: clean(it.permalink || it.url) || null,
    posted_at: t,
    text: it.text || it.message || ''
  };
}

// Reads one account's recent posts, page after page, until it has enough, has
// gone past the date window, or runs out of time. Never throws: an account that
// fails (deleted, private, blocked) is reported and the run carries on.
async function scReadAccount(platform, page, perPage, cutoff, deadline, startCursor) {
  const out = []; let credits = 0, cursor = startCursor || null, error = null, requests = 0, more = false, cutOff = false;
  try {
    while (out.length < perPage && Date.now() < deadline && requests < 8) {
      requests++;
      let body, items, next;
      if (platform === 'instagram') {
        body = await scrapeCreators('/v2/instagram/user/posts', { handle: page.page_key, next_max_id: cursor });
        items = (body.items || []).map(it => scInstagramPost(page.page_key, it));
        next = body.more_available ? body.next_max_id : null;
      } else {
        body = await scrapeCreators('/v1/facebook/profile/posts', { url: page.url, cursor: cursor });
        items = (body.posts || []).map(it => scFacebookPost(page.page_key, it));
        next = body.cursor || null;
      }
      credits += Number(body.credits_charged) || 1;
      const inWindow = items.filter(p => p.post_key && (!p.posted_at || new Date(p.posted_at) >= cutoff));
      out.push(...inWindow);
      // Pinned posts can be old, so stop only when the NEWEST post on this page
      // of results is already outside the window, or nothing more is offered.
      const newest = items.reduce((a, p) => (p.posted_at && (!a || p.posted_at > a)) ? p.posted_at : a, null);
      if (!next || !items.length || (newest && new Date(newest) < cutoff)) { more = false; break; }
      cursor = next; more = true;
    }
    // Stopped by the clock with more posts still in the window: say so, so an
    // undercount is visible rather than silent.
    if (more && out.length < perPage && Date.now() >= deadline) {
      cutOff = true;
      error = 'stopped at the time limit after ' + out.length + ' posts';
    }
  } catch (e) {
    error = e.message; credits += e.credits || 0;
  }
  const seen = new Set();
  const uniq = out.filter(p => !seen.has(p.post_key) && seen.add(p.post_key));
  return { posts: uniq.slice(0, perPage), credits, error, cutOff, cursor: cutOff ? cursor : null };
}

async function scStart(supabase, body) {
  const country = body.country || 'canada';
  const platform = body.platform === 'instagram' ? 'instagram' : 'facebook';
  const nPages = Math.min(Math.max(parseInt(body.pages, 10) || 50, 1), MAX_PAGES_PER_RUN);
  const perPage = Math.min(Math.max(parseInt(body.posts_per_page, 10) || 15, 1), MAX_POSTS_PER_PAGE);
  const newerThan = String(body.newer_than || '1 month').slice(0, 20);
  const compare = !!body.compare;

  await syncPages(supabase, country);

  // COMPARE picks accounts Apify has already read, most recently first, so the
  // two providers can be set side by side on the same accounts and window.
  // Otherwise: never-read accounts first, then the ones read longest ago.
  let pages, error;
  if (compare) {
    // ⛔ WHAT THIS REPLACES: "accounts with a last run, most recent first". A
    // FAILED Apify run still stamps its accounts, so the first ScrapeCreators
    // test (#18) compared against 15 accounts Apify never actually read and
    // reported "earlier read had 0" for all of them. Now: only accounts Apify
    // really returned posts for in the same window, sampled at random.
    const cutoff = cutoffFrom(newerThan);
    const { data: scRuns } = await supabase.from('social_crawl_runs').select('id').eq('provider', 'scrapecreators');
    const scIds = new Set((scRuns || []).map(r => r.id));
    const { data: held, error: hErr } = await supabase.from('social_posts')
      .select('page_key, run_id').eq('platform', platform)
      .gte('posted_at', cutoff.toISOString()).limit(20000);
    if (hErr) throw new Error(hErr.message);
    const keys = Array.from(new Set((held || []).filter(r => !scIds.has(r.run_id)).map(r => r.page_key)));
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); const t = keys[i]; keys[i] = keys[j]; keys[j] = t;
    }
    const res = await byState(supabase.from('social_pages').select('page_key, url')
      .eq('country', country).eq('platform', platform), body)
      .in('page_key', keys.slice(0, Math.min(keys.length, nPages * 4)));
    error = res.error;
    pages = (res.data || []).slice(0, nPages);
  } else {
    // The monthly read: only accounts not read in the last N days (25 by
    // default), the same rule the "still to read" count uses.
    const dueBefore = new Date(Date.now() - skipDays(body) * 864e5).toISOString();
    const res = await byState(supabase.from('social_pages').select('page_key, url')
      .eq('country', country).eq('platform', platform), body)
      .or('last_requested_at.is.null,last_requested_at.lt.' + dueBefore)
      .or('missing_since.is.null,missing_since.lt.' + new Date(Date.now() - 90 * 864e5).toISOString())
      .order('last_requested_at', { ascending: true, nullsFirst: true })
      .order('page_key', { ascending: true }).limit(nPages);
    error = res.error; pages = res.data;
  }
  if (error) throw new Error(error.message);
  if (!pages || !pages.length) return { error: 'no ' + platform + ' pages found for ' + country };

  const { data: run, error: rErr } = await supabase.from('social_crawl_runs').insert({
    platform, country, pages: pages.length, posts_per_page: perPage,
    newer_than: newerThan, matcher_version: MATCHER_VERSION, status: 'RUNNING',
    provider: 'scrapecreators', page_keys: pages.map(p => p.page_key),
    compare_mode: compare, collect_offset: 0, credits_used: 0,
    compare_apify_posts: 0, compare_overlap: 0
  }).select('id').single();
  if (rErr) throw new Error(rErr.message);
  return { run_id: run.id, pages: pages.length, platform, compare };
}

async function scStep(supabase, body) {
  const t0 = Date.now();
  const id = parseInt(body.run_id, 10);
  const { data: run, error } = await supabase.from('social_crawl_runs').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  if (run.provider !== 'scrapecreators') return { error: 'run #' + id + ' is not a ScrapeCreators run' };
  if (run.status === 'collected') return { done: true, run };

  const platform = run.platform;
  const keys = run.page_keys || [];
  const from = run.collect_offset || 0;
  const size = SC_BATCH[platform] || 2;
  // Accounts the clock cut off last time go first, continuing from their cursor.
  const resume = Array.isArray(run.sc_resume) ? run.sc_resume : [];
  const resumed = resume.slice(0, size);
  const restResume = resume.slice(resumed.length);
  const newKeys = keys.slice(from, from + (size - resumed.length));
  const batch = resumed.map(x => x.key).concat(newKeys);
  if (!batch.length) {
    await supabase.from('social_crawl_runs').update({ status: 'collected', collected_at: new Date().toISOString() }).eq('id', id);
    return { done: true };
  }
  const { data: pageRows, error: pErr } = await supabase.from('social_pages').select('page_key, url')
    .eq('platform', platform).in('page_key', batch);
  if (pErr) throw new Error(pErr.message);
  // A row that today's rules reject (a /legal or /lite link saved before the
  // rules knew better) is skipped rather than read and charged for.
  const stillValid = p => {
    const k = platform === 'instagram' ? instagramKey(p.url) : facebookKey(p.url);
    return !!k;
  };
  const byKey = new Map((pageRows || []).filter(stillValid).map(p => [p.page_key, p]));
  const jobs = resumed.filter(x => byKey.has(x.key)).map(x => ({ page: byKey.get(x.key), cursor: x.cursor, have: x.have || 0, tries: x.tries || 1 }))
    .concat(newKeys.filter(k => byKey.has(k)).map(k => ({ page: byKey.get(k), cursor: null, have: 0, tries: 0 })));
  const pages = jobs.map(j => j.page);
  const cutoff = cutoffFrom(run.newer_than);
  const deadline = t0 + SC_FETCH_MS;
  const perPage = run.posts_per_page || 15;

  const results = await Promise.all(jobs.map(j =>
    scReadAccount(platform, j.page, Math.max(perPage - j.have, 1), cutoff, deadline, j.cursor)));
  let posts = [], credits = 0; const errors = [];
  const nextResume = restResume.slice();
  const missing = [];
  results.forEach((r, i) => {
    const j = jobs[i];
    posts = posts.concat(r.posts); credits += r.credits;
    if (r.cutOff && r.cursor && j.tries < SC_MAX_RESUMES) {
      // Not an error yet: it gets another call to finish.
      nextResume.push({ key: j.page.page_key, cursor: r.cursor, have: j.have + r.posts.length, tries: j.tries + 1 });
    } else if (r.error) {
      if (/\b404\b/.test(r.error)) missing.push(j.page.page_key);
      const msg = r.cutOff ? 'stopped at the time limit after ' + (j.have + r.posts.length) + ' posts' : r.error;
      errors.push(j.page.page_key + ': ' + msg);
    }
  });

  // What we already hold for these accounts in the same window, from any
  // earlier read. A post already on file under another key (Facebook ids can
  // differ between providers) is matched on its opening text, so it is counted
  // as overlap and not saved a second time.
  const { data: existing } = await supabase.from('social_posts')
    .select('post_key, page_key, text, run_id')
    .eq('platform', platform).in('page_key', batch).gte('posted_at', cutoff.toISOString()).limit(5000);
  const prior = (existing || []).filter(r => r.run_id !== id);
  // An account being continued was already compared on its first call.
  const newKeySet = new Set(newKeys);
  const priorNew = prior.filter(r => newKeySet.has(r.page_key));
  const priorKeys = new Set(prior.map(r => r.post_key));
  const sig = t => clean(t || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  const priorSig = new Set(prior.map(r => r.page_key + '|' + sig(r.text)).filter(x => !x.endsWith('|')));
  let overlap = 0;
  const fresh = posts.filter(p => {
    const same = priorKeys.has(p.post_key) || (sig(p.text) && priorSig.has(p.page_key + '|' + sig(p.text)));
    if (same) { overlap++; return priorKeys.has(p.post_key); }   // same key: harmless re-save
    return true;
  });

  const r = await processPosts(supabase, run, fresh);

  const now = new Date().toISOString();
  await supabase.from('social_pages').update({ last_requested_at: now, last_run_id: id })
    .eq('platform', platform).in('page_key', batch);
  // "Account doesn't exist": remember it, so the monthly read stops paying to
  // ask again. It is tried once more after 90 days in case the page comes back.
  if (missing.length) {
    await supabase.from('social_pages').update({ missing_since: now })
      .eq('platform', platform).in('page_key', missing);
  }

  const nextOffset = from + newKeys.length;
  const done = nextOffset >= keys.length && !nextResume.length;
  const upd = {
    collect_offset: nextOffset,
    sc_resume: nextResume,
    posts_saved: (run.posts_saved || 0) + r.saved,
    mentions_found: (run.mentions_found || 0) + r.found,
    credits_used: (run.credits_used || 0) + credits,
    compare_apify_posts: (run.compare_apify_posts || 0) + priorNew.length,
    compare_overlap: (run.compare_overlap || 0) + overlap,
    compare_sc_posts: (run.compare_sc_posts || 0) + posts.length
  };
  if (errors.length) upd.error = ((run.error ? run.error + ' | ' : '') + errors.join(' | ')).slice(0, 1500);
  if (done) { upd.status = 'collected'; upd.collected_at = now; upd.finished_at = now; }
  await supabase.from('social_crawl_runs').update(upd).eq('id', id);
  return {
    done, accounts_done: nextOffset, accounts_total: keys.length,
    posts_read: posts.length, posts_saved: r.saved, new_mentions: r.found,
    new_devices_published: r.published, credits, errors
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

// ⭐ STATE SCOPE (2026-10-07). The US is one country with very different
// states, so a run can be limited to one state (body.state = 'california').
// social_pages carries the state of the clinic it belongs to; Canada leaves it
// empty and nothing changes there.
function byState(q, body) {
  const st = body && body.state ? String(body.state).trim().toLowerCase() : '';
  return st ? q.eq('state', st) : q;
}
// "Still to read" = not requested in the last N days. 25 suits the monthly
// read; a shorter window allows an extra read before a meeting.
function skipDays(body) {
  const n = parseInt(body && body.skip_days, 10);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? n : 25;
}

// Rebuild social_pages from clinics. Cheap (a few thousand rows) and it means a
// Facebook link added in the portal is picked up by the next run with no step.
async function syncPages(supabase, country) {
  const clinics = await pageAll(() => supabase.from('clinics')
    .select('id, facebook_url, instagram_url, state')
    .eq('country', country).eq('approved', true).order('id', { ascending: true }));
  const pages = new Map();
  for (const c of clinics) {
    for (const [platform, raw, fn] of [['facebook', c.facebook_url, facebookKey], ['instagram', c.instagram_url, instagramKey]]) {
      if (!raw) continue;
      const k = fn(raw);
      if (!k) continue;
      const id = platform + '|' + k.key;
      const p = pages.get(id) || { platform, page_key: k.key, url: k.url, country,
                                   state: c.state ? String(c.state).toLowerCase() : null, clinic_ids: [] };
      if (!p.clinic_ids.includes(String(c.id))) p.clinic_ids.push(String(c.id));
      pages.set(id, p);
    }
  }
  const rows = [...pages.values()];
  for (let i = 0; i < rows.length; i += 300) {
    const { error } = await supabase.from('social_pages')
      .upsert(rows.slice(i, i + 300), { onConflict: 'platform,page_key' });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

async function stats(supabase, body) {
  const country = body.country || 'taiwan';
  await syncPages(supabase, country);
  const count = async (build) => { const { count, error } = await build(); if (error) throw new Error(error.message); return count || 0; };
  // Due = not requested in the last N days (25 by default), or never.
  const dueBefore = new Date(Date.now() - skipDays(body) * 864e5).toISOString();
  const missingBefore = new Date(Date.now() - 90 * 864e5).toISOString();
  const [fb, ig, fbNever, igNever, pending, approved, fbDue, igDue] = await Promise.all([
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook'), body)),
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram'), body)),
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook').is('last_requested_at', null), body)),
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram').is('last_requested_at', null), body)),
    count(() => supabase.from('social_device_mentions').select('id', { count: 'exact', head: true }).eq('country', country).eq('status', 'pending')),
    count(() => supabase.from('social_device_mentions').select('id', { count: 'exact', head: true }).eq('country', country).eq('status', 'approved')),
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook').or('last_requested_at.is.null,last_requested_at.lt.' + dueBefore).or('missing_since.is.null,missing_since.lt.' + missingBefore), body)),
    count(() => byState(supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram').or('last_requested_at.is.null,last_requested_at.lt.' + dueBefore).or('missing_since.is.null,missing_since.lt.' + missingBefore), body))
  ]);
  const { data: runs, error } = await supabase.from('social_crawl_runs')
    .select('*').eq('country', country).order('id', { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return {
    pages: { facebook: fb, instagram: ig, facebook_never: fbNever, instagram_never: igNever, facebook_due: fbDue, instagram_due: igDue },
    mentions: { pending, approved },
    runs: runs || [],
    apify_token_set: !!process.env.APIFY_TOKEN,
    scrapecreators_key_set: !!process.env.SCRAPECREATORS_API_KEY
  };
}

async function start(supabase, body) {
  const country = body.country || 'taiwan';
  const platform = body.platform === 'instagram' ? 'instagram' : 'facebook';
  const nPages = Math.min(Math.max(parseInt(body.pages, 10) || 100, 1), MAX_PAGES_PER_RUN);
  const perPage = Math.min(Math.max(parseInt(body.posts_per_page, 10) || 20, 1), MAX_POSTS_PER_PAGE);
  const newerThan = String(body.newer_than || '3 months').slice(0, 20);

  await syncPages(supabase, country);

  // Pages never read come first, then the ones read longest ago.
  const { data: pages, error } = await byState(supabase.from('social_pages')
    .select('page_key, url')
    .eq('country', country).eq('platform', platform), body)
    .order('last_requested_at', { ascending: true, nullsFirst: true })
    .order('page_key', { ascending: true })
    .limit(nPages);
  if (error) throw new Error(error.message);
  if (!pages || !pages.length) return { error: 'no ' + platform + ' pages found for ' + country };

  const input = platform === 'facebook'
    ? { startUrls: pages.map(p => ({ url: p.url })), resultsLimit: perPage, onlyPostsNewerThan: newerThan, captionText: false }
    : { username: pages.map(p => p.page_key), resultsLimit: perPage, onlyPostsNewerThan: newerThan, skipPinnedPosts: true, dataDetailLevel: 'basicData' };

  // maxItems caps what Apify can charge for, whatever the actor does per page.
  const maxItems = pages.length * perPage;

  const { data: run, error: rErr } = await supabase.from('social_crawl_runs').insert({
    platform, country, pages: pages.length, posts_per_page: perPage,
    newer_than: newerThan, matcher_version: MATCHER_VERSION, status: 'starting'
  }).select('id').single();
  if (rErr) throw new Error(rErr.message);

  let ap;
  try {
    ap = await apify('/acts/' + ACTORS[platform] + '/runs?maxItems=' + maxItems, {
      method: 'POST', body: JSON.stringify(input)
    });
  } catch (e) {
    await supabase.from('social_crawl_runs').update({ status: 'FAILED', error: e.message }).eq('id', run.id);
    throw e;
  }
  const d = ap.data || {};
  await supabase.from('social_crawl_runs').update({
    apify_run_id: d.id, dataset_id: d.defaultDatasetId, status: d.status || 'RUNNING'
  }).eq('id', run.id);

  const now = new Date().toISOString();
  const keys = pages.map(p => p.page_key);
  for (let i = 0; i < keys.length; i += 150) {
    await supabase.from('social_pages').update({ last_requested_at: now, last_run_id: run.id })
      .eq('platform', platform).in('page_key', keys.slice(i, i + 150));
  }
  return { run_id: run.id, apify_run_id: d.id, pages: pages.length, max_posts: maxItems, status: d.status };
}

async function poll(supabase, body) {
  const id = parseInt(body.run_id, 10);
  const { data: run, error } = await supabase.from('social_crawl_runs').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  if (!run.apify_run_id) return { run };
  if (run.status === 'collected') return { run };
  const ap = await apify('/actor-runs/' + run.apify_run_id, { method: 'GET' });
  const d = ap.data || {};
  const upd = { status: d.status, dataset_id: d.defaultDatasetId || run.dataset_id };
  if (d.finishedAt) upd.finished_at = d.finishedAt;
  await supabase.from('social_crawl_runs').update(upd).eq('id', id);
  return { run: Object.assign({}, run, upd), finished: ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(d.status) };
}

function readItem(platform, it) {
  if (platform === 'facebook') {
    const page = facebookKey(it.inputUrl || it.facebookUrl || '') || facebookKey(it.facebookUrl || '');
    const t = it.time || (it.timestamp ? new Date(it.timestamp * 1000).toISOString() : null);
    return {
      page_key: page ? page.key : null,
      post_key: String(it.postId || it.url || ''),
      post_url: clean(it.url) || null,
      posted_at: t,
      text: it.text || it.postText || ''
    };
  }
  const user = String(it.ownerUsername || '').toLowerCase()
    || ((instagramKey(it.inputUrl || '') || {}).key || null);
  return {
    page_key: user || null,
    post_key: String(it.shortCode || it.id || it.url || ''),
    post_url: it.url || null,
    posted_at: it.timestamp || null,
    text: it.caption || ''
  };
}

// ⭐ MARKETS (2026-10-09): a row with `markets` set only matches posts from
// clinics in those countries (Nuceiva for Canada, Jeuveau for the US), so a
// US post naming Jeuveau lands on the US row. No markets = every country.
async function loadMatcher(supabase, country) {
  const devices = await pageAll(() => supabase.from('device_reference')
    .select('id, model, model_aliases, name_zh, name_is_also_generic, exclusion_phrases, corroborate_aliases, active, markets')
    .order('id', { ascending: true }));
  const c = String(country || '').toLowerCase();
  return buildMatcher(devices.filter(d => !c || !Array.isArray(d.markets) || !d.markets.length || d.markets.includes(c)));
}

async function collect(supabase, body) {
  const id = parseInt(body.run_id, 10);
  const { data: run, error } = await supabase.from('social_crawl_runs').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  if (run.status === 'collected') return { done: true, run };
  if (!['SUCCEEDED', 'TIMED-OUT', 'ABORTED'].includes(run.status)) {
    return { done: false, waiting: true, status: run.status, note: 'run has not finished yet, press Check first' };
  }

  const items = await apify('/datasets/' + run.dataset_id + '/items?clean=true&format=json&offset='
    + (run.collect_offset || 0) + '&limit=' + COLLECT_PAGE, { method: 'GET' });
  const list = Array.isArray(items) ? items : [];

  const platform = run.platform;
  const posts = list.map(it => readItem(platform, it)).filter(p => p.post_key && p.page_key);
  const r = await processPosts(supabase, run, posts);

  const done = list.length < COLLECT_PAGE;
  const upd = {
    collect_offset: (run.collect_offset || 0) + list.length,
    posts_saved: (run.posts_saved || 0) + r.saved,
    mentions_found: (run.mentions_found || 0) + r.found
  };
  if (done) { upd.status = 'collected'; upd.collected_at = new Date().toISOString(); }
  await supabase.from('social_crawl_runs').update(upd).eq('id', id);
  return { done, read: list.length, posts_saved: r.saved, new_mentions: r.found, new_devices_published: r.published, total: upd };
}

// Saves posts, finds device mentions, publishes them. Shared by both providers,
// so a post read through Apify or ScrapeCreators is handled identically.
async function processPosts(supabase, run, posts) {
  const id = run.id;
  const platform = run.platform;

  // Which clinics own each page.
  const pageRows = posts.length
    ? await selectIn(supabase, 'social_pages', 'page_key, clinic_ids', 'page_key',
        posts.map(p => p.page_key))
    : [];
  const clinicsByPage = new Map(pageRows.map(r => [r.page_key, r.clinic_ids || []]));

  // Pages with posts from an earlier run have been read before; the rest are on
  // their first read, and whatever they mention is a baseline.
  const seenBefore = new Set();
  const keys = [...new Set(posts.map(p => p.page_key))];
  for (let i = 0; i < keys.length; i += 150) {
    const { data: prev } = await supabase.from('social_posts').select('page_key')
      .eq('platform', platform).lt('run_id', id).in('page_key', keys.slice(i, i + 150)).limit(5000);
    (prev || []).forEach(r => seenBefore.add(r.page_key));
  }

  // Save posts (text kept, so a later matcher can re-read without paying again).
  // ⛔ ONE ROW PER POST PER BATCH. A collaboration post comes back once for each
  // account tagged on it, with the same post key, and Postgres refuses an upsert
  // that touches the same row twice ("ON CONFLICT DO UPDATE command cannot affect
  // row a second time"). The first copy wins; the post is stored once either way.
  let saved = [];
  const seenPost = new Set();
  const postRows = posts.filter(p => {
    if (seenPost.has(p.post_key)) return false;
    seenPost.add(p.post_key);
    return true;
  }).map(p => ({
    platform, post_key: p.post_key, page_key: p.page_key, post_url: p.post_url,
    posted_at: p.posted_at, text: clean(clean(p.text || '').slice(0, 8000)), run_id: id
  }));
  for (let i = 0; i < postRows.length; i += 200) {
    const { data, error: pErr } = await supabase.from('social_posts')
      .upsert(postRows.slice(i, i + 200), { onConflict: 'platform,post_key' })
      .select('id, post_key, page_key, post_url, posted_at, text');
    if (pErr) throw new Error(pErr.message);
    saved = saved.concat(data || []);
  }

  const matcher = await loadMatcher(supabase, run.country);
  const mentions = [];
  const lastPost = new Map();
  for (const p of saved) {
    const cur = lastPost.get(p.page_key);
    if (p.posted_at && (!cur || p.posted_at > cur)) lastPost.set(p.page_key, p.posted_at);
    if (!p.text) continue;
    const m = matchPost(p.text, matcher);
    if (!m.hits.length) continue;
    const ev = classifyPost(p.text, m.hits, m.comparison, matcher);
    const nowIso = new Date().toISOString();
    for (const clinicId of (clinicsByPage.get(p.page_key) || [])) {
      for (const h of m.hits) {
        const e = ev.get(h.device_id);
        mentions.push({
          post_id: p.id, clinic_id: clinicId, device_id: h.device_id, platform, country: run.country,
          post_url: p.post_url, posted_at: p.posted_at, matched_text: clean(h.surface),
          snippet: snippetFor(p.text, h.surface), flag: m.comparison ? 'comparison' : null,
          evidence_type: e.evidence_type, confidence: e.confidence, classified_by: 'rules', classified_at: nowIso,
          // Weak evidence (comparison) is kept for listening but never publishes.
          status: WEAK_EVIDENCE.has(e.evidence_type) ? 'weak' : 'pending'
        });
      }
    }
  }
  let found = 0;
  const newIds = [];
  const quietIds = new Set();
  const firstReadPost = new Set(saved.filter(p => !seenBefore.has(p.page_key)).map(p => p.id));
  for (let i = 0; i < mentions.length; i += 200) {
    const { data, error: mErr } = await supabase.from('social_device_mentions')
      .upsert(mentions.slice(i, i + 200), { onConflict: 'post_id,clinic_id,device_id', ignoreDuplicates: true })
      .select('id, post_id');
    if (mErr) throw new Error(mErr.message);
    found += (data || []).length;
    (data || []).forEach(r => { newIds.push(r.id); if (firstReadPost.has(r.post_id)) quietIds.add(r.id); });
  }

  // Published straight away (Andy, 2026-09-25): a clinic only posts about a
  // device it has committed to, so a post on its own account is the evidence.
  // decide() adds only clinic-device pairs not already on file, dated to the post.
  let published = 0;
  for (let i = 0; i < newIds.length; i += 500) {
    const res = await decide(supabase, { ids: newIds.slice(i, i + 500) }, true, { quietIds });
    published += res.new_devices || 0;
  }

  for (const [key, at] of lastPost) {
    await supabase.from('social_pages').update({ last_post_at: at })
      .eq('platform', platform).eq('page_key', key).or('last_post_at.is.null,last_post_at.lt."' + at + '"');
  }
  return { saved: saved.length, found, published };
}

async function listMentions(supabase, body) {
  const status = body.status || 'pending';
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 500);
  // Scoped to the country chosen in the tab, so one country's list never
  // shows another's mentions.
  let q = supabase.from('social_device_mentions')
    .select('id, clinic_id, device_id, platform, post_url, posted_at, matched_text, snippet, flag, status, evidence_type, classified_by')
    .eq('country', body.country || 'taiwan')
    .order('device_id', { ascending: true }).order('posted_at', { ascending: false }).limit(limit);
  if (status !== 'all') q = q.eq('status', status);
  if (body.device_id) q = q.eq('device_id', parseInt(body.device_id, 10));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data || [];
  const clinics = rows.length ? await selectIn(supabase, 'clinics', 'id, name', 'id', rows.map(r => r.clinic_id)) : [];
  const devs = rows.length ? await selectIn(supabase, 'device_reference', 'id, model, name_zh', 'id', rows.map(r => r.device_id)) : [];
  const cName = new Map(clinics.map(c => [String(c.id), c.name]));
  const dName = new Map(devs.map(d => [d.id, d]));
  return {
    mentions: rows.map(r => Object.assign({}, r, {
      clinic_name: cName.get(String(r.clinic_id)) || r.clinic_id,
      model: (dName.get(r.device_id) || {}).model || String(r.device_id),
      name_zh: (dName.get(r.device_id) || {}).name_zh || null
    }))
  };
}

// Approve: one clinic_devices row per NEW clinic-device pair, first_seen = the
// earliest post date among the approved mentions. A pair that is already
// published (from a manufacturer list, the website crawl or by hand) is left
// exactly as it is — its first_seen and source are not touched.
async function decide(supabase, body, approve, opts) {
  const quiet = (opts && opts.quietIds) || new Set();
  const ids = (body.ids || []).map(x => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) return { error: 'no ids' };
  const rows = (await selectIn(supabase, 'social_device_mentions',
    'id, clinic_id, device_id, post_url, posted_at, matched_text, platform, status', 'id', ids))
    .filter(r => r.status === 'pending');
  if (!rows.length) return { approved: 0, rejected: 0, note: 'nothing pending in that selection' };
  const now = new Date().toISOString();

  if (!approve) {
    for (let i = 0; i < rows.length; i += 150) {
      await supabase.from('social_device_mentions').update({ status: 'rejected', reviewed_at: now })
        .in('id', rows.slice(i, i + 150).map(r => r.id));
    }
    return { rejected: rows.length };
  }

  const existing = await selectIn(supabase, 'clinic_devices', 'clinic_id, device_id', 'clinic_id', rows.map(r => r.clinic_id));
  const already = new Set(existing.map(r => r.clinic_id + '|' + r.device_id));

  const pairs = new Map();
  for (const r of rows) {
    const k = r.clinic_id + '|' + r.device_id;
    if (already.has(k)) continue;
    const day = (r.posted_at || now).slice(0, 10);
    const p = pairs.get(k);
    if (!p) pairs.set(k, { r, first: day, last: day });
    else {
      if (day < p.first) { p.first = day; p.r = r; }
      if (day > p.last) p.last = day;
    }
  }

  const errors = [];
  const inserts = [...pairs.values()].map(p => ({
    clinic_id: p.r.clinic_id,
    device_id: p.r.device_id,
    source: 'social',
    status: 'listed',
    source_url: p.r.post_url,
    matched_text: (p.r.platform === 'instagram' ? 'Instagram' : 'Facebook') + ' post: ' + p.r.matched_text,
    first_seen: p.first,
    last_seen: p.last,
    updated_at: now
  }));
  let published = 0;
  for (let i = 0; i < inserts.length; i += 200) {
    const { error } = await supabase.from('clinic_devices')
      .upsert(inserts.slice(i, i + 200), { onConflict: 'clinic_id,device_id', ignoreDuplicates: true });
    if (error) errors.push(error.message); else published += inserts.slice(i, i + 200).length;
  }
  // A failed save must stop here: the mentions stay pending, so nothing is
  // marked approved that is not actually on the clinic's profile.
  if (errors.length) throw new Error('could not publish to clinic_devices: ' + errors[0]);

  // The change feed, same as the website crawl: one 'added' event per new pair.
  // A device found on an account's FIRST read is a baseline, not an adoption:
  // the clinic may have run it for years. Only later reads write 'added' events,
  // so the Signal tab and change feed never show a backlog as new business.
  const loudPairs = new Set(rows.filter(r => !quiet.has(r.id)).map(r => r.clinic_id + '|' + r.device_id));
  const events = inserts.filter(x => loudPairs.has(x.clinic_id + '|' + x.device_id)).map(x => ({
    clinic_id: x.clinic_id, device_id: x.device_id, event: 'added',
    observed_at: x.first_seen, source_url: x.source_url
  }));
  for (let i = 0; i < events.length; i += 200) {
    const { error } = await supabase.from('clinic_device_events').insert(events.slice(i, i + 200));
    if (error) { errors.push('events: ' + error.message); break; }
  }

  for (let i = 0; i < rows.length; i += 150) {
    await supabase.from('social_device_mentions').update({ status: 'approved', reviewed_at: now })
      .in('id', rows.slice(i, i + 150).map(r => r.id));
  }
  const knownPairs = new Set(rows.filter(r => already.has(r.clinic_id + '|' + r.device_id)).map(r => r.clinic_id + '|' + r.device_id));
  return { approved: rows.length, new_devices: published, already_known: knownPairs.size, errors };
}

// Approve every pending mention not flagged as a comparison, optionally for one
// device. 500 per call; the tab repeats it until nothing is left.
async function approveAll(supabase, body) {
  let q = supabase.from('social_device_mentions').select('id')
    .eq('status', 'pending').is('flag', null).eq('country', body.country || 'taiwan')
    .order('id', { ascending: true }).limit(500);
  if (body.device_id) q = q.eq('device_id', parseInt(body.device_id, 10));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  if (!data || !data.length) return { approved: 0, done: true };
  const res = await decide(supabase, { ids: data.map(r => r.id) }, true);
  return Object.assign(res, { done: data.length < 500 });
}

// ---------------------------------------------------------------------------
// Evidence backfill (rules). Classifies mentions saved before step 38, from the
// post text already stored, so nothing is paid for again. 800 per call; the tab
// repeats it until done. A mention the current matcher no longer finds (an
// exclusion added since, e.g. "pic à glace") becomes 'unmatched'. Mentions
// still pending that turn out weak are moved to 'weak' so they never publish;
// already-approved ones are left alone for the review list.
// ---------------------------------------------------------------------------

async function classifyRules(supabase, body) {
  const country = body.country || 'taiwan';
  const { data: rows, error } = await supabase.from('social_device_mentions')
    .select('id, post_id, device_id, matched_text, status')
    .eq('country', country).is('evidence_type', null)
    .order('id', { ascending: true }).limit(800);
  if (error) throw new Error(error.message);
  if (!rows || !rows.length) return { done: true, classified: 0 };

  const posts = await selectIn(supabase, 'social_posts', 'id, text', 'id', rows.map(r => r.post_id));
  const textOf = new Map(posts.map(p => [p.id, p.text || '']));
  const matcher = await loadMatcher(supabase, country);
  const perPost = new Map();
  const groups = new Map();        // type -> ids
  const toWeak = [];
  for (const r of rows) {
    const text = textOf.get(r.post_id) || '';
    let ev = perPost.get(r.post_id);
    if (!ev) {
      const m = matchPost(text, matcher);
      ev = { hits: new Map(m.hits.map(h => [h.device_id, h])), cls: classifyPost(text, m.hits, m.comparison, matcher) };
      perPost.set(r.post_id, ev);
    }
    const type = ev.cls.has(r.device_id) ? ev.cls.get(r.device_id).evidence_type : 'unmatched';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(r.id);
    if ((WEAK_EVIDENCE.has(type) || type === 'unmatched') && r.status === 'pending') toWeak.push(r.id);
  }
  const now = new Date().toISOString();
  const byType = {};
  for (const [type, ids] of groups) {
    byType[type] = ids.length;
    for (let i = 0; i < ids.length; i += 200) {
      const { error: uErr } = await supabase.from('social_device_mentions')
        .update({ evidence_type: type, confidence: EVIDENCE_CONFIDENCE[type] || 0, classified_by: 'rules', classified_at: now })
        .in('id', ids.slice(i, i + 200));
      if (uErr) throw new Error(uErr.message);
    }
  }
  for (let i = 0; i < toWeak.length; i += 200) {
    await supabase.from('social_device_mentions').update({ status: 'weak' })
      .in('id', toWeak.slice(i, i + 200)).eq('status', 'pending');
  }
  return { done: rows.length < 800, classified: rows.length, by_type: byType };
}

// ---------------------------------------------------------------------------
// Evidence refinement (AI). Mentions the rules left as plain 'mention' (no cue
// found) are read by a language model, 15 per call. It only refines the type
// and confidence used for analytics; it never publishes or unpublishes.
// Env: ANTHROPIC_API_KEY or OPENAI_API_KEY (either one). SOCIAL_AI_MODEL optional.
// ---------------------------------------------------------------------------

const AI_TYPES = ['announcement', 'promotion', 'before_after', 'education', 'mention', 'comparison'];

async function askModel(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.SOCIAL_AI_MODEL || 'claude-haiku-4-5', max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }] })
    });
    const b = await res.json();
    if (!res.ok) throw new Error('AI ' + res.status + ': ' + JSON.stringify(b).slice(0, 200));
    return (b.content || []).map(c => c.text || '').join('');
  }
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.SOCIAL_AI_MODEL || 'gpt-4.1-mini',
        response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] })
    });
    const b = await res.json();
    if (!res.ok) throw new Error('AI ' + res.status + ': ' + JSON.stringify(b).slice(0, 200));
    return ((b.choices || [])[0] || {}).message ? b.choices[0].message.content : '';
  }
  return null;
}

async function classifyAI(supabase, body) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return { error: 'No AI key in Netlify (ANTHROPIC_API_KEY or OPENAI_API_KEY). The rules classification is complete without it.' };
  }
  const country = body.country || 'taiwan';
  const { data: rows, error } = await supabase.from('social_device_mentions')
    .select('id, post_id, device_id')
    .eq('country', country).eq('evidence_type', 'mention').eq('classified_by', 'rules')
    .order('id', { ascending: true }).limit(15);
  if (error) throw new Error(error.message);
  if (!rows || !rows.length) return { done: true, classified: 0 };

  const posts = await selectIn(supabase, 'social_posts', 'id, text', 'id', rows.map(r => r.post_id));
  const devs = await selectIn(supabase, 'device_reference', 'id, model', 'id', rows.map(r => r.device_id));
  const textOf = new Map(posts.map(p => [p.id, String(p.text || '').replace(/\s+/g, ' ').slice(0, 1200)]));
  const nameOf = new Map(devs.map(d => [d.id, d.model]));
  const items = rows.map(r => ({ id: r.id, product: nameOf.get(r.device_id), caption: textOf.get(r.post_id) }));

  const prompt =
    'Each item is a social media post from an aesthetic clinic\'s own account, and a product the post names.\n' +
    'For each item, say how the post uses that product:\n' +
    '- announcement: the clinic says it has newly added, launched or started offering the product\n' +
    '- promotion: the clinic is selling or booking the treatment (offer, price, book now, availability)\n' +
    '- before_after: the post shows or describes a result from the treatment at the clinic\n' +
    '- education: the post explains the product or treatment in general terms\n' +
    '- comparison: the post compares products or discusses one the clinic may not offer\n' +
    '- mention: none of the above\n' +
    'Give a confidence from 0 to 1 that the type is right.\n' +
    'Reply with JSON only: {"items":[{"id":123,"type":"promotion","confidence":0.8}]}\n\n' +
    JSON.stringify(items);

  let parsed = [];
  try {
    const out = await askModel(prompt);
    const j = JSON.parse(String(out).slice(String(out).indexOf('{'), String(out).lastIndexOf('}') + 1));
    parsed = Array.isArray(j.items) ? j.items : [];
  } catch (e) {
    return { error: e.message };
  }
  const got = new Map(parsed.filter(x => x && AI_TYPES.includes(x.type)).map(x => [parseInt(x.id, 10), x]));
  const now = new Date().toISOString();
  const byType = {};
  for (const r of rows) {
    const x = got.get(r.id);
    const upd = { classified_by: 'ai', classified_at: now };
    if (x) {
      upd.evidence_type = x.type;
      upd.confidence = Math.max(0, Math.min(1, Number(x.confidence) || 0.5)).toFixed(2);
      byType[x.type] = (byType[x.type] || 0) + 1;
    }
    await supabase.from('social_device_mentions').update(upd).eq('id', r.id);
  }
  return { done: rows.length < 15, classified: rows.length, by_type: byType };
}

// ---------------------------------------------------------------------------

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  const ok = secret && (secret === process.env.ADMIN_SECRET || secret === process.env.VISUALIZE_ADMIN_SECRET);
  if (!ok) return json(401, { error: 'unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  try {
    switch (body.mode) {
      case 'stats':          return json(200, await stats(supabase, body));
      case 'start':          return json(200, await start(supabase, body));
      case 'poll':           return json(200, await poll(supabase, body));
      case 'collect':        return json(200, await collect(supabase, body));
      case 'sc-start':       return json(200, await scStart(supabase, body));
      case 'sc-step':        return json(200, await scStep(supabase, body));
      case 'list-mentions':  return json(200, await listMentions(supabase, body));
      case 'approve':        return json(200, await decide(supabase, body, true));
      case 'reject':         return json(200, await decide(supabase, body, false));
      case 'approve-all':    return json(200, await approveAll(supabase, body));
      case 'classify':       return json(200, await classifyRules(supabase, body));
      case 'classify-ai':    return json(200, await classifyAI(supabase, body));
      default:               return json(400, { error: 'unknown mode' });
    }
  } catch (e) {
    console.error('social-posts', body.mode, e);
    return json(500, { error: e.message || String(e) });
  }
};

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-admin-secret',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
}

function json(statusCode, obj) {
  return { statusCode, headers: Object.assign({ 'content-type': 'application/json' }, cors()), body: JSON.stringify(obj) };
}

// Exported for the local check only; Netlify ignores these.
module.exports._test = { buildMatcher, matchPost, facebookKey, instagramKey, snippetFor, readItem, classifyPost, stripHashtagRuns,
  scInstagramPost, scFacebookPost, cutoffFrom, scReadAccount };

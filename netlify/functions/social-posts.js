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
//      APIFY_TOKEN  (NEW — from apify.com -> Settings -> API & Integrations)
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');

// Bump whenever matching changes, so two runs are only compared like for like.
const MATCHER_VERSION = '2026-09-25-social-v2';   // v2: evidence types

const ACTORS = {
  facebook: 'apify~facebook-posts-scraper',
  instagram: 'apify~instagram-post-scraper'
};
const APIFY = 'https://api.apify.com/v2';

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
// Every mention gets a type and a confidence. Two types are WEAK and never put
// a device on a clinic's profile by themselves: hashtag_only (the product only
// appears inside a run of hashtags, "#botox #dysport #xeomin") and comparison.
// Everything else is the clinic talking about a product on its own account.
// Rules decide the obvious cases; posts with no cue at all stay "mention" and
// can be refined by the AI pass (classify-ai), which only changes the type used
// for analytics, never what is published.
// ---------------------------------------------------------------------------

const EVIDENCE_CONFIDENCE = {
  announcement: 0.9, promotion: 0.8, before_after: 0.75, education: 0.6,
  mention: 0.55, comparison: 0.3, hashtag_only: 0.2
};
const WEAK_EVIDENCE = new Set(['hashtag_only', 'comparison']);

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
  if (['sharer', 'sharer.php', 'share', 'groups', 'events', 'watch', 'photo', 'photo.php', 'story.php', 'login', 'dialog'].includes(segs[0].toLowerCase())) return null;
  const keep = (segs[0].toLowerCase() === 'pages' || segs[0].toLowerCase() === 'p') ? segs.slice(0, 3) : segs.slice(0, 1);
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
// Modes
// ---------------------------------------------------------------------------

// Rebuild social_pages from clinics. Cheap (a few thousand rows) and it means a
// Facebook link added in the portal is picked up by the next run with no step.
async function syncPages(supabase, country) {
  const clinics = await pageAll(() => supabase.from('clinics')
    .select('id, facebook_url, instagram_url')
    .eq('country', country).eq('approved', true).order('id', { ascending: true }));
  const pages = new Map();
  for (const c of clinics) {
    for (const [platform, raw, fn] of [['facebook', c.facebook_url, facebookKey], ['instagram', c.instagram_url, instagramKey]]) {
      if (!raw) continue;
      const k = fn(raw);
      if (!k) continue;
      const id = platform + '|' + k.key;
      const p = pages.get(id) || { platform, page_key: k.key, url: k.url, country, clinic_ids: [] };
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
  // Due = not requested in the last 25 days (or never), i.e. still to read this month.
  const dueBefore = new Date(Date.now() - 25 * 864e5).toISOString();
  const [fb, ig, fbNever, igNever, pending, approved, fbDue, igDue] = await Promise.all([
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook')),
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram')),
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook').is('last_requested_at', null)),
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram').is('last_requested_at', null)),
    count(() => supabase.from('social_device_mentions').select('id', { count: 'exact', head: true }).eq('country', country).eq('status', 'pending')),
    count(() => supabase.from('social_device_mentions').select('id', { count: 'exact', head: true }).eq('country', country).eq('status', 'approved')),
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'facebook').or('last_requested_at.is.null,last_requested_at.lt.' + dueBefore)),
    count(() => supabase.from('social_pages').select('page_key', { count: 'exact', head: true }).eq('country', country).eq('platform', 'instagram').or('last_requested_at.is.null,last_requested_at.lt.' + dueBefore))
  ]);
  const { data: runs, error } = await supabase.from('social_crawl_runs')
    .select('*').eq('country', country).order('id', { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  return {
    pages: { facebook: fb, instagram: ig, facebook_never: fbNever, instagram_never: igNever, facebook_due: fbDue, instagram_due: igDue },
    mentions: { pending, approved },
    runs: runs || [],
    apify_token_set: !!process.env.APIFY_TOKEN
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
  const { data: pages, error } = await supabase.from('social_pages')
    .select('page_key, url')
    .eq('country', country).eq('platform', platform)
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

async function loadMatcher(supabase) {
  const devices = await pageAll(() => supabase.from('device_reference')
    .select('id, model, model_aliases, name_zh, name_is_also_generic, exclusion_phrases, corroborate_aliases, active')
    .order('id', { ascending: true }));
  return buildMatcher(devices);
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
  let saved = [];
  const postRows = posts.map(p => ({
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

  const matcher = await loadMatcher(supabase);
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
          // Weak evidence (hashtag-only, comparison) is kept for listening but never publishes.
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

  const done = list.length < COLLECT_PAGE;
  const upd = {
    collect_offset: (run.collect_offset || 0) + list.length,
    posts_saved: (run.posts_saved || 0) + saved.length,
    mentions_found: (run.mentions_found || 0) + found
  };
  if (done) { upd.status = 'collected'; upd.collected_at = new Date().toISOString(); }
  await supabase.from('social_crawl_runs').update(upd).eq('id', id);
  return { done, read: list.length, posts_saved: saved.length, new_mentions: found, new_devices_published: published, total: upd };
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
  const matcher = await loadMatcher(supabase);
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
module.exports._test = { buildMatcher, matchPost, facebookKey, instagramKey, snippetFor, readItem, classifyPost, stripHashtagRuns };

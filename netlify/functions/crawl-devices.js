// ===========================================================================
// crawl-devices.js  -  SkinDay Canada M39 device crawler (Netlify Function)
//
// Deploy to /netlify/functions/crawl-devices.js. Triggered in a loop by the
// Device crawl tab in skinday-admin.html, gated on x-admin-secret.
//
// Reads three pages per host: homepage, best technology-ish link, best
// service-ish link. Lands rows in clinic_device_candidates (RLS on, no
// policies) so nothing reaches a patient before review. Unmatched capitalised
// tokens near a device word go to device_unknown_tokens as the census.
//
// The reference list is READ FROM device_reference at runtime, so a wrong row is
// a SQL update and never a redeploy.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_SECRET  (all already set)
// ===========================================================================

const { createClient } = require('@supabase/supabase-js');

const BATCH_DEFAULT = 3;
const BATCH_MAX = 5;
const FETCH_TIMEOUT_MS = 12000;
const MAX_DEVICES_PER_HOST = 25;   // a directory-style page can name dozens
const MAX_UNKNOWNS_PER_HOST = 15;
// ⚠️⚠️ THE USER AGENT AND HEADERS ARE LOAD-BEARING, not boilerplate.
//
// signaturemedispa.com — a clinic with 25 machines and a dedicated page per
// device — returned HTTP 403 on BOTH https and the http retry. It was never a
// matcher problem: the site's WAF refused the request before serving a byte.
// The old string was `Mozilla/5.0 (compatible; SkinDayBot/1.0; ...)`, and the
// bare "(compatible; …Bot)" shape is what most managed WAF rulesets reject.
//
// This UA STILL IDENTIFIES US and still points at a bot page, which matters:
// we are reading public service pages for a directory, and a clinic that wants
// to see who is asking should be able to. What changed is that it now looks
// like a real browser build, and the request carries the headers a real browser
// sends. In practice the missing accept-language and sec-fetch-* headers reject
// more crawlers than the UA string does.
//
// ⓘ If a host still 403s after this, that is a DELIBERATE block and the honest
// options are to enter it by hand or ask the clinic through the portal. Do not
// escalate to a fully disguised UA without deciding that on purpose.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 SkinDayBot/1.0 (+https://skinday.ca/bot)';

// Sent on every page fetch. A request with only user-agent and accept looks
// automated no matter what the UA says.
const BROWSER_HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'cache-control': 'max-age=0',
};


// Single words from the reference list that are also ordinary English or
// ordinary marketing words. These need corroboration exactly like the
// name_is_also_generic rows do. Enumerated rather than guessed, because a wrong
// category is the one error that wastes a sales call.
const RISKY_SINGLE_WORD = new Set([
  // ⚠️ TRIMMED 2026-07-27. The first version of this list suppressed real
  // installs and cost the data its credibility: Potenza came back as 14 clinics
  // in Canada because the rule demanded "Cynosure Potenza" in the page text and
  // clinics simply write "Potenza". Same for Moxi, Vectus, Cynergy, Nordlys and
  // Physiq.
  //
  // THE TEST FOR THIS LIST is not "could this word appear elsewhere" but
  // "would a reader of a clinic page be unsure this refers to a machine".
  // Icon, Halo, Elite, Forma, Genius, Evolve, Prime, Secret, Legacy, Bliss,
  // Versa, Accent, Harmony, Hybrid, Profound, Clarity, Opus, Mosaic, Spectra
  // and Tetra are ordinary English or ordinary marketing words and stay.
  // Coined product names come OUT: they are unambiguous on their own.
  'elite', 'icon', 'halo', 'forma', 'genius', 'evolve', 'opus',
  'clarity', 'prime', 'secret', 'legacy', 'bliss', 'versa', 'accent',
  'harmony', 'hybrid', 'tetra', 'spectra', 'mosaic', 'profound',
  'ultra'
]);

const DEVICE_CONTEXT = [
  'laser', 'lasers', 'device', 'devices', 'technology', 'technologies',
  'platform', 'system', 'machine', 'handpiece', 'applicator', 'cartridge',
  'radiofrequency', 'radio frequency', 'ultrasound', 'microneedling',
  'resurfacing', 'tightening', 'appareil', 'technologie'
];

// A mention inside one of these frames is ABOUT a device rather than a claim to
// own one. The device analogue of the price reject list, and the SEO farm and
// competitor-comparison problem is what it exists for.
const NEGATION_FRAMES = [
  'unlike', 'compared to', 'compared with', 'comparison', ' vs ', ' vs.',
  'versus', 'instead of', 'rather than', 'we do not use', 'we don t use',
  'do not offer', 'don t offer', 'no longer offer', 'alternative to',
  'alternatives to', 'competitor', 'competitors', 'other clinics',
  'some clinics', 'many clinics', 'most clinics', 'elsewhere',
  'difference between', 'what is the difference', 'similar to',
  'often confused', 'not enhance', 'would duplicate', 'contrairement',
  'au lieu de', 'which is right for you', 'which is better'
];

const BLOG_PATH = /\/(blog|blogs|news|article|articles|post|posts|magazine|journal|resources|glossary|guide|guides|category|tag|author|press)(\/|$|-|\?)/i;
const TECH_PATH = /(technolog|our-?devices?|our-?lasers?|equipment|machines?|appareils)/i;
const SERVICE_PATH = /(service|treatment|procedure|traitement|soins|price|pricing|menu)/i;

function stripMarks(s) {
  return String(s).replace(/[\u00ae\u2122\u2120\u00a9]/g, ' ');
}

// ⚠️⚠️ THE PLUS SIGN CARRIES MEANING AND MUST SURVIVE NORMALISATION.
// Stripping it made "excel V+" and "excel V" the same string, so Cutera's
// current generation could not be told from the previous one, and the same was
// true of xeo+/xeo, Elite+/Elite and Smartskin+/Smartskin. A generation pair
// that normalises identically is a guaranteed miscount.
function norm(s) {
  return stripMarks(s)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A device may be written with or without a space before a trailing number
// ("Morpheus8" / "Morpheus 8"), so both forms are indexed.
function tokenVariants(name) {
  const n = norm(name);
  const out = new Set([n]);
  out.add(n.replace(/([a-z]) (\d)/g, '$1$2'));
  out.add(n.replace(/([a-z])(\d)/g, '$1 $2'));

  // ⚠️⚠️ NO CONJUNCTION VARIANT. An earlier version of this function stripped a
  // MIDDLE plus, so "Clear + Brilliant" also matched the bare phrase
  // "clear brilliant". That looked harmless and was not: "clear, brilliant skin"
  // is stock marketing copy, punctuation is gone by normalisation time, and the
  // device ended up credited to 131 clinics on prose alone.
  //
  // The conjunction is part of the brand and clinics print it: Clear + Brilliant,
  // Clear & Brilliant, Clear and Brilliant. Those go in `model_aliases` as
  // explicit strings, which is data and reviewable, rather than a generated
  // variant nobody can see. A TRAILING plus still survives as the generation
  // marker ("excel v plus", "elite plus"), which is the only job it has here.

  return [...out].filter(Boolean);
}

// ⚠️⚠️ MULTI-WORD TOKENS ARE SELF-DISAMBIGUATING AND NEVER NEED CORROBORATION,
// even on a device flagged name_is_also_generic.
//
// This was the bug that made Signature return no Halo and no diVa despite a
// dedicated /treatment/halo-laser/ page. The generic flag lives on the DEVICE,
// so it was forcing "Halo Laser" and "diVa Vaginal Rejuvenation" to also carry
// the manufacturer, which no clinic writes. That defeated the entire point of
// adding disambiguating aliases.
//
// Bare "halo" is an ordinary English word and stays guarded. "halo laser" is
// not ambiguous to any reader, so it stands on its own.
function needsCorroboration(token, generic) {
  if (token.split(' ').length > 1) return false;
  if (generic) return true;
  return RISKY_SINGLE_WORD.has(token);
}

// Character spans of every exclusion phrase occurrence in an already-normalised
// haystack. Used to drop the OCCURRENCE, not the device and not the page.
function exclusionSpans(hay, exclTokens) {
  const spans = [];
  for (const ex of exclTokens || []) {
    const needle = ' ' + ex + ' ';
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      spans.push([at + 1, at + needle.length - 1]);
      from = at + 1;
    }
  }
  return spans;
}

// True when the matched span sits INSIDE an exclusion phrase, i.e. the words we
// matched are part of a product name rather than a machine mention.
function insideExclusion(spans, a, b) {
  return spans.some(([s, e]) => a >= s && b <= e);
}

// ⚠️ PROXIMITY EXCLUSIONS exist because adjacency is too literal. A shop grid
// prints the brand in a heading, a logo alt or a separate column, so the page
// reads "... Vivier ... Derma-V 60ml ..." and no adjacency phrase fires. An
// exclusion phrase that does NOT contain the device token is treated as a
// nearby-word test instead.
//
// The window is deliberately tight. A clinic can genuinely own a DermaV AND
// retail Vivier on the same site, so a page-wide brand test would trade this
// false positive for a false negative — the mistake that started this.
const EXCL_WINDOW = 120;

function nearExclusion(hay, a, b, tokens, win) {
  if (!tokens || !tokens.length) return false;
  const from = Math.max(0, a - win);
  const to = Math.min(hay.length, b + win);
  const around = hay.slice(from, to);
  return tokens.some(t => around.indexOf(' ' + t + ' ') !== -1);
}

const MFR_NOISE = new Set([
  'medical', 'aesthetics', 'aesthetic', 'systems', 'system', 'health',
  'lasers', 'laser', 'technologies', 'group', 'inc', 'ltd', 'corp'
]);

// Longest token first, because Morpheus8 is a prefix of Morpheus8 Body and
// PicoSure of PicoSure Pro.
function buildMatcher(devices) {
  const entries = [];
  for (const d of devices) {
    if (d.active === false) continue;
    const mfrTokens = [...new Set(
      [d.manufacturer, ...(d.manufacturer_aliases || [])]
        .filter(Boolean)
        .join(' ')
        .split(/[\s/]+/)
        .map(w => norm(w))
        .filter(w => w.length > 3 && !MFR_NOISE.has(w))
    )];
    // ⚠️⚠️ EXCLUSION PHRASES are the answer to the DermaV class: a device name
    // that collides with a SKINCARE PRODUCT rather than another device. The
    // Vivier "Derma-V" cream and a clinic writing the laser as "Derma V"
    // normalise to the identical token, so no guard on the NAME can separate
    // them. What separates them is the words either side, which is what this
    // carries.
    //
    // Scoped to the matched SPAN, never the page: Vivier is a common Canadian
    // skincare line, so a genuine DermaV owner may well retail it on the same
    // site. Suppressing the page would trade one false positive for a false
    // negative.
    const exclTokens = [...new Set(
      (d.exclusion_phrases || []).map(p => norm(p)).filter(Boolean)
    )];
    // ⚠️ PER-ALIAS CORROBORATION. `name_is_also_generic` is all-or-nothing on a
    // DEVICE, which is too blunt: "Resolve" needs a Solta or Fraxel nearby to
    // mean anything, while "Fraxel" itself does not. Listing the risky ALIAS
    // here settles the ambiguous ones without deleting them — the alias keeps
    // working on real pages and stops firing on ordinary prose. Multi-word
    // aliases are exempt from corroboration elsewhere, so this is the only way
    // to constrain phrases like "Broad Band Light" or "Nano Fractional".
    const corrobAliases = new Set(
      (d.corroborate_aliases || []).map(a => norm(a)).filter(Boolean)
    );
    for (const name of [d.model, ...(d.model_aliases || [])]) {
      for (const tok of tokenVariants(name)) {
        if (tok.length < 3) continue;
        // A phrase CONTAINING this token is an adjacency test ("derma v cream");
        // one that does not is a proximity test ("vivier").
        const exclAdj = exclTokens.filter(p => p.indexOf(tok) !== -1);
        const exclNear = exclTokens.filter(p => p.indexOf(tok) === -1);
        const entry = {
          token: tok,
          device_id: d.id,
          model: d.model,
          category: d.category,
          surface: name,
          mfrTokens: mfrTokens,
          exclTokens: exclAdj,
          exclNear: exclNear,
          corroborate: needsCorroboration(tok, !!d.name_is_also_generic)
                       || corrobAliases.has(norm(name))
        };
        entries.push(entry);
        // ⭐ PLURALS. Clinics write "HydraFacials" and "PhotoFacials" and the
        // singular never fired — 23 California hosts and 15 Canadian ones lost
        // to a missing letter. Registering the plural as its own token is
        // cheaper and safer than stemming inside norm(), which would change
        // matching for every device at once.
        if (!/s$/.test(tok) && tok.length >= 4) {
          entries.push(Object.assign({}, entry, { token: tok + 's' }));
        }
      }
    }
  }
  entries.sort((a, b) => b.token.length - a.token.length);
  return entries;
}

function hasAny(hay, needles) {
  for (const n of needles) if (n && hay.indexOf(n) !== -1) return true;
  return false;
}

function classifyPage(url) {
  const u = String(url || '');
  if (BLOG_PATH.test(u)) return 'blog';
  if (TECH_PATH.test(u)) return 'tech';
  if (SERVICE_PATH.test(u)) return 'service';
  try {
    const p = new URL(u).pathname;
    if (p === '/' || p === '') return 'home';
  } catch (e) {}
  return 'other';
}

// Every same-host URL path on the page, normalised. A clinic with a dedicated
// /morpheus8/ page owns a Morpheus8. Blog paths are excluded, or a post titled
// sofwave-vs-morpheus8 would read as two dedicated pages.
// Asset and build paths are NOT pages. Every WordPress site serves icon.svg,
// apple-touch-icon.png and /wp-content/themes/.../images/, which is how a real
// run produced "Icon own page" on two unrelated clinic sites.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|woff2?|ttf|eot|pdf|mp4|webm|zip)$/i;
const ASSET_DIR = /\/(wp-content|wp-includes|wp-json|assets?|static|dist|build|themes?|plugins?|uploads?|images?|img|icons?|fonts?|media|cdn-cgi|_next|_nuxt)(\/|$)/i;

// ⚠️⚠️⚠️ RETAIL PATHS ARE AMBIGUOUS, NOT DISQUALIFYING. My first version of this
// rejected every shop url outright and immediately broke the one clinic we KNOW
// owns a DermaV: Precision Ptbo sells its treatments through Shopify, so its
// best evidence on the whole site is
//   /collections/laser-skin-treatments/products/dermav-laser
// A med spa's "shop" is often its BOOKING CATALOGUE, not a skincare store.
//
// So the discriminator is the SLUG, not the path prefix:
//   products/dermav-laser        → a bookable treatment, KEEP
//   product-page/derma-v-60ml    → a Vivier cream SKU, DROP
// A retail url counts only when it names equipment AND does not look like a
// physical product. PRODUCT_SLUG wins, because "…-treatment-3ml" is a bottle.
const RETAIL_PATH = /\/(shop|shops|store|stores|product|products|product-page|collection|collections|catalog|cart|checkout|boutique|merch)(\/|$|-|\?)/i;
const EQUIP_SLUG = /(laser|treatment|session|consult|package|device|platform|microneedling|resurfacing|photofacial|\bipl\b|\brf\b)/i;
const PRODUCT_SLUG = /(cream|serum|moisturi[sz]er|cleanser|toner|lotion|sunscreen|spf|balm|mask|peel-pad|supplement|gift-card|\d+\s*-?\s*(ml|mg|oz|g)\b)/i;

// ⚠️⚠️ A URL THAT NAMES MORE THAN ONE DEVICE IS A COMPARISON, NOT A PRODUCT PAGE.
// Found on Andy's own clinic: skin-trek.com/nerd/ultherapy-vs-thermage-vs-sofwave
// is an educational comparison article, and it credited Skin Trek with a SOFWAVE
// they do not own. Two failures stacked:
//   1. `/nerd/` is not in BLOG_PATH, because it is that site's own word for its
//      blog. Guessing every clinic's name for its content section is a losing
//      game: /nerd/, /learn/, /insights/, /academy/, /the-edit/.
//   2. The slug contains THREE device names, so the own-page rule fired for all
//      three, which is the STRONGEST evidence tier and is auto-approved in bulk.
//
// ⭐ THE GENERAL FIX does not need to know the folder name. A page whose URL
// carries an explicit comparison word, or names two or more different devices,
// is about devices rather than owned by the clinic. This is the SEO problem Andy
// named: clinics write comparison content precisely to rank for competitors'
// brand terms, so this pattern will only become more common.
const COMPARE_PATH = /(^|[^a-z])(vs|versus|compare[sd]?|comparison|difference|differences|which-is-better|or)([^a-z]|$)/i;

function isComparisonPath(pathname, entries) {
  if (COMPARE_PATH.test(pathname)) return true;
  // ⚠️ WHOLE TOKENS ONLY. A first version also allowed a bare substring match,
  // and short tokens matched inside longer words, so EVERY path looked like a
  // comparison and every own_page collapsed to blog_only. Boundaries matter here
  // for exactly the reason they matter in the prose matcher.
  // ⚠️⚠️ COUNT DISTINCT DEVICES, NOT DISTINCT TOKENS. A first version counted
  // tokens and broke drmikeroskies.com/laser-treatments/sciton-halo, because
  // "sciton halo" and "halo" are TWO TOKENS FOR ONE MACHINE and read as a
  // comparison of two devices. One device named two ways is still one device.
  const flat = ' ' + norm(decodeURIComponent(pathname)) + ' ';
  const models = new Set();
  for (const e of entries) {
    if (e.token && e.token.length >= 3 && flat.indexOf(' ' + e.token + ' ') !== -1) {
      models.add(e.model);
      if (models.size >= 2) return true;
    }
  }
  return false;
}

// ⚠️⚠️ TAKES `entries` NOW, because of a gap in my own comparison fix. The page
// level test only saw the url being FETCHED. Skin Trek's
// /nerd/ultherapy-vs-thermage-vs-sofwave arrived from the SITEMAP as one of
// hundreds of harvested paths, so the page url was the homepage, the comparison
// test never saw it, and `source_url` recorded the homepage too, which is why the
// SQL cleanup could not find the row either.
//
// ⭐ BLOG_PATH was already filtered HERE, per path. The comparison test belongs in
// exactly the same place and did not get there. Every filter that protects the
// own-page tier has to run per harvested path, not once per fetched page.
function ownPagePaths(rawText, pageUrl, entries) {
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (e) {}
  const paths = [];
  const add = u => {
    try {
      const p = new URL(u);
      if (host && p.hostname.replace(/^www\./, '') !== host) return;
      if (BLOG_PATH.test(p.pathname)) return;
      if (RETAIL_PATH.test(p.pathname)
          && (PRODUCT_SLUG.test(p.pathname) || !EQUIP_SLUG.test(p.pathname))) return;
      if (entries && isComparisonPath(p.pathname, entries)) return;
      if (ASSET_EXT.test(p.pathname) || ASSET_DIR.test(p.pathname)) return;
      if (p.pathname.split('/').filter(Boolean).length > 4) return;   // deep = not a service page
      paths.push(norm(decodeURIComponent(p.pathname)));
    } catch (e) {}
  };
  if (pageUrl) add(pageUrl);
  const re = /https?:\/\/[^\s"'<>)\]]+/g;
  let m, n = 0;
  while ((m = re.exec(String(rawText))) !== null && n++ < 800) add(m[0]);
  // ⚠️⚠️ DEDUPE. The pool is the union of the page's hrefs AND the sitemap, so
  // the same url arrives twice and each copy is a separate character span. That
  // defeated the overlap suppression entirely: BBL and BBL Hero BOTH matched
  // "BroadBand Light" on signaturemedispa.com, one per copy of the url, and
  // every owner of a newer generation was double counted alongside the older.
  return [...new Set(paths)];
}

// URLs go before prose matching. Booking widgets (vagaro, Zenoti) embed long
// base64 blobs, and in M38 a hostname alone seeded a false window.
function stripUrls(s) {
  return String(s)
    .replace(/https?:\/\/[^\s"'<>)\]]+/g, ' ')
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, ' ')
    .replace(/\b[\w-]+\.(com|ca|net|org|io|co)\b/gi, ' ');
}

const WINDOW_BACK = 160;
const WINDOW_FWD = 160;

// Negation is checked over a MUCH tighter window than corroboration. Punctuation
// is gone by normalisation time, so there are no sentence boundaries to split
// on, and a wide window let one "Unlike traditional CO2 lasers" sentence poison
// every device named in the paragraph before it.
const NEG_BACK = 80;
const NEG_FWD = 50;

// Snap window edges out to whitespace so a truncated word cannot silently
// disarm a reject rule. That bug cost real money in M38.
function windowAround(text, at, len) {
  let s = Math.max(0, at - WINDOW_BACK);
  let e = Math.min(text.length, at + len + WINDOW_FWD);
  let g = 0;
  while (s > 0 && text[s] !== ' ' && g++ < 25) s--;
  g = 0;
  while (e < text.length && text[e] !== ' ' && g++ < 25) e++;
  return text.slice(s, e);
}

const RANK = { own_page: 4, exact: 3, generic_review: 2, blog_only: 1 };

function matchDevices(rawText, pageUrl, matcher, opts) {
  opts = opts || {};
  let pageKind = classifyPage(pageUrl);
  // Normalised host, used to suppress a device whose name IS the business name.
  let hostNorm = '';
  try {
    const h = opts.host || new URL(pageUrl).hostname;
    hostNorm = ' ' + norm(String(h).replace(/^www\./i, '').replace(/[.\-_]/g, ' ')) + ' ';
  } catch (e) {}

  // ⚠️⚠️ COMPARISON PAGES ARE TREATED EXACTLY LIKE BLOG PAGES, which means
  // blog_only at best and never auto-approved. Denying only the own-page tier
  // would not have saved Skin Trek: Sofwave is a distinctive name, so it would
  // have fallen through to `exact` and the bulk-approve rule auto-approves
  // `exact` on distinctive names. The whole PAGE has to be demoted, not the one
  // evidence tier.
  let comparisonPage = false;
  try {
    const pn = new URL(pageUrl).pathname;
    comparisonPage = isComparisonPath(pn, Array.isArray(matcher) ? matcher : []);
  } catch (e) {}
  if (comparisonPage) pageKind = 'blog';

  const isBlog = pageKind === 'blog';
  const pathBlob = ' ' + ownPagePaths(rawText, pageUrl, Array.isArray(matcher) ? matcher : []).join(' ') + ' ';
  const text = ' ' + norm(stripUrls(rawText)) + ' ';

  const found = new Map();

  // ⚠️⚠️ OVERLAP SUPPRESSION. The matcher walks entries LONGEST TOKEN FIRST and
  // records the character span of every accepted match, so a shorter name that
  // sits inside a longer one already matched at the same place cannot match
  // again.
  //
  // Without this, one mention counts twice: "Stellar M22" contains " m22 ", and
  // "PicoSure Pro" contains " picosure ", so every Stellar M22 install was also
  // an M22 install and every PicoSure Pro was also a PicoSure. Same for
  // "Elite iQ", which contains the normalised " elite " of Elite+.
  //
  // Spans, not a global "this model already matched" flag: a clinic that
  // genuinely owns BOTH a PicoSure and a PicoSure Pro names them in two
  // different places, and both should still count.
  const claimedProse = [];
  const claimedPath = [];
  const overlaps = (spans, a, b) => spans.some(([s, e]) => a < e && b > s);

  for (const entry of matcher) {
    const jammed = entry.token.replace(/ /g, '');
    // ⚠️ CLINIC-NAME COLLISION. "Derma V+ Cosmetic Clinic" on dermav.com matched
    // DermaV at `exact`. The device name IS the business name, so no phrase list
    // can help — this is the mirror of the own-page filter.
    if (hostNorm && (hostNorm.indexOf(' ' + entry.token + ' ') !== -1
                  || hostNorm.indexOf(' ' + jammed + ' ') !== -1)) continue;
    const hasExcl = !!(entry.exclTokens && entry.exclTokens.length);
    const hasNear = !!(entry.exclNear && entry.exclNear.length);
    const exclProse = hasExcl ? exclusionSpans(text, entry.exclTokens) : [];
    const exclPath = hasExcl ? exclusionSpans(pathBlob, entry.exclTokens) : [];

    let pathHit = false;
    if (!isBlog) {
      for (const needle of [' ' + entry.token + ' ', ' ' + jammed + ' ']) {
        let pFrom = 0;
        for (;;) {
          const pAt = pathBlob.indexOf(needle, pFrom);
          if (pAt === -1) break;
          pFrom = pAt + 1;
          if (hasExcl && insideExclusion(exclPath, pAt + 1, pAt + needle.length - 1)) continue;
          if (overlaps(claimedPath, pAt + 1, pAt + needle.length - 1)) continue;
          claimedPath.push([pAt + 1, pAt + needle.length - 1]);
          pathHit = true;
          break;
        }
        if (pathHit) break;
      }
    }

    let proseHit = false;
    let corroborated = false;
    let snippet = '';
    let from = 0;
    for (;;) {
      const at = text.indexOf(' ' + entry.token + ' ', from);
      if (at === -1) break;
      from = at + 1;
      // Part of a product name, not a machine mention. Checked BEFORE the span
      // is claimed so a later, genuine mention on the same page still matches.
      if (hasExcl && insideExclusion(exclProse, at + 1, at + 1 + entry.token.length)) continue;
      if (hasNear && nearExclusion(text, at + 1, at + 1 + entry.token.length, entry.exclNear, EXCL_WINDOW)) continue;
      // Already consumed by a longer model name at this exact position.
      if (overlaps(claimedProse, at + 1, at + 1 + entry.token.length)) continue;
      const negWin = text.slice(
        Math.max(0, at + 1 - NEG_BACK),
        Math.min(text.length, at + 1 + entry.token.length + NEG_FWD)
      );
      if (hasAny(negWin, NEGATION_FRAMES)) continue;
      const win = windowAround(text, at + 1, entry.token.length);
      claimedProse.push([at + 1, at + 1 + entry.token.length]);
      proseHit = true;
      if (!snippet) snippet = win.trim().slice(0, 220);
      if (hasAny(win, entry.mfrTokens)) {
        corroborated = true;
        snippet = win.trim().slice(0, 220);
        break;
      }
    }

    if (!pathHit && !proseHit) continue;

    // A name that is also an ordinary word needs the MANUFACTURER beside it in
    // the prose. Full stop. A path hit is not enough: /icons/, /our-icon-story/
    // and a favicon all put "icon" in a URL. This costs the rare clinic that has
    // an /icon-laser/ page and never names Cynosure, which is the right trade,
    // because the alternative published a Cynosure Icon on two clinics that
    // almost certainly do not own one.
    if (entry.corroborate && !corroborated) continue;

    let confidence;
    if (isBlog) confidence = 'blog_only';
    else if (pathHit) confidence = 'own_page';
    else confidence = 'exact';

    const prev = found.get(entry.device_id);
    if (!prev || RANK[confidence] > RANK[prev.confidence]) {
      found.set(entry.device_id, {
        device_id: entry.device_id,
        model: entry.model,
        category: entry.category,
        matched_text: entry.surface,
        confidence: confidence,
        page_kind: pageKind,
        snippet: snippet || ('own page path: ' + entry.token)
      });
    }
  }

  return {
    matches: [...found.values()],
    unknowns: opts.collectUnknowns === false
      ? []
      : censusUnknowns(rawText, matcher, new Set(matcher.flatMap(e => e.mfrTokens))),
    page_kind: pageKind
  };
}

// Capitalised or CamelCase tokens near a device word that matched NOTHING. This
// is how the real Canadian long tail gets found, rather than by more desk
// research. Reviewed in admin, never published.
const CENSUS_CONTEXT = DEVICE_CONTEXT.concat([
  'treatment', 'treatments', 'offer', 'offers', 'offering', 'reader',
  'handpieces', 'wavelength', 'ablative', 'fractional', 'traitement'
]);

// ⭐⭐⭐ RANKED, NOT FIRST-COME.
// The old loop stopped at the first 8 surviving tokens IN DOCUMENT ORDER, and a
// chain's mega-menu sits at the top of the DOM. laseraway.com therefore returned
// Underarms, Brazilian, Bikini and Bundles while Astanza Duality, XTherma and
// Kirby-Paradigm — all named further down the same page — never made the cut.
// Now every candidate is collected, SCORED, and the best kept.
const STRONG_CONTEXT = [
  'device', 'devices', 'system', 'systems', 'platform', 'platforms',
  'technology', 'technologies', 'handpiece', 'handpieces', 'machine',
  'wavelength', 'q switched', 'q-switched', 'fda cleared', 'nd yag',
  'we use', 'powered by', 'utilizing', 'utilising', 'equipped'
];

function censusUnknowns(rawText, matcher, mfrKnown) {
  const src = stripUrls(stripMarks(rawText));
  const flat = ' ' + norm(src) + ' ';
  const known = matcher.map(e => e.token);

  // ⭐ A TRADEMARK SYMBOL IS THE STRONGEST FREE SIGNAL ON THE PAGE. Read it from
  // the RAW text, because stripMarks() removes ® and ™ before anything else runs.
  // "Astanza® Duality", "XTherma®", "Potenza™" — a clinic marks the product names
  // it does not own, and marks nothing in its navigation.
  const tmTokens = new Set();
  {
    const tre = /([A-Za-z][A-Za-z0-9+\-]{2,24}(?:\s+[A-Z][A-Za-z0-9+\-]{1,24})?)\s*[\u00ae\u2122]/g;
    let t;
    while ((t = tre.exec(String(rawText))) !== null) {
      const nn = norm(t[1]);
      if (!nn) continue;
      tmTokens.add(nn);
      const parts = nn.split(' ');
      if (parts.length > 1) { tmTokens.add(parts[0]); tmTokens.add(parts[parts.length - 1]); }
    }
  }
  const lowerElsewhere = new Set();
  {
    const re2 = /\b([a-z][a-z]{3,})\b/g;
    let mm;
    while ((mm = re2.exec(src)) !== null) lowerElsewhere.add(mm[1]);
  }
  const re = /\b([A-Z][a-zA-Z]{2,}(?:[A-Z][a-zA-Z0-9]*)*(?:\s?\d{1,3})?)\b/g;
  const out = [];
  const seen = new Set();
  let m;
  let scanned = 0;
  while ((m = re.exec(src)) !== null && scanned < 4000) {
    scanned++;
    const raw = m[1].trim();
    const n = norm(raw);
    if (!n || seen.has(n) || STOPWORDS.has(n)) continue;
    if (mfrKnown && mfrKnown.has(n)) continue;
    if (n.length < 4 || n.length > 24) continue;
    if (/^img ?\d+$/.test(n)) continue;
    if (!/[aeiou]/.test(n)) continue;              // base64 debris
    if (/^\d/.test(n)) continue;
    const squashed = n.replace(/ /g, '');
    let overlaps = false;
    for (const k of known) {
      if (k === n || k.replace(/ /g, '') === squashed) { overlaps = true; break; }
    }
    if (overlaps) continue;
    // An ordinary English word appears in lowercase somewhere on the page too.
    // A product name is capitalised every single time. Self-tuning, and it
    // clears most of the census noise without a dictionary.
    if (lowerElsewhere.has(n)) continue;
    // Hashtag and slug runs (#ValentinesGlow, SelfLoveSeason, LaserHairRemoval)
    // came back by the dozen from a real Instagram feed embed.
    if ((raw.match(/[A-Z]/g) || []).length >= 3) continue;
    if (m.index > 0 && src[m.index - 1] === '#') continue;   // #LipFiller, #ValentinesGlow
    if (/\d/.test(n)) continue;                    // "Niagara 0", "Rated 5", "For 3"
    const at = flat.indexOf(' ' + n + ' ');
    if (at === -1) continue;
    // A TIGHT window. Over 160 chars, any page containing the word "laser"
    // qualified every capitalised word on it.
    const ctx = flat.slice(Math.max(0, at + 1 - 70), at + 1 + n.length + 70);
    if (!hasAny(ctx, CENSUS_CONTEXT)) continue;
    seen.add(n);

    // ── SCORE ──────────────────────────────────────────────────────────────
    // Nav labels survive every filter above (they are capitalised, sit near the
    // word "laser", and never appear lowercase). What separates a product name
    // from a menu item is the company it keeps.
    let score = 0;
    if (tmTokens.has(n)) score += 6;                       // marked ® or ™
    if (hasAny(ctx, STRONG_CONTEXT)) score += 4;           // "system", "we use", "wavelength"
    const tight = flat.slice(Math.max(0, at + 1 - 28), at + 1 + n.length + 28);
    if (hasAny(tight, STRONG_CONTEXT)) score += 2;         // and close by
    // Repeated in prose is a product; a nav label usually appears once or twice
    // in the text stream even though it is visually everywhere.
    let occurrences = 0, from = 0, hit;
    while ((hit = flat.indexOf(' ' + n + ' ', from)) !== -1 && occurrences < 12) { occurrences++; from = hit + 1; }
    if (occurrences >= 3) score += 2;
    // Two unknown capitalised words side by side is the shape of a maker plus a
    // model — "Astanza Duality", "Kirby Paradigm".
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/[A-Z][a-zA-Z]{2,}[\s\u00ae\u2122]*$/.test(before)) score += 2;

    out.push({ token: raw, token_norm: n, score: score });
  }

  // ⭐ Best first, then cut. This is the whole fix: the cut used to happen in
  // document order, so a mega-menu ate the budget before the content was read.
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 12).map(u => ({ token: u.token, token_norm: u.token_norm, score: u.score }));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'our', 'your', 'you', 'all', 'new', 'more', 'this',
  'that', 'with', 'from', 'what', 'when', 'where', 'which', 'how', 'why',
  'book', 'booking', 'appointment', 'appointments', 'contact', 'about', 'home',
  'blog', 'news', 'menu', 'search', 'login', 'sign', 'cart', 'shop', 'read',
  'learn', 'click', 'call', 'email', 'phone', 'address', 'hours', 'save',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa', 'edmonton',
  'winnipeg', 'mississauga', 'brampton', 'hamilton', 'quebec', 'ontario',
  'alberta', 'manitoba', 'saskatchewan', 'canada', 'canadian', 'british',
  'columbia', 'scotia', 'brunswick', 'yukon', 'nunavut',
  'clinic', 'clinics', 'medical', 'medspa', 'aesthetic', 'aesthetics',
  'cosmetic', 'cosmetics', 'dermatology', 'doctor', 'nurse', 'clinique',
  'centre', 'center', 'institute', 'skin', 'skincare', 'beauty', 'radiant',
  'laser', 'lasers', 'treatment', 'treatments', 'technology', 'technologies',
  'device', 'devices', 'system', 'systems', 'machine', 'procedure', 'procedures',
  'session', 'sessions', 'package', 'packages', 'consultation', 'consult',
  'botox', 'dysport', 'xeomin', 'nuceiva', 'letybo', 'jeuveau', 'juvederm',
  'restylane', 'sculptra', 'radiesse', 'teosyal', 'belkyra', 'kybella',
  'filler', 'fillers', 'injectable', 'injectables', 'dermal',
  'facial', 'facials', 'peel', 'peels', 'microneedling', 'dermaplaning',
  'price', 'pricing', 'prices', 'financing', 'promotions',
  'before', 'after', 'results', 'gallery', 'reviews', 'testimonials',
  'privacy', 'policy', 'terms', 'conditions', 'sitemap', 'copyright',
  'facebook', 'instagram', 'tiktok', 'youtube', 'twitter', 'linkedin',
  'google', 'wordpress', 'squarespace', 'shopify', 'elementor', 'javascript',
  'approved', 'certified', 'authorized', 'health',
  'face', 'body', 'neck', 'chest', 'legs', 'arms', 'hair', 'removal',
  'acne', 'scars', 'wrinkles', 'pigmentation', 'melasma', 'rosacea',
  'collagen', 'elastin', 'dermis', 'epidermis', 'downtime', 'ablative',
  'fractional', 'wavelength', 'wavelengths', 'energy', 'pulse', 'pulses',
  'women', 'patients', 'patient', 'clients', 'client', 'team', 'staff',
  'experience', 'advanced', 'innovative', 'revolutionary', 'state',
  'complimentary', 'schedule', 'online', 'available', 'offering', 'winner',
  'magazine', 'awards', 'award', 'choice', 'years',
  'welcome', 'services', 'glowing', 'glow', 'shine', 'starts', 'start',
  'today', 'rejuvenate', 'rejuvenation', 'micro', 'moments', 'full', 'name',
  'number', 'dream', 'submit', 'skip', 'content', 'open', 'close', 'however',
  'view', 'website', 'follow', 'load', 'download', 'expires', 'current',
  'amazing', 'expert', 'consider', 'combo', 'brows', 'lash', 'lashes',
  'eyeliner', 'liner', 'technique', 'enhancement', 'marks', 'semi',
  'freckles', 'tattoo', 'microshading', 'exosomes', 'vampire', 'faqs',
  'only', 'touch', 'head', 'falls', 'rated', 'reviews', 'book', 'now',
  'learn', 'more', 'here', 'terms', 'refund', 'cancellation', 'gift',
  'cards', 'card', 'careers', 'blogs', 'newsletter', 'subscribe',
  'chemical', 'resurfacing', 'enhanced', 'comfort', 'simply', 'intensive',
  'lines', 'tone', 'smart', 'priming', 'compact', 'power', 'delivering',
  'celsius', 'utilizing', 'united', 'states', 'designed', 'many', 'along',
  'understanding', 'unlike', 'experience', 'introduced', 'combines',
  'combining', 'targets', 'target', 'stimulating', 'delivers', 'offering',
  'proud', 'best', 'most', 'also', 'each', 'both', 'these', 'those', 'while',
  'every', 'first', 'second', 'third', 'other', 'others', 'over', 'under',
  // ── NAVIGATION AND BODY AREAS. Added 2026-08-02 after laseraway.com's
  // mega-menu filled the entire census with menu labels. A chain site lists
  // every treatable body part at the top of the DOM.
  'underarms', 'underarm', 'bikini', 'brazilian', 'abdomen', 'buttocks',
  'sideburns', 'stomach', 'thighs', 'thigh', 'shoulders', 'shoulder',
  'knuckles', 'nipples', 'cheeks', 'cheek', 'chin', 'lips', 'forehead',
  'jawline', 'masseter', 'nostrils', 'toes', 'feet', 'hands', 'calves',
  'bundles', 'bundle', 'areas', 'area', 'popular', 'explore', 'location',
  'locations', 'points', 'premiere', 'instant', 'wellness', 'savings',
  'rewards', 'loyalty', 'promo', 'promos', 'offers', 'offer', 'addons',
  'addon', 'concern', 'concerns', 'financing', 'finance', 'checkout',
  'account', 'profile', 'settings', 'support', 'help', 'careers', 'press',
  'partners', 'franchise', 'membership', 'memberships', 'referral',
  'crows', 'bunny', 'smokers', 'marionette', 'nasolabial', 'hyperhidrosis',
  'contouring', 'tightening', 'brightening', 'hydrate', 'aging', 'regenerative',
  'radiofrequency', 'photofacial', 'photofacials',
  'story', 'class', 'best', 'discover', 'cutting', 'edge', 'latest',
  'ensuring', 'effective', 'providing', 'committed', 'features', 'options',
  // ── SCHEMA.ORG VOCABULARY. Belt and braces behind the JSON-LD fix above:
  // these are markup type names, never a device, and they dominated both runs.
  'webpage', 'offercatalog', 'localbusiness', 'listitem', 'breadcrumblist',
  'imageobject', 'instock', 'aggregaterating', 'aggregateoffer', 'searchaction',
  'readaction', 'reserveaction', 'propertyvalue', 'collectionpage',
  'contactpoint', 'postaladdress', 'entrypoint', 'medicalbusiness',
  'medicalclinic', 'medicalorganization', 'medicalprocedure', 'medicaltherapy',
  'plasticsurgery', 'beautysalon', 'servicename', 'androidplatform',
  'geocoordinates', 'openinghoursspecification', 'organization', 'creativework',
  // financing and payment widgets, seen on dozens of US clinic sites
  'carecredit', 'patientfi', 'cherry', 'affirm', 'klarna', 'afterpay', 'mychart'
]);


// ===========================================================================
// Page fetching. Same shape as the M38 price crawler: hard timeout, cheap text
// extraction, meta description read separately because it is the highest-signal
// text on the page for the least bytes.
// ===========================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A 429 is not a refusal, it is us being impolite. A chain with six branches is
// six queue rows on ONE host, so we hit the same server six times back to back
// and it throttles us. Laser Clinics Canada (6 Ontario clinics) and SpaMedica
// were both lost this way. Wait and try once more before giving up.
async function getPage(url, allowRetry) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: BROWSER_HEADERS
    });
    // Two escalating waits, not one: laserclinics.ca refused four attempts at
    // 2.5s. Only 11 hosts nationally hit this, so the worst case costs about a
    // minute across the whole crawl.
    if (res.status === 429 && (allowRetry === undefined || allowRetry > 0)) {
      const left = allowRetry === undefined ? 2 : allowRetry;
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const waitMs = Math.min(Number.isFinite(ra) ? ra * 1000 : (left === 2 ? 6000 : 15000), 20000);
      clearTimeout(timer);
      await sleep(waitMs);
      return getPage(url, left - 1);
    }
    if (!res.ok) return { ok: false, status: res.status, url };
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return { ok: false, status: 415, url };
    const html = await res.text();
    return { ok: true, status: res.status, url: res.url || url, html };
  } catch (e) {
    return { ok: false, status: 0, url, error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function metaDescription(html) {
  const m = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']{0,400})["'][^>]+name=["']description["']/i.exec(html)
    || /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{0,400})["']/i.exec(html);
  return m ? m[1] : '';
}

// JSON-LD is stripped out of the prose by toText along with every other script,
// which throws away the one block a JavaScript-rendered site DOES serve
// statically. Read it separately: a MedicalBusiness or Service block routinely
// carries the treatment menu, and treatment names are device names.
function jsonLdText(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{0,20000}?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 6) {
    // Keep the VALUES, drop the JSON punctuation and the keys' quoting. Parsing
    // properly is not worth it: the matcher only wants a bag of words.
    //
    // ⭐⭐ BUT DROP THE SCHEMA.ORG VOCABULARY FIRST. `"@type":"WebPage"` is
    // markup, not content, and leaving it in made the unknown-token census
    // useless: WebPage, OfferCatalog, LocalBusiness, ListItem, BreadcrumbList,
    // ImageObject, InStock and AggregateRating came top of the list on both the
    // Canadian and Californian runs. Diagnosed 2026-07-31, applied 2026-08-02.
    const body = m[1]
      .replace(/"@[a-zA-Z]+"\s*:\s*"[^"]*"/g, ' ')      // "@type":"WebPage"
      .replace(/"@[a-zA-Z]+"\s*:\s*\[[^\]]*\]/g, ' ')  // "@type":["A","B"]
      .replace(/https?:\/\/schema\.org[^"\s]*/gi, ' ');
    out.push(body.replace(/[{}\[\]"',:]/g, ' ').replace(/\s+/g, ' '));
  }
  return out.join(' ').slice(0, 8000);
}

// ---------------------------------------------------------------------------
// SITEMAPS. A JavaScript-only site still serves a static sitemap, and the
// own-page rule wants URLs rather than rendered text, so this recovers the
// STRONGEST confidence tier from a site whose body copy we cannot read at all.
// Squarespace, Wix and Square Online all serve one.
//
// Paths only ever feed pathHit. They cannot manufacture a prose false positive,
// and since the Icon bug a path hit no longer clears the generic flag on its
// own, so widening the path pool is a low-risk way to raise recall.
// ---------------------------------------------------------------------------
// ⚠️⚠️ 4s, not 8s, and only a few probes. The first version tried TWO schemes
// times FOUR paths sequentially at 8s each: up to 64 SECONDS on a host with no
// sitemap, against a Netlify function limit of 26. The function was killed, the
// browser got an HTML error page instead of JSON, and the crawl loop stopped
// dead. That is why the run needed restarting every 10-15 minutes.
const SITEMAP_TIMEOUT_MS = 4000;
const MAX_SITEMAP_URLS = 1200;
const MAX_CHILD_SITEMAPS = 5;

async function getXml(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SITEMAP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: Object.assign({}, BROWSER_HEADERS, {
        accept: 'application/xml,text/xml,text/plain,*/*;q=0.8',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
      })
    });
    if (!res.ok) return null;
    const body = await res.text();
    // A site with no sitemap often serves its 404 PAGE with a 200, so require
    // this to actually look like XML before believing it.
    if (!/<(urlset|sitemapindex)\b/i.test(body)) return null;
    return body;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function locs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]{1,400})\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < MAX_SITEMAP_URLS) {
    out.push(m[1].replace(/&amp;/gi, '&'));
  }
  return out;
}

async function sitemapUrls(host) {
  // Bounded on purpose: at most three probes, https only. A host that answers on
  // http but not https will have already told us so via the home fetch, and one
  // clinic's sitemap is never worth risking the whole batch.
  let xml = null, found = null;
  for (const path of ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml']) {
    xml = await getXml('https://' + host + path);
    if (xml) { found = 'https://' + host + path; break; }
  }
  // robots.txt is the last resort and costs one more fetch, so it only runs when
  // the three direct probes all missed.
  if (!xml) {
    try {
      const r = await getPage('https://' + host + '/robots.txt');
      const hit = r.ok && /Sitemap:\s*(\S+)/i.exec(r.html);
      if (hit) { xml = await getXml(hit[1]); found = hit[1]; }
    } catch (e) {}
  }
  if (!xml) return { urls: [], source: null };

  let urls = locs(xml);
  // A sitemap INDEX points at child sitemaps rather than pages. Follow a few.
  if (/<sitemapindex\b/i.test(xml)) {
    const children = urls.slice(0, MAX_CHILD_SITEMAPS);
    urls = [];
    for (const child of children) {
      const childXml = await getXml(child);
      if (childXml) urls = urls.concat(locs(childXml));
      if (urls.length >= MAX_SITEMAP_URLS) break;
    }
  }
  return { urls: urls.slice(0, MAX_SITEMAP_URLS), source: found };
}

// Scripts and styles come out first, or a JSON-LD blob or a CSS class named
// .icon-halo becomes a device claim.
function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

// hrefs are kept SEPARATELY from prose. The own-page rule needs the URLs, and
// the prose matcher needs them gone: booking widgets embed long base64 blobs.
function hrefs(html, baseUrl) {
  const out = [];
  const re = /href=["']([^"'#]{1,300})["']/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 600) {
    try { out.push(new URL(m[1], baseUrl).toString()); } catch (e) {}
  }
  return out;
}

// A page whose text is tiny but whose HTML is large is a JS-rendered site. Same
// needs_render verdict the price crawler uses, and the ~217 known JavaScript-only
// clinics land here.
function looksJsOnly(html, text) {
  return html.length > 4000 && text.length < 500;
}

const TECH_HINTS = [
  'technology', 'technologies', 'our-technology', 'our-devices', 'devices',
  'equipment', 'machines', 'lasers', 'our-lasers', 'laser-technology',
  'technologie', 'appareils', 'plateau-technique'
];
const SERVICE_HINTS = [
  'services', 'treatments', 'all-treatments', 'our-treatments', 'procedures',
  'what-we-do', 'menu', 'price', 'pricing', 'traitements', 'soins', 'tarifs'
];

// ⚠️⚠️ ASSET FILES ARE NOT PAGES, and this cost dozens of clinics.
// `menu` is a SERVICE_HINT because clinics publish a "treatment menu". But it
// also matches WordPress theme assets:
//     /elementor-pro/assets/css/widget-nav-menu.min.css
//     /cdn/shop/t/5/assets/component-menu-drawer.css
//     /themify/js/modules/themify-sidemenu.js
//     411sante.com/css/menu.css
// The scorer picked those as the services page, the server answered HTTP 415
// (it will not serve a stylesheet to an HTML accept header), and the whole
// clinic was recorded as a fetch failure. Every one of those is a clinic we
// could have read.
const ASSET_PATH = /\.(css|js|mjs|json|xml|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|zip|pdf)(\?|$)/i;

function scoreLink(url, hints) {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch (e) { return -1; }
  if (ASSET_PATH.test(path)) return -1;
  if (BLOG_PATH.test(path)) return -1;
  const flat = path.replace(/[^a-z]+/g, '-');
  let best = -1;
  hints.forEach((h, i) => {
    const idx = flat.indexOf(h);
    if (idx === -1) return;
    // shorter paths win: /technology beats /blog/what-technology-means
    const s = 100 - i - path.split('/').filter(Boolean).length * 5 - Math.min(idx, 40);
    if (s > best) best = s;
  });
  return best;
}

function pickLink(links, hints, host, exclude) {
  let bestUrl = null, bestScore = 0;
  for (const l of links) {
    let h;
    try { h = new URL(l).hostname.replace(/^www\./, ''); } catch (e) { continue; }
    if (h !== host) continue;
    if (exclude && exclude.has(l)) continue;
    const s = scoreLink(l, hints);
    if (s > bestScore) { bestScore = s; bestUrl = l; }
  }
  return bestUrl;
}

// ===========================================================================
// One host
// ===========================================================================

async function crawlHost(row, matcher) {
  const host = row.host;
  const home = row.home_url || ('https://' + host + '/');
  const seen = new Set();
  const pages = [];
  let pagesTried = 0;
  let lastError = null;
  let sawJsOnly = false;

  const readPage = async url => {
    if (seen.has(url) || pages.length >= 3) return null;
    seen.add(url);
    pagesTried++;
    const r = await getPage(url);
    if (/\.(css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(\?|$)/i.test(url)) {
      // Second line of defence: no code path should ever fetch an asset as a
      // page, and if one does it is a bug worth seeing rather than a timeout.
      lastError = 'ASSET URL, not a page: ' + url;
      return null;
    }
    if (!r.ok) {
      // 403 and 429 are the site CHOOSING to refuse us. Labelling them
      // separately matters: they are not transient, so requeueing them forever
      // is pointless, and they are the population that needs manual entry or a
      // portal invitation instead.
      const blocked = (r.status === 403 || r.status === 429 || r.status === 401);
      const msg = (blocked ? 'BLOCKED ' : '') + 'HTTP ' + r.status
        + (r.error ? ' ' + r.error : '') + ' ' + url;
      // A dead LINK is not a dead HOST. Ottawa Derm Centre read fine and was
      // recorded as failed because a picked /pricing-menu/ had gone. Only
      // overwrite lastError while nothing has been read yet, so the host's
      // verdict reflects the homepage rather than the last broken guess.
      if (pages.length === 0) lastError = msg;
      return null;
    }
    // A page came back. Whatever failed on the way here (a dead apex, a 404 on
    // a picked link) is no longer this host's verdict — leaving it set kept
    // chickingston.com in the "failed" bucket while it was reading fine, which
    // would have meant the coverage number never improved.
    lastError = null;
    const text = toText(r.html);
    const thin = looksJsOnly(r.html, text);
    if (thin) sawJsOnly = true;
    // A JavaScript-only page used to be thrown away whole. Its BODY copy is
    // indeed empty, but the meta description and the JSON-LD block are served
    // statically and are worth reading. The empty body is dropped, not the page.
    const page = {
      url: r.url,
      text: (thin ? '' : text) + ' ' + metaDescription(r.html) + ' ' + jsonLdText(r.html),
      links: hrefs(r.html, r.url),
      thin: thin
    };
    pages.push(page);
    return thin ? null : page;
  };

  let homePage = await readPage(home);
  if (!homePage && !sawJsOnly) {
    // one retry on the bare http host, which the price run showed recovers a few
    homePage = await readPage('http://' + host + '/');
  }
  // The apex is not always the site. `host` has had any www. stripped, but a
  // fair number of these domains only answer on www — nine of the top failing
  // hosts by review count were exactly this, including several 300+ review
  // clinics. Try the www form before calling the host dead.
  if (!homePage && !sawJsOnly && !/^www\./i.test(host)) {
    homePage = await readPage('https://www.' + host + '/')
            || await readPage('http://www.' + host + '/');
  }
  // Nothing at all came back, not even a thin page: a genuine fetch failure.
  if (!pages.length) {
    return { status: 'error', pagesTried, lastError, matches: [], unknowns: [] };
  }

  let techUrl = null;
  if (homePage) {
    techUrl = pickLink(homePage.links, TECH_HINTS, host.replace(/^www\./, ''), seen);
    if (techUrl) await readPage(techUrl);
    const svcUrl = pickLink(homePage.links, SERVICE_HINTS, host.replace(/^www\./, ''), seen);
    if (svcUrl) await readPage(svcUrl);
  }

  // ---- the sitemap pass ---------------------------------------------------
  // Run for EVERY host, not just the JavaScript-only ones. It costs one extra
  // fetch and it feeds the own-page tier directly, which is the evidence the
  // review queue trusts most.
  const sm = await sitemapUrls(host.replace(/^www\./, ''));
  const sitemapLinks = sm.urls;

  // The homepage nav usually carries every device link on the site, so the
  // own-page signal is computed against the union of hrefs from all pages read.
  const allLinks = pages.flatMap(p => p.links).concat(sitemapLinks);
  const thinOnly = pages.every(p => p.thin);
  const byDevice = new Map();
  const unknowns = new Map();

  for (const p of pages) {
    const linkBlob = allLinks.join(' ');
    const res = matchDevices(p.text + ' ' + linkBlob, p.url, matcher);
    for (const m of res.matches) {
      const prev = byDevice.get(m.device_id);
      if (!prev || RANK[m.confidence] > RANK[prev.confidence]) {
        byDevice.set(m.device_id, Object.assign({}, m, { source_url: p.url }));
      }
    }
    // ⭐ PAGE RANK MATTERS. Home was read first and used to win every tie, so a
    // nav label from the homepage beat the same-named token found in prose on
    // the technology page. Tech and service pages now outrank home.
    const pageRank = TECH_PATH.test(p.url) ? 3 : (SERVICE_PATH.test(p.url) ? 2 : 1);
    for (const u of res.unknowns) {
      const cand = Object.assign({}, u, { source_url: p.url, page_rank: pageRank });
      const prev = unknowns.get(u.token_norm);
      if (!prev
          || pageRank > (prev.page_rank || 0)
          || (pageRank === (prev.page_rank || 0) && (u.score || 0) > (prev.score || 0))) {
        unknowns.set(u.token_norm, cand);
      }
    }
  }

  const matches = [...byDevice.values()].slice(0, MAX_DEVICES_PER_HOST);

  // A host whose pages were ALL thin and which still yielded nothing stays
  // needs_render, because a renderer is the only thing left that could help it.
  // One that yielded something is done, and its rows are marked so review can
  // see the evidence came from a sitemap rather than from readable text.
  const status = matches.length ? 'done' : (thinOnly ? 'needs_render' : 'empty');

  return {
    status: status,
    pagesTried,
    lastError,
    techUrl: techUrl || null,
    thinOnly: thinOnly,
    sitemapUrls: sitemapLinks.length,
    sitemapSource: sm.source,
    matches,
    unknowns: [...unknowns.values()]
      .sort((a, b) => (b.page_rank || 0) - (a.page_rank || 0) || (b.score || 0) - (a.score || 0))
      .slice(0, MAX_UNKNOWNS_PER_HOST)
  };
}

// ===========================================================================
// Handler. This function owns the whole M39 surface: the crawl loop AND the
// candidate review. Deliberately kept out of admin-action.js so nothing here can
// break the M38 price handlers that already run in production.
// ===========================================================================

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };

  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (secret !== process.env.ADMIN_SECRET) return json(401, { error: 'unauthorized' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const action = body.action || 'crawl';

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  try {
    switch (action) {
      case 'crawl':               return json(200, await doCrawl(supabase, body));
      case 'candidate-stats':     return json(200, await candidateStats(supabase, body));
      case 'list-candidates':     return json(200, await listCandidates(supabase, body));
      case 'approve-candidates':  return json(200, await decide(supabase, body, true));
      case 'reject-candidates':   return json(200, await decide(supabase, body, false));
      case 'list-unknowns':       return json(200, await listUnknowns(supabase, body));
      default:                    return json(400, { error: 'unknown action: ' + action });
    }
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) });
  }
};

// ---------------------------------------------------------------------------
// crawl
// ---------------------------------------------------------------------------

async function doCrawl(supabase, body) {
  const batch = Math.min(Math.max(parseInt(body.batch, 10) || BATCH_DEFAULT, 1), BATCH_MAX);

  // ⭐ COUNTRY SCOPING. The queue holds every country now. Without this a US run
  // drains Canada's pending rows and a "retry failed" requeues Canada's errors.
  // Empty means every country, which is the old behaviour.
  const country = (body.country || '').trim().toLowerCase();

  // ⭐ SINGLE-HOST MODE. Crawl one named host immediately, whatever its queue
  // status, and report what happened.
  //
  // This exists because every diagnosis so far has required a full country run
  // or a guess. When a clinic we know owns 25 machines comes back with none, the
  // question "what did the crawler actually read on that host" should take
  // fifteen seconds, not a week.
  const oneHost = (body.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

  if (body.retry === true) {
    let rq = supabase.from('crawl_device_queue')
      .update({ status: 'pending', last_error: null })
      .in('status', ['error', 'running']);
    if (country) rq = rq.eq('country', country);
    await rq;
  }

  // One run row per crawl session, so a month-over-month diff can be scoped.
  let runId = body.run_id || null;
  if (!runId) {
    const { data } = await supabase.from('device_crawl_runs')
      .insert({ label: body.label || null }).select('id').single();
    runId = data ? data.id : null;
  }

  let claimQuery = supabase
    .from('crawl_device_queue')
    .select('id, host, clinic_ids, home_url, attempts');

  if (oneHost) {
    // Deliberately ignores status and `excluded`: the whole point is to inspect
    // a host the normal loop would skip.
    claimQuery = claimQuery.eq('host', oneHost).limit(1);
  } else {
    // ⭐ `excluded` is now honoured. Aggregator, hotel and umbrella hosts are
    // seeded excluded so the crawler never reads a booking platform's marketing
    // copy and attributes it to 52 unrelated clinics.
    claimQuery = claimQuery.eq('status', 'pending').eq('excluded', false);
    if (country) claimQuery = claimQuery.eq('country', country);
    claimQuery = claimQuery.order('id', { ascending: true }).limit(batch);
  }

  const { data: claimable, error: claimErr } = await claimQuery;
  if (claimErr) throw claimErr;

  if (oneHost && (!claimable || !claimable.length)) {
    return { done: true, run_id: runId, processed: [], remaining: 0,
             note: 'No queue row for host "' + oneHost + '". Check the spelling, or it may be stored with a www prefix or a subdomain.' };
  }

  if (!claimable || !claimable.length) {
    return { done: true, run_id: runId, processed: [], remaining: 0 };
  }

  await supabase.from('crawl_device_queue')
    .update({ status: 'running' })
    .in('id', claimable.map(r => r.id));

  // Read the reference list fresh every invocation, so correcting a row is a SQL
  // update and never a redeploy.
  const { data: devices, error: refErr } = await supabase
    .from('device_reference')
    .select('id, model, model_aliases, manufacturer, manufacturer_aliases, category, name_is_also_generic, exclusion_phrases, corroborate_aliases, active')
    .eq('active', true);
  if (refErr) throw refErr;
  const matcher = buildMatcher(devices || []);

  const processed = [];

  // ⭐⭐ A WALL-CLOCK DEADLINE. Netlify kills a function at 26 seconds and
  // returns an HTML error page, which the browser loop cannot parse, so the
  // whole crawl stops and has to be restarted by hand. One slow host should
  // cost one host, never the run.
  //
  // Any host still unclaimed when the deadline passes is released back to
  // 'pending' so the next invocation picks it up. Nothing is lost or skipped.
  const DEADLINE_MS = 20000;
  const startedAt = Date.now();
  const deferred = [];

  for (const row of claimable) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      deferred.push(row.id);
      continue;
    }
    let out;
    try {
      out = await crawlHost(row, matcher);
    } catch (e) {
      out = { status: 'error', pagesTried: 0, lastError: String((e && e.message) || e), matches: [], unknowns: [] };
    }

    const clinicIds = Array.isArray(row.clinic_ids) ? row.clinic_ids : [];
    let inserted = 0;

    if (out.matches.length && clinicIds.length) {
      // A host fans out to every clinic on it, franchises included, the same
      // chain rule the price crawl settled on.
      const rows = [];
      for (const clinicId of clinicIds) {
        for (const m of out.matches) {
          rows.push({
            clinic_id: clinicId,
            host: row.host,
            device_id: m.device_id,
            matched_text: m.matched_text,
            source_url: m.source_url,
            // A host whose pages were all JavaScript-only has no readable body
            // copy, so its evidence came from the sitemap, the meta description
            // or a JSON-LD block. Say so, rather than letting review assume the
            // device name was read off a visible page.
            page_kind: out.thinOnly ? 'sitemap' : m.page_kind,
            confidence: m.confidence,
            status: 'pending',
            run_id: runId
          });
        }
      }
      // ⚠️⚠️ NOT a plain upsert any more. `ignore duplicates` meant a re-crawl
      // could only ever ADD a clinic it had never matched — it could never
      // revisit one it had seen, so stale pre-fix rows survived a full crawl
      // untouched and the run afterwards reported almost nothing. A monthly
      // schedule built on that inherits every earlier mistake permanently.
      //
      // upsert_device_candidates() refreshes the evidence every run and keeps
      // the human decision, EXCEPT when matched_text changes — a genuinely
      // different claim goes back to pending. So a rejected row cannot be
      // resurrected by re-reading the same page, and a device the clinic newly
      // advertises does surface.
      for (let i = 0; i < rows.length; i += 200) {
        const slice = rows.slice(i, i + 200);
        const { data, error } = await supabase.rpc('upsert_device_candidates', { p_rows: slice });
        if (!error) {
          inserted += slice.length;
          for (const r of (data || [])) {
            if (r.action === 'inserted') out.candidatesNew = (out.candidatesNew || 0) + Number(r.n);
            else out.candidatesRefreshed = (out.candidatesRefreshed || 0) + Number(r.n);
          }
        } else out.lastError = 'candidate upsert: ' + error.message;
      }
    }

    // ---- sightings: one row per (clinic, device, run, url), plain insert -----
    // The candidate table now carries ONE standing row per clinic+device,
    // refreshed each run. Sightings remain the per-run history: every run
    // records what THIS run's matcher believed, at which url, so the trail
    // survives even after a candidate is refreshed or its status changes.
    // This never touches a candidate row, so no approve/reject can be clobbered.
    // ignoreDuplicates handles the chain fan-out reading one host once per run.
    if (out.matches.length && clinicIds.length) {
      const sightRows = [];
      for (const clinicId of clinicIds) {
        for (const m of out.matches) {
          sightRows.push({
            clinic_id: clinicId,
            device_id: m.device_id,
            host: row.host,
            run_id: runId,
            source_url: m.source_url,
            page_kind: out.thinOnly ? 'sitemap' : m.page_kind,
            confidence: m.confidence
          });
        }
      }
      for (let i = 0; i < sightRows.length; i += 200) {
        await supabase.from('clinic_device_sightings')
          .upsert(sightRows.slice(i, i + 200),
                  { onConflict: 'clinic_id,device_id,run_id,source_url',
                    ignoreDuplicates: true });
      }
    }

    if (out.unknowns.length) {
      await supabase.from('device_unknown_tokens').insert(out.unknowns.map(u => ({
        token: u.token,
        token_norm: u.token_norm,
        host: row.host,
        clinic_id: clinicIds[0] || null,
        source_url: u.source_url,
        run_id: runId
      })));
    }

    await supabase.from('crawl_device_queue').update({
      status: out.status,
      tech_url: out.techUrl || null,
      pages_tried: out.pagesTried,
      devices_found: out.matches.length,
      unknowns_seen: out.unknowns.length,
      attempts: (row.attempts || 0) + 1,
      last_error: out.lastError,
      last_run_id: runId,
      fetched_at: new Date().toISOString()
    }).eq('id', row.id);

    // ---- per-run host record --------------------------------------------
    // The queue row above is OVERWRITTEN every run, losing its verdict history.
    // This keeps one immutable row per host per run, carrying the BLOCKED/HTTP
    // label, so a later "no sighting for this pair" can be read correctly:
    // host status 'done' with no sighting = brand gone; 'error'/blocked = we
    // could not look, leave the published row alone. That distinction is the
    // whole reason the change feed can ever be trusted.
    if (runId) {
      await supabase.from('crawl_run_hosts')
        .upsert({
          run_id: runId,
          host: row.host,
          status: out.status,
          pages_read: out.pagesTried,
          devices_found: out.matches.length,
          last_error: out.lastError || null
        }, { onConflict: 'run_id,host', ignoreDuplicates: false });
    }

    processed.push({
      host: row.host,
      // Single-host mode returns the evidence, not just the verdict: which pages
      // were read, what the sitemap gave, and every unmatched capitalised token.
      diagnostic: oneHost ? {
        pages_read: out.pagesTried,
        tech_url: out.techUrl,
        sitemap_urls: out.sitemapUrls || 0,
        sitemap_source: out.sitemapSource || null,
        thin_only: !!out.thinOnly,
        matched: out.matches.map(m => m.model + ' [' + m.confidence + '/' + m.page_kind + '] via "' + m.matched_text + '"'),
        unmatched_sample: out.unknowns.map(u => u.token),
        error: out.lastError || null,
      } : undefined,
      status: out.status,
      clinics: clinicIds.length,
      pages: out.pagesTried,
      sitemap_urls: out.sitemapUrls || 0,
      thin_only: !!out.thinOnly,
      inserted: inserted,
      // The number that makes a monthly run readable: how much of this was
      // actually new versus a re-confirmation of what we already had.
      candidates_new: out.candidatesNew || 0,
      candidates_refreshed: out.candidatesRefreshed || 0,
      devices: out.matches.map(m => ({ model: m.model, category: m.category, confidence: m.confidence })),
      unknowns: out.unknowns.map(u => u.token),
      error: out.lastError || null
    });
  }

  // Put anything the deadline cut short back in the queue.
  if (deferred.length) {
    await supabase
      .from('crawl_device_queue')
      .update({ status: 'pending' })
      .in('id', deferred);
    console.log('deadline reached, released ' + deferred.length + ' host(s) back to pending');
  }

  let remQ = supabase
    .from('crawl_device_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('excluded', false);
  if (country) remQ = remQ.eq('country', country);
  const { count: remaining } = await remQ;

  if (runId) {
    const { data: cur } = await supabase
      .from('device_crawl_runs').select('hosts_done').eq('id', runId).single();
    await supabase.from('device_crawl_runs')
      .update({ hosts_done: ((cur && cur.hosts_done) || 0) + claimable.length })
      .eq('id', runId);
  }

  return { done: false, run_id: runId, processed, remaining: remaining || 0 };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

async function candidateStats(supabase, body) {
  const country = ((body && body.country) || '').trim().toLowerCase();
  const c = async (table, col, val) => {
    const q = supabase.from(table).select('id', { count: 'exact', head: true });
    const { count } = col ? await q.eq(col, val) : await q;
    return count || 0;
  };
  // Queue counts are country-scoped; candidate counts are not, because
  // clinic_device_candidates has no country column. The tab labels them.
  const qc = async (status) => {
    let q = supabase.from('crawl_device_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', status).eq('excluded', false);
    if (country) q = q.eq('country', country);
    const { count } = await q;
    return count || 0;
  };
  const [pending, approved, rejected, queuePending, queueDone, queueEmpty, needsRender, queueError, listed, unknowns] =
    await Promise.all([
      c('clinic_device_candidates', 'status', 'pending'),
      c('clinic_device_candidates', 'status', 'approved'),
      c('clinic_device_candidates', 'status', 'rejected'),
      qc('pending'),
      qc('done'),
      qc('empty'),
      qc('needs_render'),
      qc('error'),
      c('clinic_devices', null, null),
      c('device_unknown_tokens', null, null)
    ]);
  // Per-device breakdown of what is waiting. Drives the device filter, and on
  // its own it is a useful signal: one device dominating the queue is either a
  // real discovery or a bad alias, and either way it wants looking at before
  // anyone approves in bulk.
  let byDevice = [];
  try {
    const { data: pend } = await supabase
      .from('clinic_device_candidates').select('device_id').eq('status', 'pending').limit(20000);
    const tally = new Map();
    for (const r of (pend || [])) tally.set(r.device_id, (tally.get(r.device_id) || 0) + 1);
    if (tally.size) {
      const { data: devs } = await supabase
        .from('device_reference').select('id, model, manufacturer').in('id', [...tally.keys()]);
      byDevice = (devs || []).map(d => ({
        device_id: d.id, model: d.model, manufacturer: d.manufacturer, pending: tally.get(d.id) || 0
      })).sort((a, b) => b.pending - a.pending || String(a.model).localeCompare(String(b.model)));
    }
  } catch (e) { byDevice = []; }

  return {
    counts: { pending, approved, rejected },
    by_device: byDevice,
    queue: { pending: queuePending, done: queueDone, empty: queueEmpty, needs_render: needsRender, error: queueError },
    clinic_devices: listed,
    unknown_tokens: unknowns
  };
}

// Two hops, never a PostgREST embed. The embed approach broke on the Taiwan
// crawler and the fix was to join in JS.
async function listCandidates(supabase, body) {
  const status = ['pending', 'approved', 'rejected'].includes(body.status) ? body.status : 'pending';
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 300, 1), 1000);

  let q = supabase.from('clinic_device_candidates')
    .select('id, clinic_id, host, device_id, matched_text, source_url, page_kind, confidence, status, note, crawled_at')
    .eq('status', status)
    .order('host', { ascending: true })
    .limit(limit);
  if (body.confidence) q = q.eq('confidence', body.confidence);
  // ⚠️ Reviewing one device at a time is the difference between a decision and
  // a rubber stamp. Without this, "select all" on a pending list takes every
  // device at once — which is how 46 DermaV rows we had deliberately set aside
  // went live alongside a legitimate 281-clinic Bela MD batch.
  if (body.device_id) q = q.eq('device_id', parseInt(body.device_id, 10));

  const { data: cands, error } = await q;
  if (error) throw error;
  if (!cands || !cands.length) return { candidates: [] };

  const clinicIds = [...new Set(cands.map(c => c.clinic_id))];
  const deviceIds = [...new Set(cands.map(c => c.device_id))];

  // US rows carry `state`, Canadian rows carry `province`. Selecting only
  // province rendered every US candidate with a blank region column.
  const { data: clinics } = await supabase
    .from('clinics').select('id, name, province, state, country').in('id', clinicIds);
  const { data: devices } = await supabase
    .from('device_reference').select('id, model, manufacturer, category').in('id', deviceIds);

  const clinicById = new Map((clinics || []).map(c => [c.id, c]));
  const deviceById = new Map((devices || []).map(d => [d.id, d]));

  // Country filter is applied here rather than in SQL: the candidates table has
  // no country column, and the limit is <=1000 so a JS pass is cheap.
  const wantCountry = (body.country || '').trim().toLowerCase();
  const keep = wantCountry
    ? cands.filter(c => ((clinicById.get(c.clinic_id) || {}).country || '') === wantCountry)
    : cands;

  return {
    candidates: keep.map(c => {
      const cl = clinicById.get(c.clinic_id) || {};
      const dv = deviceById.get(c.device_id) || {};
      return Object.assign({}, c, {
        clinic_name: cl.name || c.clinic_id,
        clinic_region: cl.province || cl.state || '',
        clinic_country: cl.country || '',
        model: dv.model || ('device ' + c.device_id),
        manufacturer: dv.manufacturer || '',
        category: dv.category || ''
      });
    })
  };
}

async function decide(supabase, body, approve) {
  const ids = body.ids || (body.id ? [body.id] : []);
  if (!ids.length) return { error: 'no ids', approved: 0, rejected: 0 };

  const { data: cands, error } = await supabase
    .from('clinic_device_candidates')
    .select('id, clinic_id, device_id, matched_text, source_url, confidence, run_id, crawled_at')
    .in('id', ids)
    .eq('status', 'pending');
  if (error) throw error;
  if (!cands || !cands.length) return { approved: 0, rejected: 0, errors: ['nothing pending in that selection'] };

  const now = new Date().toISOString();

  if (!approve) {
    await supabase.from('clinic_device_candidates')
      .update({ status: 'rejected', reviewed_at: now, note: body.note || null })
      .in('id', cands.map(c => c.id));
    return { rejected: cands.length };
  }

  // Which pairs are already published, so first_seen is preserved and the change
  // feed does not log an "added" event for a device that was already there.
  const { data: existing } = await supabase
    .from('clinic_devices')
    .select('clinic_id, device_id')
    .in('clinic_id', [...new Set(cands.map(c => c.clinic_id))]);
  const already = new Set((existing || []).map(r => r.clinic_id + '|' + r.device_id));

  const today = (cands[0].crawled_at || now).slice(0, 10);
  const isNew = c => !already.has(c.clinic_id + '|' + c.device_id);
  const day = c => (c.crawled_at || now).slice(0, 10);

  // ⚠️ first_seen must NEVER be rewritten. A plain upsert would reset it to the
  // newer crawl date every time a device is re-approved from a later run, which
  // destroys the "installed since" signal that the change feed is sold on. So
  // new pairs and existing pairs are written separately, and the update path
  // simply omits the column.
  const inserts = cands.filter(isNew).map(c => ({
    clinic_id: c.clinic_id,
    device_id: c.device_id,
    status: 'listed',
    source: 'website',
    source_url: c.source_url,
    matched_text: c.matched_text,
    // Dated to the day the PAGE was read, not the day of approval. Staleness is
    // what turns crawled data into a complaint, same call as the price crawl.
    first_seen: day(c),
    last_seen: day(c),
    updated_at: now
  }));

  const refreshes = cands.filter(c => !isNew(c)).map(c => ({
    clinic_id: c.clinic_id,
    device_id: c.device_id,
    source_url: c.source_url,
    matched_text: c.matched_text,
    last_seen: day(c),
    updated_at: now
  }));

  const errors = [];
  let approved = 0;
  for (let i = 0; i < inserts.length; i += 200) {
    const slice = inserts.slice(i, i + 200);
    const { error: upErr } = await supabase.from('clinic_devices')
      .upsert(slice, { onConflict: 'clinic_id,device_id' });
    if (upErr) errors.push(upErr.message);
    else approved += slice.length;
  }
  for (let i = 0; i < refreshes.length; i += 200) {
    const slice = refreshes.slice(i, i + 200);
    const { error: upErr } = await supabase.from('clinic_devices')
      .upsert(slice, { onConflict: 'clinic_id,device_id' });
    if (upErr) errors.push(upErr.message);
    else approved += slice.length;
  }

  // The change feed. Only genuinely new pairs produce an 'added' event.
  const events = cands
    .filter(c => !already.has(c.clinic_id + '|' + c.device_id))
    .map(c => ({
      clinic_id: c.clinic_id,
      device_id: c.device_id,
      event: 'added',
      observed_at: today,
      run_id: c.run_id,
      source_url: c.source_url
    }));
  if (events.length) await supabase.from('clinic_device_events').insert(events);

  await supabase.from('clinic_device_candidates')
    .update({ status: 'approved', reviewed_at: now })
    .in('id', cands.map(c => c.id));

  return { approved, new_events: events.length, errors };
}

// The census. Grouped in JS because a GROUP BY over PostgREST needs a view, and
// this table is small enough that it is not worth one.
async function listUnknowns(supabase, body) {
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 2000, 1), 5000);
  const { data, error } = await supabase
    .from('device_unknown_tokens')
    .select('token, token_norm, host, source_url')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const grouped = new Map();
  for (const r of (data || [])) {
    const g = grouped.get(r.token_norm) || { token: r.token, token_norm: r.token_norm, hosts: new Set(), sample_url: r.source_url };
    g.hosts.add(r.host);
    grouped.set(r.token_norm, g);
  }
  return {
    unknowns: [...grouped.values()]
      .map(g => ({ token: g.token, token_norm: g.token_norm, host_count: g.hosts.size, sample_url: g.sample_url }))
      .sort((a, b) => b.host_count - a.host_count)
      .slice(0, 300)
  };
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-admin-secret',
    'access-control-allow-methods': 'POST, OPTIONS'
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: Object.assign({ 'content-type': 'application/json' }, cors()),
    body: JSON.stringify(obj)
  };
}

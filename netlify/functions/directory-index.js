// directory-index.js
// Server-rendered, JavaScript-free HTML index of every TW + HK + US clinic
// profile. Its sole job is to give Googlebot a crawlable link path to all
// /clinic/{slug} pages, which currently exist only in sitemap.xml and are
// therefore stuck in "Discovered - currently not indexed".
//
// Every clinic is a plain <a href="/clinic/{slug}"> link. Pagination is real
// <a> links (numbered plus prev/next) so a crawler can reach all pages from
// page 1 without running any script. Slug + dedup logic mirrors sitemap-com.js
// exactly, so every link here resolves to the same URL the sitemap emits.
//
// Route (add to netlify.toml):
//   /directory        -> this function (page 1)
//   /directory?page=N -> page N
// Deploy to: netlify/functions/directory-index.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://skinday.com';
const PER_PAGE = 300;

const COUNTRY_META = {
  taiwan:   { order: 0, label: 'Taiwan',        zh: '台灣' },
  hongkong: { order: 1, label: 'Hong Kong',     zh: '香港' },
  usa:      { order: 2, label: 'United States', zh: '美國' },
};

// Identical to sitemap-com.js toSlug so links stay in lockstep with the sitemap.
function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageLink(n, label, current) {
  if (n === current) {
    return `<span class="pg pg-current">${esc(label)}</span>`;
  }
  return `<a class="pg" href="/directory?page=${n}">${esc(label)}</a>`;
}

function buildPagination(current, totalPages) {
  if (totalPages <= 1) return '';
  const parts = [];
  if (current > 1) parts.push(pageLink(current - 1, '‹ 上一頁 Prev', current));
  for (let n = 1; n <= totalPages; n++) {
    parts.push(pageLink(n, String(n), current));
  }
  if (current < totalPages) parts.push(pageLink(current + 1, '下一頁 Next ›', current));
  return `<nav class="pagination" aria-label="Directory pages">${parts.join('')}</nav>`;
}

exports.handler = async (event) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, country, neighbourhood, reviews')
      .in('country', ['taiwan', 'hongkong', 'usa'])
      .eq('approved', true)
      .not('name', 'is', null)
      .not('neighbourhood', 'is', null)
      .range(0, 29999);

    if (error) {
      console.error('directory-index: supabase error', error.message);
      return { statusCode: 500, body: 'Database error' };
    }

    // Dedup by slug, skip empty slugs (Chinese-only names) exactly as the
    // sitemap does, so the set of links here matches the set of indexable URLs.
    const seen = new Set();
    const rows = [];
    for (const c of clinics || []) {
      const slug = toSlug(c.name);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      rows.push({
        slug,
        name: c.name,
        country: c.country,
        hood: c.neighbourhood || '',
      });
    }

    // Sort by country order, then neighbourhood, then name, so grouped
    // headings read sensibly and pagination is stable across rebuilds.
    rows.sort((a, b) => {
      const ca = (COUNTRY_META[a.country] || { order: 9 }).order;
      const cb = (COUNTRY_META[b.country] || { order: 9 }).order;
      if (ca !== cb) return ca - cb;
      if (a.hood !== b.hood) return a.hood.localeCompare(b.hood);
      return a.name.localeCompare(b.name);
    });

    const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    let page = parseInt((event.queryStringParameters || {}).page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const start = (page - 1) * PER_PAGE;
    const slice = rows.slice(start, start + PER_PAGE);

    // Render the slice, emitting a country + neighbourhood heading whenever
    // either changes within this page.
    let lastCountry = null;
    let lastHood = null;
    const body = [];
    for (const r of slice) {
      if (r.country !== lastCountry) {
        const m = COUNTRY_META[r.country] || { label: r.country, zh: '' };
        body.push(`<h2 class="country">${esc(m.zh)} ${esc(m.label)}</h2>`);
        lastCountry = r.country;
        lastHood = null;
      }
      if (r.hood !== lastHood) {
        body.push(`<h3 class="hood">${esc(r.hood)}</h3>`);
        lastHood = r.hood;
      }
      body.push(`<a class="clinic" href="/clinic/${esc(r.slug)}">${esc(r.name)}</a>`);
    }

    const pagination = buildPagination(page, totalPages);
    const canonical = page === 1 ? `${SITE}/directory` : `${SITE}/directory?page=${page}`;

    const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>診所目錄 Clinic Directory · SkinDay${page > 1 ? ' (' + page + ')' : ''}</title>
<meta name="description" content="Browse every aesthetic clinic listed on SkinDay across Taiwan, Hong Kong, and the United States.">
<link rel="canonical" href="${canonical}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=Noto+Serif+TC:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --deep: #1C1714;
    --cream: #FAF7F2;
    --rose: #C8725A;
    --gold: #C9A96E;
    --muted: #8a7f76;
    --border: rgba(28,23,20,0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--cream);
    color: var(--deep);
    font-family: 'DM Sans', 'Noto Serif TC', sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  header nav { display: flex; flex-wrap: wrap; gap: 1.1rem; font-size: 0.9rem; margin-bottom: 2rem; }
  header nav a { color: var(--muted); text-decoration: none; }
  header nav a:hover { color: var(--rose); }
  h1 { font-family: 'Cormorant Garamond', serif; font-weight: 500; font-size: 2.2rem; margin: 0 0 0.4rem; }
  .lede { color: var(--muted); font-size: 0.95rem; margin: 0 0 2rem; max-width: 60ch; }
  h2.country {
    font-family: 'Cormorant Garamond', serif; font-weight: 600; font-size: 1.55rem;
    margin: 2.4rem 0 0.4rem; padding-bottom: 0.4rem; border-bottom: 2px solid var(--gold);
  }
  h3.hood {
    font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--rose); margin: 1.5rem 0 0.6rem;
  }
  a.clinic {
    display: block; color: var(--deep); text-decoration: none;
    padding: 0.4rem 0; font-size: 0.95rem; border-bottom: 1px solid var(--border);
  }
  a.clinic:hover { color: var(--rose); }
  .pagination { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 3rem 0 0; align-items: center; }
  .pg {
    display: inline-block; padding: 0.4rem 0.7rem; font-size: 0.85rem;
    text-decoration: none; color: var(--deep); border: 1px solid var(--border); border-radius: 7px;
  }
  .pg:hover { border-color: var(--rose); color: var(--rose); }
  .pg-current { background: var(--deep); color: var(--cream); border-color: var(--deep); }
  footer { margin-top: 3rem; font-size: 0.85rem; color: var(--muted); }
  footer a { color: var(--muted); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <nav>
        <a href="/">SkinDay</a>
        <a href="/taiwan">台灣 Taiwan</a>
        <a href="/hongkong">香港 Hong Kong</a>
        <a href="/us">美國 United States</a>
      </nav>
      <h1>診所目錄 · Clinic Directory</h1>
      <p class="lede">Every aesthetic clinic listed on SkinDay across Taiwan, Hong Kong, and the United States. 探索 SkinDay 收錄的所有醫美診所。</p>
    </header>
    <main>
${body.join('\n')}
    </main>
    ${pagination}
    <footer>
      <p>Page ${page} of ${totalPages} · ${rows.length.toLocaleString('en-US')} clinics</p>
      <p><a href="/">← Back to SkinDay 返回首頁</a></p>
    </footer>
  </div>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
      body: html,
    };

  } catch (err) {
    console.error('directory-index: unhandled error', err.message);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

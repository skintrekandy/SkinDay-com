// render-us.js
// Handles all three US page types via URL depth:
//   /us                          -> state selector landing
//   /us/california               -> metro selector for a state
//   /us/california/los-angeles   -> clinic directory for a metro
// Deploy to: netlify/functions/render-us.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://skinday.com';

// ─── GEOGRAPHY CONFIG ────────────────────────────────────────────
// Live states + their metros. Coming-soon states render as disabled cards.
const STATES = {
  california: {
    label: 'California',
    live: true,
    metros: {
      'los-angeles':   { label: 'Los Angeles',     blurb: 'Beverly Hills, Santa Monica, Pasadena' },
      'san-francisco': { label: 'San Francisco Bay', blurb: 'SF, San Jose, Oakland, Palo Alto' },
      'san-diego':     { label: 'San Diego',         blurb: 'La Jolla, Carlsbad, Encinitas' },
      'orange-county': { label: 'Orange County',     blurb: 'Irvine, Newport Beach, Santa Ana' },
      'sacramento':    { label: 'Sacramento',        blurb: 'Roseville, Folsom, Elk Grove' },
      'inland-empire': { label: 'Inland Empire',     blurb: 'Riverside, San Bernardino, Corona' },
    }
  },
  'new-york': {
    label: 'New York',
    live: true,
    metros: {
      'new-york-city': { label: 'New York City', blurb: 'Manhattan, Brooklyn, Queens' },
    }
  },
};

// Coming-soon states (display only)
const COMING_SOON = ['Texas', 'Florida', 'Illinois', 'Washington', 'Massachusetts', 'Arizona'];

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

function starsHtml(rating) {
  if (!rating) return '';
  const r = parseFloat(rating);
  const full = Math.floor(r);
  const half = r - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '\u2605'.repeat(full) + (half ? '\u00BD' : '') + '\u2606'.repeat(empty);
}

// ─── SHARED PAGE CHROME ──────────────────────────────────────────
function pageHead(title, description, canonical, extraHead) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${canonical}" />
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="SkinDay" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/favicon.ico" />
  ${extraHead || ''}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root{--cream:#FAF7F2;--deep:#1C1714;--rose:#B06070;--rose-m:#C07585;--gold:#C9A96E;--text:#2C2724;--muted:#7A6E68;--border:#E8E0D6;}
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:var(--cream);color:var(--text);font-family:'DM Sans',system-ui,sans-serif;font-size:15px;line-height:1.6;}
    a{color:inherit;}
    .nav{background:var(--deep);padding:0 28px;height:60px;display:flex;align-items:center;justify-content:space-between;}
    .nav-logo{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--cream);text-decoration:none;letter-spacing:.03em;}
    .nav-logo span{color:var(--gold);}
    .nav-links{display:flex;gap:22px;align-items:center;}
    .nav-links a{font-size:.82rem;color:#B8ADA6;text-decoration:none;transition:color .15s;}
    .nav-links a:hover{color:var(--cream);}
    .wrap{max-width:1080px;margin:0 auto;padding:48px 28px 80px;}
    .breadcrumb{font-size:12px;color:var(--muted);margin-bottom:28px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .breadcrumb a{color:var(--muted);text-decoration:none;}
    .breadcrumb a:hover{color:var(--rose);}
    .hero-h1{font-family:'Cormorant Garamond',serif;font-size:2.6rem;font-weight:500;line-height:1.1;color:var(--deep);margin-bottom:14px;}
    .hero-sub{font-size:1rem;color:var(--muted);max-width:560px;margin-bottom:40px;}
    .card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;}
    .sel-card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:26px 24px;text-decoration:none;display:block;transition:transform .18s,box-shadow .18s,border-color .18s;}
    .sel-card:hover{transform:translateY(-3px);box-shadow:0 12px 36px rgba(28,23,20,.1);border-color:var(--rose-m);}
    .sel-card.disabled{opacity:.5;pointer-events:none;background:transparent;}
    .sel-card-title{font-family:'Cormorant Garamond',serif;font-size:1.5rem;font-weight:500;color:var(--deep);margin-bottom:6px;}
    .sel-card-blurb{font-size:.84rem;color:var(--muted);margin-bottom:12px;}
    .sel-card-count{font-size:.78rem;font-weight:600;color:var(--rose);letter-spacing:.02em;}
    .sel-card-soon{font-size:.7rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);background:var(--border);padding:3px 9px;border-radius:99px;display:inline-block;}
    .section-label{font-size:.72rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:44px 0 18px;}
    .section-label:first-of-type{margin-top:0;}
    /* directory grid */
    .clinic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;margin-top:8px;}
    .clinic-card{background:#fff;border:1px solid var(--border);border-radius:14px;overflow:hidden;text-decoration:none;display:block;transition:transform .18s,box-shadow .18s;}
    .clinic-card:hover{transform:translateY(-3px);box-shadow:0 12px 36px rgba(28,23,20,.1);}
    .clinic-cover{width:100%;height:160px;object-fit:cover;background:var(--border);display:block;}
    .clinic-cover-ph{width:100%;height:160px;background:linear-gradient(135deg,#E8E0D6,#D4C8BA);display:flex;align-items:center;justify-content:center;}
    .clinic-body{padding:16px 18px 18px;}
    .clinic-name{font-family:'Cormorant Garamond',serif;font-size:1.25rem;font-weight:500;color:var(--deep);line-height:1.2;margin-bottom:6px;}
    .clinic-meta{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:6px;margin-bottom:8px;}
    .clinic-rating{display:flex;align-items:center;gap:6px;font-size:.82rem;}
    .clinic-rating .stars{color:#E8A030;letter-spacing:1px;}
    .clinic-rating .score{font-weight:600;color:var(--text);}
    .clinic-rating .rev{color:var(--muted);font-size:.76rem;}
    .pagination{display:flex;justify-content:center;gap:8px;margin-top:40px;}
    .pagination a,.pagination span{padding:8px 14px;border-radius:8px;font-size:.84rem;text-decoration:none;border:1px solid var(--border);color:var(--text);}
    .pagination a:hover{border-color:var(--rose-m);color:var(--rose);}
    .pagination .current{background:var(--deep);color:var(--cream);border-color:var(--deep);}
    .pagination .disabled{opacity:.4;pointer-events:none;}
    .footer{border-top:1px solid var(--border);margin-top:60px;padding:32px 28px;text-align:center;font-size:.78rem;color:var(--muted);}
    @media(max-width:640px){.hero-h1{font-size:2rem;}.wrap{padding:32px 20px 60px;}}
  </style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">Skin<span>Day</span></a>
  <div class="nav-links">
    <a href="/us">US</a>
    <a href="/taiwan">Taiwan</a>
    <a href="/hongkong">Hong Kong</a>
    <a href="/visualize">Visualize</a>
  </div>
</nav>`;
}

function pageFoot() {
  return `
<div class="footer">
  SkinDay \u00B7 Aesthetic clinic directory \u00B7 <a href="/" style="color:var(--rose);text-decoration:none;">skinday.com</a>
</div>
</body>
</html>`;
}

// ─── PAGE 1: STATE SELECTOR (/us) ────────────────────────────────
async function renderUsLanding(supabase) {
  // Get clinic counts per state
  const { data, error } = await supabase
    .from('clinics')
    .select('state')
    .eq('country', 'usa')
    .eq('approved', true);

  const counts = {};
  if (!error && data) {
    for (const row of data) {
      counts[row.state] = (counts[row.state] || 0) + 1;
    }
  }

  const liveCards = Object.entries(STATES).map(([slug, st]) => {
    const n = counts[slug] || 0;
    return `<a href="/us/${slug}" class="sel-card">
      <div class="sel-card-title">${escapeHtml(st.label)}</div>
      <div class="sel-card-blurb">${Object.keys(st.metros).length} metro areas</div>
      <div class="sel-card-count">${n.toLocaleString()} clinics</div>
    </a>`;
  }).join('');

  const soonCards = COMING_SOON.map(name =>
    `<div class="sel-card disabled">
      <div class="sel-card-title">${escapeHtml(name)}</div>
      <div class="sel-card-blurb">&nbsp;</div>
      <span class="sel-card-soon">Coming soon</span>
    </div>`
  ).join('');

  const title = 'US Aesthetic Clinic Directory | SkinDay';
  const description = 'Find aesthetic and cosmetic clinics across the United States. Browse by state and metro area on SkinDay.';
  const canonical = `${SITE}/us`;

  return pageHead(title, description, canonical) + `
<div class="wrap">
  <div class="breadcrumb">
    <a href="/">Home</a><span>/</span><span>United States</span>
  </div>
  <h1 class="hero-h1">Aesthetic clinics across the United States</h1>
  <p class="hero-sub">Browse cosmetic and aesthetic clinics by state and metro area. Compare ratings, services, and locations.</p>

  <div class="section-label">Available now</div>
  <div class="card-grid">${liveCards}</div>

  <div class="section-label">Coming soon</div>
  <div class="card-grid">${soonCards}</div>
</div>` + pageFoot();
}

// ─── PAGE 2: METRO SELECTOR (/us/california) ─────────────────────
async function renderStatePage(supabase, stateSlug) {
  const st = STATES[stateSlug];
  if (!st) return null;

  const { data, error } = await supabase
    .from('clinics')
    .select('metro')
    .eq('country', 'usa')
    .eq('state', stateSlug)
    .eq('approved', true);

  const counts = {};
  if (!error && data) {
    for (const row of data) {
      counts[row.metro] = (counts[row.metro] || 0) + 1;
    }
  }

  const cards = Object.entries(st.metros).map(([slug, metro]) => {
    const n = counts[slug] || 0;
    return `<a href="/us/${stateSlug}/${slug}" class="sel-card">
      <div class="sel-card-title">${escapeHtml(metro.label)}</div>
      <div class="sel-card-blurb">${escapeHtml(metro.blurb)}</div>
      <div class="sel-card-count">${n.toLocaleString()} clinics</div>
    </a>`;
  }).join('');

  const title = `${st.label} Aesthetic Clinics | SkinDay`;
  const description = `Browse aesthetic and cosmetic clinics across ${st.label} metro areas. Compare clinics on SkinDay.`;
  const canonical = `${SITE}/us/${stateSlug}`;

  return pageHead(title, description, canonical) + `
<div class="wrap">
  <div class="breadcrumb">
    <a href="/">Home</a><span>/</span><a href="/us">United States</a><span>/</span><span>${escapeHtml(st.label)}</span>
  </div>
  <h1 class="hero-h1">${escapeHtml(st.label)} aesthetic clinics</h1>
  <p class="hero-sub">Choose a metro area to browse clinics, compare ratings and find the right injector.</p>

  <div class="card-grid">${cards}</div>
</div>` + pageFoot();
}

// ─── PAGE 3: METRO DIRECTORY (/us/california/los-angeles) ────────
async function renderMetroDirectory(supabase, stateSlug, metroSlug, page) {
  const st = STATES[stateSlug];
  if (!st) return null;
  const metro = st.metros[metroSlug];
  if (!metro) return null;

  const PER_PAGE = 60;
  const offset = (page - 1) * PER_PAGE;

  // Total count
  const { count } = await supabase
    .from('clinics')
    .select('id', { count: 'exact', head: true })
    .eq('country', 'usa')
    .eq('state', stateSlug)
    .eq('metro', metroSlug)
    .eq('approved', true);

  const total = count || 0;
  const totalPages = Math.ceil(total / PER_PAGE);

  // Page of clinics, highest rated first
  const { data: clinics, error } = await supabase
    .from('clinics')
    .select('id, name, neighbourhood, rating, reviews, photos, website')
    .eq('country', 'usa')
    .eq('state', stateSlug)
    .eq('metro', metroSlug)
    .eq('approved', true)
    .order('rating', { ascending: false, nullsFirst: false })
    .order('reviews', { ascending: false, nullsFirst: false })
    .range(offset, offset + PER_PAGE - 1);

  if (error) {
    console.error('render-us metro error', error.message);
    return null;
  }

  const cards = (clinics || []).map(c => {
    let photos = c.photos;
    if (typeof photos === 'string') {
      try { photos = JSON.parse(photos); } catch(e) {
        // Postgres array literal {url} form
        photos = photos.replace(/^\{|\}$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')).filter(Boolean);
      }
    }
    const photo = Array.isArray(photos) && photos.length ? photos[0] : null;
    const slug = toSlug(c.name);
    const href = slug ? `/clinic/${slug}` : '#';

    const cover = photo
      ? `<img class="clinic-cover" src="${escapeHtml(photo)}" alt="${escapeHtml(c.name)}" loading="lazy" />`
      : `<div class="clinic-cover-ph"><svg width="40" height="40" fill="none" stroke="#bbb" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>`;

    const rating = c.rating
      ? `<div class="clinic-rating"><span class="stars">${starsHtml(c.rating)}</span><span class="score">${escapeHtml(String(c.rating))}</span>${c.reviews ? `<span class="rev">(${c.reviews.toLocaleString()})</span>` : ''}</div>`
      : '';

    return `<a href="${href}" class="clinic-card">
      ${cover}
      <div class="clinic-body">
        <div class="clinic-name">${escapeHtml(c.name)}</div>
        <div class="clinic-meta">
          <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${escapeHtml(c.neighbourhood || metro.label)}
        </div>
        ${rating}
      </div>
    </a>`;
  }).join('');

  // Pagination
  let pagination = '';
  if (totalPages > 1) {
    const base = `/us/${stateSlug}/${metroSlug}`;
    const prev = page > 1
      ? `<a href="${base}${page-1 > 1 ? '?page='+(page-1) : ''}">Prev</a>`
      : `<span class="disabled">Prev</span>`;
    const next = page < totalPages
      ? `<a href="${base}?page=${page+1}">Next</a>`
      : `<span class="disabled">Next</span>`;
    pagination = `<div class="pagination">${prev}<span class="current">${page} of ${totalPages}</span>${next}</div>`;
  }

  const title = `${metro.label} Aesthetic Clinics | SkinDay`;
  const description = `Browse ${total} aesthetic and cosmetic clinics in ${metro.label}, ${st.label}. Compare ratings and find the right clinic on SkinDay.`;
  const canonical = page > 1 ? `${SITE}/us/${stateSlug}/${metroSlug}?page=${page}` : `${SITE}/us/${stateSlug}/${metroSlug}`;

  return pageHead(title, description, canonical) + `
<div class="wrap">
  <div class="breadcrumb">
    <a href="/">Home</a><span>/</span><a href="/us">United States</a><span>/</span><a href="/us/${stateSlug}">${escapeHtml(st.label)}</a><span>/</span><span>${escapeHtml(metro.label)}</span>
  </div>
  <h1 class="hero-h1">${escapeHtml(metro.label)} aesthetic clinics</h1>
  <p class="hero-sub">${total.toLocaleString()} clinics in ${escapeHtml(metro.label)}, ${escapeHtml(st.label)}. Ranked by rating and reviews.</p>

  <div class="clinic-grid">${cards}</div>
  ${pagination}
</div>` + pageFoot();
}

// ─── ROUTER ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Parse path segments after /us. event.path may be the original
    // request path (/us/california/los-angeles) under a 200 rewrite, or
    // the raw function path (/.netlify/functions/render-us). Anchor on 'us'.
    const rawPath = (event.path || '').replace(/^\/+|\/+$/g, '');
    let parts = rawPath.split('/').filter(Boolean);
    const usIdx = parts.indexOf('us');
    if (usIdx !== -1) {
      parts = parts.slice(usIdx); // drop anything before 'us'
    } else {
      parts = ['us']; // function path with no /us prefix -> treat as landing
    }
    // parts[0] === 'us'
    const stateSlug = parts[1] || null;
    const metroSlug = parts[2] || null;
    const page = Math.max(1, parseInt((event.queryStringParameters || {}).page || '1', 10) || 1);

    let html = null;

    if (!stateSlug) {
      html = await renderUsLanding(supabase);
    } else if (!metroSlug) {
      html = await renderStatePage(supabase, stateSlug);
    } else {
      html = await renderMetroDirectory(supabase, stateSlug, metroSlug, page);
    }

    if (!html) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html><html><head><title>Not Found | SkinDay</title><meta name="robots" content="noindex" /></head><body style="font-family:sans-serif;padding:40px;"><h2>Page not found</h2><p><a href="/us">Back to US directory</a></p></body></html>`
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
      },
      body: html
    };

  } catch (err) {
    console.error('render-us: unhandled error', err.message);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

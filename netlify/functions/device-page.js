// device-page.js — SERVER-RENDERED device × territory landing pages.
//
// ⭐⭐⭐ WHY A FUNCTION AND NOT A BUILD STEP. Andy deploys files; he does not run
// node or a generator. A Netlify function renders the page on request, so there
// is nothing to build, nothing to commit, and the pages update themselves as the
// crawl adds clinics. Google receives complete HTML either way, which is the
// whole point — the M19.2 note is explicit that JS-rendered pages on a domain
// Google has already demoted would prove nothing.
//
// ROUTES — the mount path is read from the request, so the SAME file serves
// two different namespaces:
//   skinday.com   /technology/ · /technology/:device/:territory · /technology/sitemap.xml
//   skinday.ca    /devices/:device/:territory · /devices/sitemap.xml
// .ca already serves /devices/ and /devices/{model} from render-devices.js
// (national, device-level). The province pages hang UNDER that rather than
// opening a rival /technology/ family, so the two never compete. Do NOT map
// bare /devices here — that index belongs to render-devices.js.
//
// ⚠️ THE THREE GUARDRAILS, all learned the hard way and all enforced here:
//   1. name_is_also_generic devices are NEVER a page. "Elite" and "Icon" as page
//      titles would be indefensible.
//   2. Below MIN_CLINICS the page 404s. 4,673 thin combinations are exactly the
//      pages already sitting in Search Console as "discovered, not indexed".
//   3. ONE GRAIN PER COUNTRY. Canada = province, USA = metro. Measured
//      2026-08-06: Canada's metro grain is 3,860 thin combos at 17 listings
//      each because Canadian rows carry city, not metro; the US metro grain is
//      418 pages at 38 each. Publishing both grains would cannibalise.

const { createClient } = require('@supabase/supabase-js');

const MIN_CLINICS = 10;
const MAX_CLINICS_LISTED = 60;
const CACHE = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';

// Canada = province, USA = metro. See the header note.
const GRAIN = { canada: 'province', usa: 'metro' };

// ⭐ ONE COUNTRY PER HOST. skinday.com's own netlify.toml 301s /canada to
// skinday.ca, so the Canadian directory and its clinic profiles live there.
// Rendering Canadian pages on .com as well would put two hosts in front of
// Google for the same content and split the signal — the exact problem the
// www-to-apex redirect in that file was added to fix.
function countryForHost(host) {
  const h = String(host || '').toLowerCase();
  if (h.endsWith('skinday.ca') || h.includes('skindayca')) return 'canada';
  if (h.endsWith('skinday.com') || h.includes('skindayglobal')) return 'usa';
  return null;                    // unknown host (previews): serve everything
}

function slugify(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PROVINCE_NAMES = {
  ab: 'Alberta', bc: 'British Columbia', mb: 'Manitoba', nb: 'New Brunswick',
  nl: 'Newfoundland and Labrador', ns: 'Nova Scotia', nt: 'Northwest Territories',
  nu: 'Nunavut', on: 'Ontario', pe: 'Prince Edward Island', qc: 'Quebec',
  sk: 'Saskatchewan', yt: 'Yukon'
};

// Province codes never appear as codes. A rep or a patient reading "BC" in a
// search result loses the context; "British Columbia" travels.
function territoryLabel(raw, country) {
  const s = String(raw == null ? '' : raw).trim();
  if (country === 'canada' && PROVINCE_NAMES[s.toLowerCase()]) return PROVINCE_NAMES[s.toLowerCase()];
  return s.replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
}

function num(n) {
  return (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------------

// Everything published, at the right grain, for devices that may carry a page.
// One read, reused for the index, the sitemap and the internal-link blocks —
// the alternative is a query per link and these pages are link-heavy.
async function loadCombos(supabase, onlyCountry) {
  const { data: devices, error: dErr } = await supabase
    .from('device_reference')
    .select('id, model, manufacturer, category')
    .eq('active', true)
    .eq('name_is_also_generic', false);
  if (dErr) throw dErr;
  const devById = new Map(devices.map(d => [d.id, d]));

  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('clinic_devices')
      .select('clinic_id, device_id, clinics!inner(id, name, slug, country, province, state, metro, neighbourhood, city, rating, reviews, approved)')
      .eq('status', 'listed')
      .eq('clinics.approved', true)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const combos = new Map();     // key -> combo
  for (const r of rows) {
    const dev = devById.get(r.device_id);
    const c = r.clinics;
    if (!dev || !c) continue;
    const country = String(c.country || '').toLowerCase();
    const grain = GRAIN[country];
    if (!grain) continue;
    if (onlyCountry && country !== onlyCountry) continue;

    const territory = grain === 'province'
      ? (country === 'usa' ? c.state : c.province)
      : c.metro;
    if (!territory) continue;

    // ⚠️ SLUG FROM THE LABEL, NOT THE RAW COLUMN. Canadian provinces are stored
    // as two-letter codes, so slugifying the column gives /devices/morpheus8/on
    // — a URL nobody searches and nobody can read. The sitemap spells them out,
    // and the two MUST agree or every listed URL 404s.
    const territorySlug = slugify(territoryLabel(territory, country));
    const key = dev.id + '|' + territorySlug;
    let combo = combos.get(key);
    if (!combo) {
      combo = {
        device: dev,
        country,
        territoryRaw: territory,
        territorySlug: territorySlug,
        deviceSlug: slugify(dev.model),
        clinics: []
      };
      combos.set(key, combo);
    }
    // A clinic can hold the same device twice via two rows; count it once.
    if (!combo.clinics.some(x => x.id === c.id)) {
      combo.clinics.push({
        id: c.id, name: c.name, slug: c.slug,
        area: c.neighbourhood || c.city || null,
        rating: c.rating, reviews: c.reviews
      });
    }
  }
  return [...combos.values()].filter(c => c.clinics.length >= MIN_CLINICS);
}

// ---------------------------------------------------------------------------
// MARKUP
// ---------------------------------------------------------------------------

function shell({ title, description, canonical, body, jsonld }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:type" content="article" />
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<style>
  :root{--ink:#1c1a17;--muted:#6b645c;--line:#e6e0d8;--warm:#faf7f2;--accent:#b4633a}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--ink);background:#fff}
  .wrap{max-width:860px;margin:0 auto;padding:1.5rem 1.2rem 4rem}
  header.site{border-bottom:1px solid var(--line);padding:1rem 1.2rem}
  header.site a{color:var(--ink);text-decoration:none;font-weight:600;letter-spacing:.02em}
  h1{font-size:2.1rem;line-height:1.2;margin:1.6rem 0 .6rem;font-weight:650}
  h2{font-size:1.35rem;margin:2.4rem 0 .7rem;font-weight:650}
  h3{font-size:1.05rem;margin:1.6rem 0 .4rem}
  .lede{font-size:1.1rem;color:#3a352f}
  .stats{display:flex;flex-wrap:wrap;gap:1.6rem;background:var(--warm);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.3rem;margin:1.4rem 0}
  .stat b{display:block;font-size:1.7rem;line-height:1.2;font-weight:650}
  .stat span{font-size:.82rem;color:var(--muted)}
  table{border-collapse:collapse;width:100%;margin:.8rem 0;font-size:.94rem}
  th,td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
  a{color:var(--accent)}
  .links{display:flex;flex-wrap:wrap;gap:.45rem;margin:.6rem 0}
  .links a{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:.25rem .6rem;text-decoration:none;font-size:.9rem}
  .note{font-size:.85rem;color:var(--muted);margin-top:.4rem}
  footer{border-top:1px solid var(--line);margin-top:3rem;padding-top:1.2rem;font-size:.85rem;color:var(--muted)}
  .faq h3{margin-bottom:.2rem}
</style>
</head>
<body>
<header class="site"><a href="/">SkinDay</a></header>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

function devicePage(combo, all, origin, base) {
  const { device } = combo;
  const label = territoryLabel(combo.territoryRaw, combo.country);
  const n = combo.clinics.length;

  const rated = combo.clinics.filter(c => c.rating != null);
  const avg = rated.length
    ? (rated.reduce((s, c) => s + Number(c.rating), 0) / rated.length).toFixed(2)
    : null;

  const byArea = new Map();
  for (const c of combo.clinics) {
    const a = c.area || 'Other';
    byArea.set(a, (byArea.get(a) || 0) + 1);
  }
  const areas = [...byArea.entries()].sort((a, b) => b[1] - a[1]);

  const listed = combo.clinics
    .slice()
    .sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0))
    .slice(0, MAX_CLINICS_LISTED);

  // INTERNAL LINKS. The guide pages rank partly because they link to each other
  // and back into the directory; a landing page with no outbound links is a
  // dead end and reads as doorway content.
  const sameDevice = all
    .filter(c => c.device.id === device.id && c.territorySlug !== combo.territorySlug)
    .sort((a, b) => b.clinics.length - a.clinics.length).slice(0, 12);
  const sameTerritory = all
    .filter(c => c.territorySlug === combo.territorySlug && c.device.id !== device.id)
    .sort((a, b) => b.clinics.length - a.clinics.length).slice(0, 14);
  const sameMaker = all
    .filter(c => c.territorySlug === combo.territorySlug
              && c.device.id !== device.id
              && c.device.manufacturer === device.manufacturer)
    .sort((a, b) => b.clinics.length - a.clinics.length).slice(0, 8);

  // ⭐ Links are built from the MOUNT PATH, not a hard-coded one. skinday.ca
  // already serves /devices/ and /devices/{model} from render-devices.js, so
  // the province pages hang under that same namespace as
  // /devices/{model}/{province} rather than opening a second device URL family
  // that would compete with the first. skinday.com has no /devices, so it
  // mounts at /technology.
  const href = c => `${base}/${c.deviceSlug}/${c.territorySlug}`;
  const canonical = origin + href(combo);
  const title = `${device.model} in ${label} — ${n} Clinics | SkinDay`;
  const description = `${n} clinics in ${label} have a ${device.model}${device.manufacturer ? ' by ' + device.manufacturer : ''}. See where they are, how they are rated, and compare them side by side.`;

  const body = `
<h1>${esc(device.model)} in ${esc(label)}</h1>
<p class="lede">${num(n)} clinics in ${esc(label)} are recorded as having a ${esc(device.model)}${device.manufacturer ? `, made by ${esc(device.manufacturer)}` : ''}. Equipment is identified from clinics&rsquo; own published pages — not advertising, and not self-reported.</p>

<div class="stats">
  <div class="stat"><b>${num(n)}</b><span>clinics with this device</span></div>
  <div class="stat"><b>${num(areas.length)}</b><span>${combo.country === 'canada' ? 'cities' : 'areas'} covered</span></div>
  ${avg ? `<div class="stat"><b>${avg}</b><span>average Google rating</span></div>` : ''}
</div>

<h2>Where the ${esc(device.model)} is in ${esc(label)}</h2>
<table>
  <thead><tr><th>${combo.country === 'canada' ? 'City' : 'Area'}</th><th>Clinics</th></tr></thead>
  <tbody>
    ${areas.slice(0, 15).map(([a, c]) => `<tr><td>${esc(a)}</td><td>${num(c)}</td></tr>`).join('')}
  </tbody>
</table>

<h2>Clinics with a ${esc(device.model)}</h2>
<p class="note">Ordered by review count. ${n > MAX_CLINICS_LISTED ? `Showing the ${MAX_CLINICS_LISTED} most-reviewed of ${num(n)}.` : ''}</p>
<table>
  <thead><tr><th>Clinic</th><th>${combo.country === 'canada' ? 'City' : 'Area'}</th><th>Rating</th><th>Reviews</th></tr></thead>
  <tbody>
    ${listed.map(c => `<tr>
      <td>${c.slug ? `<a href="/clinic/${esc(c.slug)}">${esc(c.name)}</a>` : esc(c.name)}</td>
      <td>${esc(c.area || '')}</td>
      <td>${c.rating != null ? esc(c.rating) : '—'}</td>
      <td>${c.reviews != null ? num(c.reviews) : '—'}</td>
    </tr>`).join('')}
  </tbody>
</table>

${sameMaker.length ? `<h2>Other ${esc(device.manufacturer)} equipment in ${esc(label)}</h2>
<div class="links">${sameMaker.map(c => `<a href="${href(c)}">${esc(c.device.model)} <span style="color:var(--muted)">${num(c.clinics.length)}</span></a>`).join('')}</div>` : ''}

${sameDevice.length ? `<h2>${esc(device.model)} elsewhere</h2>
<div class="links">${sameDevice.map(c => `<a href="${href(c)}">${esc(territoryLabel(c.territoryRaw, c.country))} <span style="color:var(--muted)">${num(c.clinics.length)}</span></a>`).join('')}</div>` : ''}

${sameTerritory.length ? `<h2>Other equipment in ${esc(label)}</h2>
<div class="links">${sameTerritory.map(c => `<a href="${href(c)}">${esc(c.device.model)} <span style="color:var(--muted)">${num(c.clinics.length)}</span></a>`).join('')}</div>` : ''}

<div class="faq">
<h2>Common questions</h2>
<h3>How does SkinDay know which clinics have a ${esc(device.model)}?</h3>
<p>Equipment is read from each clinic&rsquo;s own website — a treatment page, a technology page, or a service menu that names the machine. Nothing here is advertising, and clinics do not pay to appear. Where a clinic has confirmed its own equipment, that confirmation takes precedence.</p>
<h3>Does having the same device mean the same result?</h3>
<p>No. The machine is one factor among several. Operator experience, treatment settings, the number of sessions and how a plan is tailored to your skin all matter at least as much. The device tells you what a clinic can offer, not how well it will be delivered.</p>
<h3>Is this list complete?</h3>
<p>It is not, and it is worth being honest about that. Some clinic websites block automated reading, and some list equipment nowhere on the site. A clinic missing from this page may still have the device. If you spot something wrong, tell us and we will check it.</p>
</div>

<footer>
  <p>Equipment identified from clinics&rsquo; published pages. Confirm directly with the clinic before booking.</p>
  <p><a href="${base}/">All equipment pages</a></p>
</footer>`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${device.model} clinics in ${label}`,
    numberOfItems: n,
    itemListElement: listed.slice(0, 25).map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'MedicalBusiness',
        name: c.name,
        ...(c.slug ? { url: origin + '/clinic/' + c.slug } : {}),
        ...(c.area ? { address: { '@type': 'PostalAddress', addressLocality: c.area, addressRegion: label } } : {})
      }
    }))
  };

  return shell({ title, description, canonical, body, jsonld });
}

function indexPage(all, origin, base) {
  const byCountry = { canada: [], usa: [] };
  for (const c of all) (byCountry[c.country] || []).push(c);
  const section = (country, heading) => {
    const rows = byCountry[country].slice().sort((a, b) =>
      a.device.model.localeCompare(b.device.model) ||
      b.clinics.length - a.clinics.length);
    if (!rows.length) return '';
    return `<h2>${heading}</h2>
<div class="links">${rows.map(c =>
  `<a href="${base}/${c.deviceSlug}/${c.territorySlug}">${esc(c.device.model)} — ${esc(territoryLabel(c.territoryRaw, c.country))} <span style="color:var(--muted)">${num(c.clinics.length)}</span></a>`
).join('')}</div>`;
  };
  return shell({
    title: 'Aesthetic equipment by device and region | SkinDay',
    description: 'Find which clinics have a specific aesthetic device, by province and metro area, identified from clinics\u2019 own published pages.',
    canonical: origin + base + '/',
    body: `<h1>Equipment by device and region</h1>
<p class="lede">Which clinics have a specific machine, by region. Identified from clinics&rsquo; own published pages. Only combinations with at least ${MIN_CLINICS} clinics are listed.</p>
${section('canada', 'Canada &mdash; by province')}
${section('usa', 'United States &mdash; by metro area')}
<footer><p>Equipment identified from clinics&rsquo; published pages. Confirm directly with the clinic before booking.</p></footer>`
  });
}

function sitemap(all, origin, base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${origin}${base}/</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>
${all.map(c => `<url><loc>${origin}${base}/${c.deviceSlug}/${c.territorySlug}</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`).join('\n')}
</urlset>`;
}

// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const proto = (event.headers['x-forwarded-proto'] || 'https');
  const host = event.headers.host || 'skinday.com';
  const origin = proto + '://' + host;

  const path = (event.path || '').replace(/^\/+|\/+$/g, '');   // technology/x/y OR devices/x/y
  const parts = path.split('/').filter(Boolean);
  const base = '/' + (parts[0] || 'technology');

  try {
    const all = await loadCombos(supabase, countryForHost(host));

    if (parts.length >= 2 && parts[1] === 'sitemap.xml') {
      return { statusCode: 200, headers: { 'content-type': 'application/xml', 'cache-control': CACHE }, body: sitemap(all, origin, base) };
    }
    if (parts.length <= 1) {
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': CACHE }, body: indexPage(all, origin, base) };
    }

    const deviceSlug = parts[1];
    const territorySlug = parts[2];
    const combo = all.find(c => c.deviceSlug === deviceSlug && c.territorySlug === territorySlug);

    // ⚠️ A THIN COMBINATION MUST 404, NOT RENDER. Below MIN_CLINICS the page has
    // nothing to say, and a soft-404 that returns 200 with an empty table is how
    // a domain earns a sitewide quality problem.
    if (!combo) {
      return {
        statusCode: 404,
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
        body: shell({
          title: 'Not found | SkinDay',
          description: 'No page for that combination.',
          canonical: origin + base + '/',
          body: `<h1>No page here</h1><p class="lede">We only publish a page where at least ${MIN_CLINICS} clinics in a region are recorded as having the device.</p><p><a href="${base}/">See what is published</a></p>`
        })
      };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': CACHE },
      body: devicePage(combo, all, origin, base)
    };
  } catch (e) {
    console.error('device-page:', e);
    return { statusCode: 500, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
             body: shell({ title: 'Error | SkinDay', description: '', canonical: origin + base + '/',
                           body: '<h1>Something went wrong</h1><p>Please try again shortly.</p>' }) };
  }
};

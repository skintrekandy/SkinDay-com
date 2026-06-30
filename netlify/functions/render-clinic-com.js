// render-clinic-com.js
// Fully server-rendered clinic profile pages for skinday.com.
// Handles Taiwan (country='taiwan') and Hong Kong (country='hongkong').
// No client-side fetch needed -- all data baked into the HTML at render time.
// Deploy to: netlify/functions/render-clinic-com.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://skinday.com';

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
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function countryLabel(country, lang) {
  if (country === 'taiwan') return lang === 'zh' ? '\u53F0\u7063' : 'Taiwan';
  if (country === 'hongkong') return lang === 'zh' ? '\u9999\u6E2F' : 'Hong Kong';
  if (country === 'usa') return 'United States';
  return '';
}

function primaryLang(country) {
  return (country === 'taiwan' || country === 'hongkong') ? 'zh' : 'en';
}

function dirPath(country) {
  if (country === 'taiwan') return '/taiwan';
  if (country === 'hongkong') return '/hongkong';
  if (country === 'usa') return '/us';
  return '/';
}

function starsHtml(rating) {
  if (!rating) return '';
  const r = parseFloat(rating);
  const full = Math.floor(r);
  const half = r - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '<span style="color:#E8A030;">' +
    '\u2605'.repeat(full) +
    (half ? '\u00BD' : '') +
    '<span style="color:#D4C8BA;">' + '\u2605'.repeat(empty) + '</span>' +
    '</span>';
}

function clinicIsIndexable(clinic) {
  return !!(clinic && clinic.name && clinic.neighbourhood);
}

function buildSchema(clinic, url) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    name: clinic.name,
    url,
    ...(clinic.phone && { telephone: clinic.phone }),
    ...(clinic.website && { sameAs: clinic.website }),
    address: {
      '@type': 'PostalAddress',
      addressLocality: clinic.neighbourhood || '',
      addressCountry: clinic.country === 'taiwan' ? 'TW' : (clinic.country === 'usa' ? 'US' : 'HK')
    },
    ...(clinic.rating && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: clinic.rating,
        reviewCount: clinic.reviews || 1,
        bestRating: 5
      }
    }),
    ...(clinic.photos && clinic.photos.length > 0 && { image: clinic.photos[0] })
  };
  return JSON.stringify(schema).replace(/</g, '\\u003c');
}

function renderFullPage(clinic) {
  const lang = primaryLang(clinic.country);
  const slug = toSlug(clinic.name);
  const url = `${SITE}/clinic/${slug}`;
  const loc = escapeHtml(clinic.neighbourhood || '');
  const country = countryLabel(clinic.country, lang);
  const countryEsc = escapeHtml(country);
  const name = escapeHtml(clinic.name || '');
  const dirUrl = dirPath(clinic.country);
  const photos = Array.isArray(clinic.photos) ? clinic.photos : [];
  const photo = photos.length > 0 ? photos[0] : null;

  // Title + description
  const title = lang === 'zh'
    ? `${name} - ${loc}\u91AB\u7F8E\u8A3A\u6240 | SkinDay`
    : `${name} - ${loc} Aesthetic Clinic | SkinDay`;
  const description = lang === 'zh'
    ? `${name}\uFF0C\u4F4D\u65BC${countryEsc}${loc}\u7684\u91AB\u7F8E\u8A3A\u6240\u3002\u5728 SkinDay \u67E5\u770B\u8A3A\u6240\u8CC7\u8A0A\u3001\u670D\u52D9\u9805\u76EE\u8207\u806F\u7D61\u65B9\u5F0F\u3002`
    : `${name} is an aesthetic clinic in ${loc}, ${countryEsc}. View services, photos and contact details on SkinDay.`;

  // Breadcrumb labels
  const homeLbl = lang === 'zh' ? '\u9996\u9801' : 'Home';
  let dirLbl;
  if (clinic.country === 'usa') dirLbl = 'US Directory';
  else if (clinic.country === 'hongkong') dirLbl = lang === 'zh' ? '\u9999\u6E2F\u76EE\u9304' : 'Hong Kong Directory';
  else dirLbl = lang === 'zh' ? '\u53F0\u7063\u76EE\u9304' : 'Taiwan Directory';
  const backLbl = lang === 'zh' ? '\u8FD4\u56DE\u76EE\u9304' : 'Back to directory';

  // Rating block
  let ratingHtml = '';
  if (clinic.rating) {
    const reviews = clinic.reviews ? clinic.reviews.toLocaleString() : '0';
    const reviewLabel = lang === 'zh' ? `\u5247\u8A55\u8AD6` : 'reviews';
    ratingHtml = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
      ${starsHtml(clinic.rating)}
      <strong style="font-size:15px;color:#2C2724;">${escapeHtml(String(clinic.rating))}</strong>
      <span style="font-size:13px;color:#7A6E68;">(${escapeHtml(reviews)} ${reviewLabel})</span>
    </div>`;
  }

  // Hero photo
  const heroHtml = photo
    ? `<img src="${escapeHtml(photo)}" alt="${name}" style="width:100%;height:260px;object-fit:cover;display:block;background:#E8E0D6;" loading="eager" />`
    : `<div style="width:100%;height:180px;background:linear-gradient(135deg,#E8E0D6 0%,#D4C8BA 100%);display:flex;align-items:center;justify-content:center;">
        <svg width="48" height="48" fill="none" stroke="#bbb" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </div>`;

  // Country pill color
  const pillColor = clinic.country === 'hongkong' ? '#2F7D6B' : '#C8725A';
  const pillBg = clinic.country === 'hongkong' ? 'rgba(47,125,107,0.1)' : 'rgba(200,114,90,0.1)';

  // Info rows
  const infoRows = [];
  if (clinic.phone) {
    const phoneLabel = lang === 'zh' ? '\u96FB\u8A71' : 'Phone';
    infoRows.push(`<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #E8E0D6;">
      <span style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#7A6E68;width:80px;flex-shrink:0;">${phoneLabel}</span>
      <a href="tel:${escapeHtml(clinic.phone)}" style="font-size:14px;color:#C8725A;text-decoration:none;">${escapeHtml(clinic.phone)}</a>
    </div>`);
  }
  if (clinic.website) {
    const siteLabel = lang === 'zh' ? '\u5B98\u7DB2' : 'Website';
    const domain = clinic.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
    infoRows.push(`<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #E8E0D6;">
      <span style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#7A6E68;width:80px;flex-shrink:0;">${siteLabel}</span>
      <a href="${escapeHtml(clinic.website)}" target="_blank" rel="nofollow noopener" style="font-size:14px;color:#C8725A;text-decoration:none;word-break:break-all;">${escapeHtml(domain)}</a>
    </div>`);
  }
  if (loc) {
    const locLabel = lang === 'zh' ? '\u5730\u5340' : 'Location';
    infoRows.push(`<div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #E8E0D6;">
      <span style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#7A6E68;width:80px;flex-shrink:0;">${locLabel}</span>
      <span style="font-size:14px;color:#2C2724;">${loc}, ${countryEsc}</span>
    </div>`);
  }

  // Action buttons
  const websiteBtn = clinic.website
    ? `<a href="${escapeHtml(clinic.website)}" target="_blank" rel="nofollow noopener" style="display:inline-flex;align-items:center;gap:7px;padding:11px 22px;border-radius:8px;background:#1C1714;color:#FAF7F2;font-size:14px;font-weight:500;text-decoration:none;font-family:'DM Sans',sans-serif;">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        ${lang === 'zh' ? '\u524D\u5F80\u5B98\u7DB2' : 'Visit Website'}
      </a>`
    : '';
  const mapsUrl = clinic.place_id
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clinic.name)}&query_place_id=${clinic.place_id}`
    : `https://maps.google.com/?q=${encodeURIComponent((clinic.name || '') + ' ' + (clinic.neighbourhood || ''))}`;
  const mapsBtn = `<a href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:7px;padding:11px 22px;border-radius:8px;background:transparent;border:1.5px solid #E8E0D6;color:#2C2724;font-size:14px;font-weight:500;text-decoration:none;font-family:'DM Sans',sans-serif;">
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
    ${lang === 'zh' ? '\u67E5\u770B\u5730\u5716' : 'View on Map'}
  </a>`;

  // Additional photos grid
  let photosHtml = '';
  if (photos.length > 1) {
    const photoHeading = lang === 'zh' ? '\u8A3A\u6240\u7167\u7247' : 'Clinic Photos';
    const gridItems = photos.slice(1, 7).map(p =>
      `<img src="${escapeHtml(p)}" alt="${name}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#E8E0D6;" />`
    ).join('');
    photosHtml = `
    <div style="margin-top:32px;">
      <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:1.2rem;color:#1C1714;margin-bottom:14px;">${photoHeading}</h2>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">${gridItems}</div>
    </div>`;
  }

  // SEO hidden block for Googlebot
  const seoBlock = `<div id="ssr-content" aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;">
    <h1>${name}</h1>
    <p>${name} ${lang === 'zh' ? '\u662F\u4F4D\u65BC' + countryEsc + loc + '\u7684\u91AB\u7F8E\u8A3A\u6240\u3002' : 'is an aesthetic clinic in ' + loc + ', ' + countryEsc + '.'}</p>
    ${clinic.rating ? `<p>${lang === 'zh' ? 'Google\u8A55\u5206' : 'Google rating'}: ${escapeHtml(String(clinic.rating))}</p>` : ''}
    ${clinic.phone ? `<p>${lang === 'zh' ? '\u96FB\u8A71' : 'Phone'}: ${escapeHtml(clinic.phone)}</p>` : ''}
  </div>`;

  const indexableMeta = clinicIsIndexable(clinic)
    ? `<script type="application/ld+json">${buildSchema(clinic, url)}</script>`
    : `<meta name="robots" content="noindex, follow" />`;

  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${url}" />
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="SkinDay" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${escapeHtml(photo || SITE + '/og-default.jpg')}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(photo || SITE + '/og-default.jpg')}" />
  <link rel="icon" href="/favicon.ico" />
  ${indexableMeta}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#FAF7F2;color:#2C2724;font-family:'DM Sans',system-ui,sans-serif;font-size:15px;line-height:1.6;}
    .nav{background:#1C1714;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;}
    .nav-logo{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.4rem;color:#FAF7F2;text-decoration:none;letter-spacing:.02em;}
    .nav-logo span{color:#C9A96E;}
    .nav-back{font-size:13px;color:#7A6E68;text-decoration:none;display:flex;align-items:center;gap:6px;}
    .nav-back:hover{color:#FAF7F2;}
    .wrap{max-width:760px;margin:0 auto;padding:32px 24px 80px;}
    .breadcrumb{font-size:12px;color:#7A6E68;margin-bottom:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .breadcrumb a{color:#7A6E68;text-decoration:none;}
    .breadcrumb a:hover{color:#C8725A;}
    .action-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;}
    @media(max-width:500px){.photos-grid{grid-template-columns:repeat(2,1fr)!important;}}
  </style>
</head>
<body>
${seoBlock}
<nav class="nav">
  <a href="/" class="nav-logo">Skin<span>Day</span></a>
  <a href="${dirUrl}" class="nav-back">
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
    ${escapeHtml(backLbl)}
  </a>
</nav>

${heroHtml}

<div class="wrap">
  <div class="breadcrumb">
    <a href="/">${escapeHtml(homeLbl)}</a>
    <span>/</span>
    <a href="${dirUrl}">${escapeHtml(dirLbl)}</a>
    <span>/</span>
    <span>${name}</span>
  </div>

  <span style="display:inline-flex;align-items:center;font-size:11px;font-weight:500;letter-spacing:.04em;padding:3px 10px;border-radius:99px;text-transform:uppercase;background:${pillBg};color:${pillColor};margin-bottom:10px;">${countryEsc}</span>

  <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:2rem;font-weight:600;line-height:1.2;color:#1C1714;margin-bottom:8px;">${name}</h1>

  <div style="font-size:14px;color:#7A6E68;margin-bottom:16px;display:flex;align-items:center;gap:6px;">
    <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
    ${loc}, ${countryEsc}
  </div>

  ${ratingHtml}

  <hr style="border:none;border-top:1px solid #E8E0D6;margin:20px 0;" />

  ${infoRows.join('')}

  <div class="action-row" style="margin-top:24px;">
    ${websiteBtn}
    ${mapsBtn}
  </div>

  ${photosHtml}

  <div style="margin-top:40px;padding-top:24px;border-top:1px solid #E8E0D6;">
    <a href="${dirUrl}" style="font-size:14px;color:#C8725A;text-decoration:none;display:inline-flex;align-items:center;gap:6px;">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
      ${escapeHtml(backLbl)}
    </a>
  </div>
</div>
</body>
</html>`;
}

exports.handler = async (event) => {
  try {
    let slug = (event.queryStringParameters || {}).slug;
    if (!slug && event.path) {
      const parts = event.path.split('/').filter(Boolean);
      slug = parts[parts.length - 1];
      if (slug === 'render-clinic-com' || slug === 'clinic') slug = null;
    }

    if (!slug) {
      return { statusCode: 400, body: 'Missing slug' };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, neighbourhood, country, phone, website, rating, reviews, photos, place_id, maps_url')
      .in('country', ['taiwan', 'hongkong', 'usa'])
      .not('name', 'is', null);

    if (error) {
      console.error('render-clinic-com: supabase error', error.message);
      return { statusCode: 500, body: 'Database error' };
    }

    const clinic = (clinics || []).find(c => toSlug(c.name) === slug);

    if (!clinic) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html><html><head><title>Clinic Not Found | SkinDay</title><meta name="robots" content="noindex" /></head><body style="font-family:sans-serif;padding:40px;"><h2>Clinic not found</h2><p><a href="/">Back to SkinDay</a></p></body></html>`
      };
    }

    if (clinic.photos && typeof clinic.photos === 'string') {
      try { clinic.photos = JSON.parse(clinic.photos); } catch(e) { clinic.photos = []; }
    }

    const html = renderFullPage(clinic);
    const indexable = clinicIsIndexable(clinic);
    console.log(`render-clinic-com slug=${slug} country=${clinic.country} indexable=${indexable}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
      },
      body: html
    };

  } catch (err) {
    console.error('render-clinic-com: unhandled error', err.message);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

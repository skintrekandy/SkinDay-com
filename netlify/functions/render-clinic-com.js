// render-clinic-com.js
// SSR function for skinday.com clinic profile pages.
// Handles Taiwan (country='taiwan') and Hong Kong (country='hongkong').
// Mirrors the render-clinic.js pattern from skinday.ca.
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
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Country display helpers
function countryLabel(country, lang) {
  if (country === 'taiwan') return lang === 'zh' ? '台灣' : 'Taiwan';
  if (country === 'hongkong') return lang === 'zh' ? '香港' : 'Hong Kong';
  return '';
}

function currencySymbol(country) {
  if (country === 'hongkong') return 'HK$';
  return 'NT$';
}

// Derive display language from clinic country
// Taiwan pages: Traditional Chinese primary
// HK pages: Cantonese Traditional Chinese primary
function primaryLang(country) {
  return (country === 'taiwan' || country === 'hongkong') ? 'zh' : 'en';
}

function clinicIsIndexable(clinic) {
  if (!clinic) return false;
  if (!clinic.name) return false;
  if (!clinic.neighbourhood && !clinic.district) return false;
  return true;
}

function buildTitle(clinic) {
  const lang = primaryLang(clinic.country);
  const loc = escapeHtml(clinic.neighbourhood || clinic.district || '');
  const country = countryLabel(clinic.country, lang);
  const name = escapeHtml(clinic.name || '');
  if (lang === 'zh') {
    return `${name} - ${loc}醫美診所 | SkinDay`;
  }
  return `${name} - ${loc} Aesthetic Clinic | SkinDay`;
}

function buildDescription(clinic) {
  const lang = primaryLang(clinic.country);
  const name = escapeHtml(clinic.name || '');
  const loc = escapeHtml(clinic.neighbourhood || clinic.district || '');
  const country = countryLabel(clinic.country, lang);
  const rating = clinic.rating ? `${clinic.rating}` : null;
  const reviews = clinic.reviews || 0;

  if (lang === 'zh') {
    let desc = `${name}，位於${country}${loc}的醫美診所。`;
    if (rating) desc += `Google評分 ${rating} 分（${reviews} 則評論）。`;
    desc += `在 SkinDay 查看診所資訊、服務項目與聯絡方式。`;
    return desc;
  }
  let desc = `${name} is an aesthetic clinic in ${loc}, ${country}.`;
  if (rating) desc += ` Rated ${rating} stars from ${reviews} Google reviews.`;
  desc += ` View services, photos and contact details on SkinDay.`;
  return desc;
}

function buildSchema(clinic) {
  const slug = toSlug(clinic.name);
  const url = `${SITE}/clinic/${slug}`;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    name: clinic.name,
    url,
    ...(clinic.phone && { telephone: clinic.phone }),
    ...(clinic.website && { sameAs: clinic.website }),
    address: {
      '@type': 'PostalAddress',
      addressLocality: clinic.neighbourhood || clinic.district || '',
      addressCountry: clinic.country === 'taiwan' ? 'TW' : 'HK'
    },
    ...(clinic.latitude && clinic.longitude && {
      geo: {
        '@type': 'GeoCoordinates',
        latitude: clinic.latitude,
        longitude: clinic.longitude
      }
    }),
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

function buildSeoBody(clinic) {
  const lang = primaryLang(clinic.country);
  const name = escapeHtml(clinic.name || '');
  const loc = escapeHtml(clinic.neighbourhood || clinic.district || '');
  const country = countryLabel(clinic.country, lang);
  const rating = clinic.rating ? escapeHtml(String(clinic.rating)) : null;
  const reviews = clinic.reviews || 0;
  const photo = clinic.photos && clinic.photos.length > 0 ? clinic.photos[0] : null;

  const lines = [];

  if (lang === 'zh') {
    lines.push(`<h1>${name}</h1>`);
    lines.push(`<p>${name}是位於${country}${loc}的醫美診所。</p>`);
    if (rating) lines.push(`<p>Google評分：${rating}星（${reviews}則評論）。</p>`);
    if (clinic.phone) lines.push(`<p>電話：${escapeHtml(clinic.phone)}</p>`);
    if (clinic.website) lines.push(`<p>官網：<a href="${escapeHtml(clinic.website)}" rel="nofollow">${escapeHtml(clinic.website)}</a></p>`);
    lines.push(`<p>在 SkinDay 查看${name}的完整資訊、服務項目與周邊診所比較。</p>`);
  } else {
    lines.push(`<h1>${name}</h1>`);
    lines.push(`<p>${name} is an aesthetic clinic located in ${loc}, ${country}.</p>`);
    if (rating) lines.push(`<p>Google rating: ${rating} stars (${reviews} reviews).</p>`);
    if (clinic.phone) lines.push(`<p>Phone: ${escapeHtml(clinic.phone)}</p>`);
    if (clinic.website) lines.push(`<p>Website: <a href="${escapeHtml(clinic.website)}" rel="nofollow">${escapeHtml(clinic.website)}</a></p>`);
    lines.push(`<p>Compare ${name} with other clinics in ${loc} on SkinDay.</p>`);
  }

  const imgTag = photo
    ? `<img src="${escapeHtml(photo)}" alt="${name}" width="400" height="300" loading="lazy" style="max-width:100%;height:auto;" />`
    : '';

  return `<div id="ssr-content" aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;">${imgTag}${lines.join('')}</div>`;
}

function injectIntoShell(shell, clinic) {
  const slug = toSlug(clinic.name);
  const url = `${SITE}/clinic/${slug}`;
  const title = buildTitle(clinic);
  const description = buildDescription(clinic);
  const photo = clinic.photos && clinic.photos.length > 0 ? clinic.photos[0] : `${SITE}/og-default.jpg`;
  const lang = primaryLang(clinic.country);

  let out = shell;

  // Title
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

  // Lang attribute
  out = out.replace(/<html([^>]*)>/, `<html$1 lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">`);

  // Canonical
  out = out.replace(
    /<link[^>]*id="meta-canonical"[^>]*>/,
    `<link rel="canonical" href="${url}" id="meta-canonical" />`
  );

  // Meta description
  out = out.replace(
    /<meta[^>]*id="meta-description"[^>]*>/,
    `<meta name="description" content="${escapeHtml(description)}" id="meta-description" />`
  );

  // OG tags
  out = out.replace(/<meta[^>]*id="og-title"[^>]*>/, `<meta property="og:title" content="${escapeHtml(title)}" id="og-title" />`);
  out = out.replace(/<meta[^>]*id="og-description"[^>]*>/, `<meta property="og:description" content="${escapeHtml(description)}" id="og-description" />`);
  out = out.replace(/<meta[^>]*id="og-url"[^>]*>/, `<meta property="og:url" content="${url}" id="og-url" />`);
  out = out.replace(/<meta[^>]*id="og-image"[^>]*>/, `<meta property="og:image" content="${escapeHtml(photo)}" id="og-image" />`);

  // Twitter tags
  out = out.replace(/<meta[^>]*id="tw-title"[^>]*>/, `<meta name="twitter:title" content="${escapeHtml(title)}" id="tw-title" />`);
  out = out.replace(/<meta[^>]*id="tw-description"[^>]*>/, `<meta name="twitter:description" content="${escapeHtml(description)}" id="tw-description" />`);
  out = out.replace(/<meta[^>]*id="tw-image"[^>]*>/, `<meta name="twitter:image" content="${escapeHtml(photo)}" id="tw-image" />`);

  // SEO body block
  const seoBody = buildSeoBody(clinic);
  out = out.replace(/(<body[^>]*>)/, `$1\n${seoBody}\n`);

  // Indexability gate
  if (!clinicIsIndexable(clinic)) {
    out = out.replace('</head>', '  <meta name="robots" content="noindex, follow" />\n</head>');
  } else {
    out = out.replace('</head>', `  <script type="application/ld+json">${buildSchema(clinic)}</script>\n</head>`);
  }

  return out;
}

exports.handler = async (event) => {
  try {
    // Extract slug from path: /clinic/my-clinic-name -> my-clinic-name
    let slug = (event.queryStringParameters || {}).slug;
    if (!slug && event.path) {
      const parts = event.path.split('/').filter(Boolean);
      slug = parts[parts.length - 1];
      if (slug === 'render-clinic-com' || slug === 'clinic') slug = null;
    }

    if (!slug) {
      console.error('render-clinic-com: missing slug', event.path);
      return { statusCode: 400, body: 'Missing slug' };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Fetch all TW + HK clinics, match by slug
    // We match against toSlug(name) since we don't store slug column
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, neighbourhood, district, country, phone, website, rating, reviews, latitude, longitude, photos')
      .in('country', ['taiwan', 'hongkong'])
      .not('name', 'is', null);

    if (error) {
      console.error('render-clinic-com: supabase error', error.message);
      return { statusCode: 500, body: 'Database error' };
    }

    const clinic = (clinics || []).find(c => toSlug(c.name) === slug);

    if (!clinic) {
      console.log(`render-clinic-com: no clinic found for slug="${slug}"`);
      // Serve the shell with noindex so Google doesn't index a blank page
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html><html><head><title>Clinic Not Found | SkinDay</title><meta name="robots" content="noindex" /></head><body><p>Clinic not found.</p></body></html>`
      };
    }

    // Parse photos if stored as JSON string
    if (clinic.photos && typeof clinic.photos === 'string') {
      try { clinic.photos = JSON.parse(clinic.photos); } catch(e) { clinic.photos = []; }
    }

    // Build SSR HTML from shell template embedded below
    const shell = getShell();
    const rendered = injectIntoShell(shell, clinic);

    const indexable = clinicIsIndexable(clinic);
    console.log(`render-clinic-com slug=${slug} country=${clinic.country} indexable=${indexable}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
      },
      body: rendered
    };

  } catch (err) {
    console.error('render-clinic-com: unhandled error', err.message);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

// Minimal HTML shell. Client-side JS in clinic-com.html hydrates on top of this.
// The SSR content is visually hidden; it exists only for Googlebot.
function getShell() {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aesthetic Clinic | SkinDay</title>
  <link rel="canonical" href="https://skinday.com/clinic/" id="meta-canonical" />
  <meta name="description" content="" id="meta-description" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="SkinDay" />
  <meta property="og:title" content="" id="og-title" />
  <meta property="og:description" content="" id="og-description" />
  <meta property="og:url" content="" id="og-url" />
  <meta property="og:image" content="" id="og-image" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="" id="tw-title" />
  <meta name="twitter:description" content="" id="tw-description" />
  <meta name="twitter:image" content="" id="tw-image" />
  <link rel="icon" href="/favicon.ico" />
  <link rel="stylesheet" href="/clinic-com.css" />
</head>
<body>
  <div id="clinic-root">Loading...</div>
  <script src="/clinic-com.js" defer></script>
</body>
</html>`;
}

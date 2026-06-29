// sitemap-com.js
// Dynamic sitemap for skinday.com.
// Outputs all Taiwan + HK clinic profile URLs plus static pages.
// Deploy to: netlify/functions/sitemap-com.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://skinday.com';

function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function urlEntry(loc, priority, lastmod) {
  return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
}

exports.handler = async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const today = new Date().toISOString().split('T')[0];

    // Fetch all indexable TW + HK clinics
    const { data: clinics, error } = await supabase
      .from('clinics')
      .select('id, name, country, neighbourhood, rating, reviews, updated_at')
      .in('country', ['taiwan', 'hongkong'])
      .not('name', 'is', null)
      .not('neighbourhood', 'is', null);

    if (error) {
      console.error('sitemap-com: supabase error', error.message);
      return { statusCode: 500, body: 'Database error' };
    }

    const entries = [];

    // Static pages
    const staticPages = [
      { path: '/',           priority: '1.0' },
      { path: '/visualize',  priority: '0.9' },
      { path: '/guide',      priority: '0.8' },
      { path: '/taiwan',     priority: '0.9' },
      { path: '/hongkong',   priority: '0.9' },
      { path: '/studio',     priority: '0.7' },
      { path: '/contact',    priority: '0.5' },
      { path: '/terms',      priority: '0.3' },
      { path: '/privacy',    priority: '0.3' },
      { path: '/refund',     priority: '0.3' },
    ];

    for (const page of staticPages) {
      entries.push(urlEntry(`${SITE}${page.path}`, page.priority, today));
    }

    // Clinic profile pages
    let twCount = 0;
    let hkCount = 0;

    for (const clinic of clinics || []) {
      const slug = toSlug(clinic.name);
      if (!slug) continue;

      // Skip clinics with no meaningful data
      if (!clinic.neighbourhood && !clinic.district) continue;

      const lastmod = clinic.updated_at
        ? clinic.updated_at.split('T')[0]
        : today;

      // Clinics with reviews get slightly higher priority
      const priority = (clinic.reviews && clinic.reviews > 10) ? '0.7' : '0.6';

      entries.push(urlEntry(`${SITE}/clinic/${slug}`, priority, lastmod));

      if (clinic.country === 'taiwan') twCount++;
      if (clinic.country === 'hongkong') hkCount++;
    }

    console.log(`sitemap-com: ${staticPages.length} static + ${twCount} TW + ${hkCount} HK = ${entries.length} total URLs`);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
      },
      body: xml
    };

  } catch (err) {
    console.error('sitemap-com: unhandled error', err.message);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

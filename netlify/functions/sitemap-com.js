// sitemap-com.js
// Dynamic sitemap for skinday.com.
// Outputs all Taiwan + Hong Kong + US clinic profile URLs plus static pages.
// Deploy to: netlify/functions/sitemap-com.js

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE = 'https://skinday.com';

function toSlug(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── DEVICE x METRO LANDING PAGES ─────────────────────────────────────────────
// Mirrors device-page.js exactly: same MIN_CLINICS floor, same grain (metro for
// the US), same exclusion of name_is_also_generic devices. If these two ever
// disagree the sitemap advertises URLs the function 404s, which is worse than
// omitting them — so the constants live here as a deliberate copy with this
// note, not as a guess.
const DEVICE_MIN_CLINICS = 10;

function devSlug(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function fetchDevicePages(supabase) {
  const { data: devices, error: dErr } = await supabase
    .from('device_reference')
    .select('id, model')
    .eq('active', true)
    .eq('name_is_also_generic', false);
  if (dErr) return { error: dErr };
  const modelById = new Map((devices || []).map(d => [d.id, d.model]));

  const PAGE = 1000;
  const pairs = new Map();          // deviceId|metroSlug -> Set(clinic ids)
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('clinic_devices')
      .select('clinic_id, device_id, clinics!inner(id, country, metro, approved)')
      .eq('status', 'listed')
      .eq('clinics.approved', true)
      .eq('clinics.country', 'usa')
      .range(from, from + PAGE - 1);
    if (error) return { error };
    if (!data || !data.length) break;
    for (const r of data) {
      const model = modelById.get(r.device_id);
      const metro = r.clinics && r.clinics.metro;
      if (!model || !metro) continue;
      const key = devSlug(model) + '|' + devSlug(metro);
      if (!pairs.has(key)) pairs.set(key, new Set());
      pairs.get(key).add(r.clinic_id);
    }
    if (data.length < PAGE) break;
  }

  const out = [];
  for (const [key, clinics] of pairs) {
    if (clinics.size < DEVICE_MIN_CLINICS) continue;   // thin pages 404, never list them
    const [device, metro] = key.split('|');
    out.push({ path: `/technology/${device}/${metro}`, clinics: clinics.size });
  }
  return { data: out };
}

function urlEntry(loc, priority, lastmod) {
  return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
}

// Fetch every approved TW+HK+US clinic in 1000-row batches. PostgREST caps
// each response at the project's Max rows setting, so a single large .range()
// silently truncates once the table grows past that cap. Batched, ordered
// paging stays correct no matter how large the table gets.
async function fetchAllClinics(supabase, columns) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('clinics')
      .select(columns)
      .in('country', ['taiwan', 'hongkong', 'usa'])
      .eq('approved', true)
      .not('name', 'is', null)
      .not('neighbourhood', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return { error };
    if (data && data.length) all.push(...data);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return { data: all };
}

exports.handler = async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const today = new Date().toISOString().split('T')[0];

    // Fetch all indexable TW + HK + US clinics (approved, with a name +
    // neighbourhood), batched so the Max rows cap can never truncate it.
    const { data: clinics, error } = await fetchAllClinics(
      supabase,
      'id, name, country, neighbourhood, reviews, updated_at'
    );

    if (error) {
      console.error('sitemap-com: supabase error', error.message);
      return { statusCode: 500, body: 'Database error' };
    }

    const entries = [];

    // Static + directory pages (final architecture, no dead nested metro URLs)
    const staticPages = [
      { path: '/',                 priority: '1.0' },
      { path: '/visualize',        priority: '0.9' },
      { path: '/visualize/cases',  priority: '0.8' },
      { path: '/guide',            priority: '0.8' },
      { path: '/directory',        priority: '0.8' },
      { path: '/taiwan',           priority: '0.9' },
      { path: '/hongkong',         priority: '0.9' },
      { path: '/us',               priority: '0.9' },
      { path: '/us/california',    priority: '0.9' },
      { path: '/us/new-york',      priority: '0.9' },
      { path: '/technology',       priority: '0.8' },
      { path: '/studio',           priority: '0.7' },
      { path: '/contact',          priority: '0.5' },
      { path: '/terms',            priority: '0.3' },
      { path: '/privacy',          priority: '0.3' },
      { path: '/refund',           priority: '0.3' },
    ];

    for (const page of staticPages) {
      entries.push(urlEntry(`${SITE}${page.path}`, page.priority, today));
    }

    // Clinic profile pages, deduped by slug (different clinics can produce the same slug)
    const seenSlugs = new Set();
    const counts = { taiwan: 0, hongkong: 0, usa: 0 };

    for (const clinic of clinics || []) {
      const slug = toSlug(clinic.name);
      if (!slug) continue;            // Chinese-only names produce empty slug, skip
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const lastmod = clinic.updated_at
        ? clinic.updated_at.split('T')[0]
        : today;

      // Clinics with more reviews get slightly higher priority
      const priority = (clinic.reviews && clinic.reviews > 10) ? '0.7' : '0.6';

      entries.push(urlEntry(`${SITE}/clinic/${slug}`, priority, lastmod));

      if (counts[clinic.country] !== undefined) counts[clinic.country]++;
    }

    // Device x metro pages. A failure here must NOT take down the sitemap —
    // the clinic URLs are the load-bearing half and were working long before
    // these pages existed.
    let deviceCount = 0;
    try {
      const { data: devicePages, error: devErr } = await fetchDevicePages(supabase);
      if (devErr) {
        console.error('sitemap-com: device pages skipped -', devErr.message);
      } else {
        for (const p of devicePages) {
          // A denser page is a better landing page, so it gets the higher
          // priority — same reasoning as the review-count rule above.
          entries.push(urlEntry(`${SITE}${p.path}`, p.clinics >= 30 ? '0.7' : '0.6', today));
          deviceCount++;
        }
      }
    } catch (e) {
      console.error('sitemap-com: device pages threw -', e.message);
    }

    console.log(`sitemap-com: ${staticPages.length} static + ${counts.taiwan} TW + ${counts.hongkong} HK + ${counts.usa} US + ${deviceCount} device x metro = ${entries.length} total URLs`);

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

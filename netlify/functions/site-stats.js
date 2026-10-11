// site-stats.js
// Live headline figures for the public About page (/about).
// Calls the public_site_stats() SQL function, which does all the counting
// inside Postgres, so the numbers are exact and never hit the row cap.
//
// Route: /api/site-stats (already covered by the /api/* redirect)
// Deploy to: netlify/functions/site-stats.js

const { createClient } = require('@supabase/supabase-js');

const HEADERS = {
  'Content-Type': 'application/json',
  // Browsers keep it 10 minutes, Netlify's edge keeps it 6 hours.
  'Cache-Control': 'public, max-age=600',
  'Netlify-CDN-Cache-Control': 'public, max-age=21600, stale-while-revalidate=86400',
};

exports.handler = async () => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data, error } = await supabase.rpc('public_site_stats');
    if (error) throw new Error(error.message);

    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const body = {
      clinics: n(data && data.clinics),
      relationships: n(data && data.relationships),
      technologies: n(data && data.technologies),
      posts: n(data && data.posts),
      markets: n(data && data.markets),
      updated_at: new Date().toISOString(),
    };
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(body) };
  } catch (e) {
    console.error('site-stats failed:', e.message);
    // 503 with no-store so a failure is never cached at the edge.
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'unavailable' }),
    };
  }
};

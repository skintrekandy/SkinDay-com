const { createClient } = require('@supabase/supabase-js');

// Fields returned for every clinic card
// Includes photo + logo (Google Maps CDN URLs stored at import time)
// Includes country + region for multi-country routing
// Includes lat + lng for Near Me distance calc on the frontend
const CARD_FIELDS = `
  id, name, neighbourhood, region, country,
  rating, reviews, place_id,
  phone, website,
  claimed, approved, promo, promo_text,
  price, price_source, price_date,
  lat, lng, photo, logo
`;

const PAGE_SIZE = 24;

exports.handler = async (event) => {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const params = event.queryStringParameters || {};

    // ── country param (required for all modes) ───────────────
    // Defaults to 'canada' so existing skinday.ca calls still work
    // if ever proxied through this function, but skinday.com pages
    // must always pass an explicit country.
    const country = (params.country || 'canada').toLowerCase().trim();

    // ── MODE: lightweight index ───────────────────────────────
    // Used by taiwan.html on load to build the clinicsIndex for
    // findClinic() lookups (compare, shortlist, modal). Returns
    // id, name, neighbourhood, region, photo, logo only — no price.
    if (params.mode === 'index') {
      const { data, error } = await supabase
        .from('clinics')
        .select('id, name, neighbourhood, region, photo, logo, lat, lng, rating, reviews')
        .eq('approved', true)
        .eq('country', country)
        .order('id', { ascending: true })
        .range(0, 29999);

      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=120',
        },
        body: JSON.stringify(data),
      };
    }

    // ── PARAMS ───────────────────────────────────────────────
    const page          = Math.max(0, parseInt(params.page || '0', 10));
    const sort          = params.sort || 'reviews';
    const neighbourhood = params.neighbourhood || '';
    const search        = (params.search || '').trim();
    const from          = page * PAGE_SIZE;
    const needed        = from + PAGE_SIZE;

    // ── BUILD BASE QUERY ─────────────────────────────────────
    // Always scoped to country. Neighbourhood slugs for Taiwan are
    // city-prefixed (e.g. taipei-daan, new-taipei-banqiao) and stored
    // verbatim in the neighbourhood column — use exact eq() match.
    // No fuzzy ilike needed: slugs are clean ASCII, no accent variants.
    const buildBase = () => {
      let q = supabase
        .from('clinics')
        .select(CARD_FIELDS, { count: 'exact' })
        .eq('approved', true)
        .eq('country', country);

      if (search)        q = q.ilike('name', `%${search}%`);
      if (neighbourhood) q = q.eq('neighbourhood', neighbourhood);

      return q;
    };

    // ── SORT ─────────────────────────────────────────────────
    const applySort = (q) => {
      if (sort === 'price-low')  return q.order('price',   { ascending: true,  nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'price-high') return q.order('price',   { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      if (sort === 'reviews')    return q.order('reviews', { ascending: false, nullsFirst: false }).order('id', { ascending: true });
      return                            q.order('rating',  { ascending: false, nullsFirst: false }).order('id', { ascending: true });
    };

    // ── RESOLVE PRICED CLINIC IDS FROM clinic_prices ─────────
    // Price data lives in clinic_prices; the clinics.price column is a
    // snapshot that can lag. Fetch priced ids so we can surface them
    // in the four-bucket sort regardless of snapshot freshness.
    // Scope to currency matching the country (NTD for taiwan, CAD for canada).
    const currency = country === 'taiwan' ? 'NTD' : 'CAD';

    const pricedIdsRes = await supabase
      .from('clinic_prices')
      .select('clinic_id')
      .eq('currency', currency)
      .range(0, 29999);

    if (pricedIdsRes.error) {
      console.error('Supabase error (priced ids):', pricedIdsRes.error);
      return { statusCode: 500, body: JSON.stringify({ error: pricedIdsRes.error.message }) };
    }
    const pricedIdSet  = new Set((pricedIdsRes.data || []).map(r => String(r.clinic_id)));
    const pricedIdList = [...pricedIdSet];
    const hasPricedIds = pricedIdList.length > 0;

    // ── FOUR-BUCKET FETCH ─────────────────────────────────────
    // Bucket 1: priced + claimed   (best signal)
    // Bucket 2: priced + unclaimed
    // Bucket 3: unpriced + claimed
    // Bucket 4: unpriced + unclaimed (largest pool, least signal)
    const unpricedNeeded = needed + pricedIdList.length;
    const emptyPriced    = { data: [], error: null };

    const [pricedClaimedRes, pricedUnclaimedRes, claimedAllRes, unclaimedAllRes, countRes] = await Promise.all([
      hasPricedIds ? applySort(buildBase().eq('claimed', true ).in('id', pricedIdList)).range(0, needed - 1)         : Promise.resolve(emptyPriced),
      hasPricedIds ? applySort(buildBase().eq('claimed', false).in('id', pricedIdList)).range(0, needed - 1)         : Promise.resolve(emptyPriced),
      applySort(buildBase().eq('claimed', true )).range(0, unpricedNeeded - 1),
      applySort(buildBase().eq('claimed', false)).range(0, unpricedNeeded - 1),
      buildBase().select('id', { count: 'exact', head: true }).range(0, 0),
    ]);

    const fetchErr = pricedClaimedRes.error || pricedUnclaimedRes.error || claimedAllRes.error || unclaimedAllRes.error;
    if (fetchErr) {
      console.error('Supabase fetch error:', fetchErr);
      return { statusCode: 500, body: JSON.stringify({ error: fetchErr.message }) };
    }

    const unpricedClaimed   = (claimedAllRes.data   || []).filter(c => !pricedIdSet.has(String(c.id)));
    const unpricedUnclaimed = (unclaimedAllRes.data || []).filter(c => !pricedIdSet.has(String(c.id)));

    const pool = [
      ...(pricedClaimedRes.data   || []),
      ...(pricedUnclaimedRes.data || []),
      ...unpricedClaimed,
      ...unpricedUnclaimed,
    ];

    const totalCount = countRes.count || 0;
    const pageSlice  = pool.slice(from, from + PAGE_SIZE);

    // ── FETCH clinic_prices FOR THIS PAGE ─────────────────────
    const clinicIds = pageSlice.map(c => String(c.id));
    let pricesMap = {};

    if (clinicIds.length > 0) {
      const pricesRes = await supabase
        .from('clinic_prices')
        .select('clinic_id, toxin, price, injector_type, price_source, price_date, currency')
        .in('clinic_id', clinicIds)
        .eq('currency', currency)
        .order('price', { ascending: true });

      if (pricesRes.data && pricesRes.data.length) {
        pricesRes.data.forEach(p => {
          if (!pricesMap[p.clinic_id]) pricesMap[p.clinic_id] = [];
          pricesMap[p.clinic_id].push(p);
        });
      }
    }

    // ── MERGE ─────────────────────────────────────────────────
    const keep = [
      'id', 'name', 'neighbourhood', 'region', 'country',
      'rating', 'reviews', 'place_id',
      'phone', 'website',
      'claimed', 'approved', 'promo', 'promo_text',
      'price', 'price_source', 'price_date',
      'lat', 'lng', 'photo', 'logo',
    ];

    const merged = pageSlice.map(clinic => {
      const out = {};
      keep.forEach(k => {
        const v = clinic[k];
        if (v === null || v === undefined || v === '') return;
        out[k] = v;
      });

      const clinicPrices = pricesMap[String(clinic.id)];
      if (clinicPrices && clinicPrices.length > 0) {
        const lowest     = [...clinicPrices].sort((a, b) => a.price - b.price)[0];
        out.price        = lowest.price;
        out.price_source = lowest.price_source;
        out.price_date   = lowest.price_date;
        out.toxin_type   = lowest.toxin;
        out.prices       = clinicPrices;
      } else {
        out.prices = [];
      }

      return out;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
        'Vary': 'Accept-Encoding',
      },
      body: JSON.stringify({
        clinics: merged,
        total: totalCount,
        page,
        pageSize: PAGE_SIZE,
        hasMore: (from + merged.length) < totalCount,
      }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

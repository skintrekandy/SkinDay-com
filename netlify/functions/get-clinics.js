const { createClient } = require('@supabase/supabase-js');

// Fields returned for every clinic card
// Includes photo + logo (Google Maps CDN URLs stored at import time)
// Includes country + region for multi-country routing
// Includes lat + lng for Near Me distance calc on the frontend
// Includes slug: profile links MUST use it, not a slugified name. Chain
// branches share a name (LaserAway x74) and only the slug separates them.
const CARD_FIELDS = `
  id, name, slug, neighbourhood, region, country, state, metro,
  rating, reviews, place_id,
  phone, website,
  claimed, approved, promo, promo_text,
  price, price_source, price_date,
  lat, lng, photo, logo
`;

const PAGE_SIZE = 24;

// ── DEVICES (M39, ported to the US for M19) ────────────────────────────────
// slugifyModel lives HERE and not in the browser so the client and the server
// cannot disagree about what "clear-brilliant" means.
function slugifyModel(m) {
  return String(m || '').toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The device_facets RPC returns categories as { category, clinics } with NO
// label and NO group. The M41 taxonomy — parent groups plus the group_order
// Andy set deliberately so lasers come first and resurfacing sits low — lives
// in device_categories. Enrich here rather than in the browser, so the client
// stays dumb and the two directories cannot drift apart.
let CATEGORY_META = null;
async function loadCategoryMeta(supabase) {
  if (CATEGORY_META) return CATEGORY_META;
  try {
    const { data, error } = await supabase
      .from('device_categories')
      .select('category, label_en, sort_order, group_key, group_label, group_order');
    if (error) throw new Error(error.message);
    CATEGORY_META = {};
    (data || []).forEach(r => { CATEGORY_META[r.category] = r; });
    return CATEGORY_META;
  } catch (e) {
    console.error('Category meta failed (non-fatal):', e.message);
    return {};
  }
}

// A device fetch NEVER throws. If it fails the directory renders exactly as it
// did before devices existed, rather than the whole page going down over a
// secondary feature.
async function fetchDevicesFor(supabase, clinicIds) {
  if (!clinicIds || !clinicIds.length) return {};
  try {
    const { data, error } = await supabase
      .from('clinic_devices')
      .select('clinic_id, status, device_reference!inner(id, model, manufacturer, category, active)')
      .in('clinic_id', clinicIds)
      .eq('device_reference.active', true);
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach(r => {
      const d = r.device_reference;
      if (!d) return;
      const k = String(r.clinic_id);
      (map[k] = map[k] || []).push({
        model: d.model,
        manufacturer: d.manufacturer,
        category: d.category,
        status: r.status,
        slug: slugifyModel(d.model)
      });
    });
    Object.keys(map).forEach(k => map[k].sort((a, b) => a.model.localeCompare(b.model)));
    return map;
  } catch (e) {
    console.error('Device fetch failed (non-fatal):', e.message);
    return {};
  }
}

// Resolve ?device= / ?devicecat= to the set of clinic ids that own it.
// Returns null when no device filter is active.
async function resolveDeviceClinicIds(supabase, deviceSlug, deviceCat) {
  if (!deviceSlug && !deviceCat) return null;
  try {
    let q = supabase
      .from('clinic_devices')
      .select('clinic_id, device_reference!inner(model, category, active)')
      .eq('device_reference.active', true)
      .range(0, 49999);
    if (deviceCat) q = q.eq('device_reference.category', deviceCat);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    let rows = data || [];
    if (deviceSlug) {
      rows = rows.filter(r => r.device_reference
        && slugifyModel(r.device_reference.model) === deviceSlug);
    }
    // An EMPTY set must stay empty, never null — otherwise "clinics with a
    // Morpheus8" silently returns every clinic in the state.
    return new Set(rows.map(r => String(r.clinic_id)));
  } catch (e) {
    console.error('Device filter failed (non-fatal):', e.message);
    return null;
  }
}

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
    // id, name, neighbourhood, region, photo, logo only, no price.
    // ── MODE: device facets ───────────────────────────────────────────────
    // Aggregated in Postgres by the device_facets RPC rather than pulling every
    // clinic_devices row into this function to count in JS — that shape hit
    // PostgREST's row cap and silently truncated the counts.
    if (params.mode === 'device-facets') {
      const [{ data, error }, meta] = await Promise.all([
        supabase.rpc('device_facets', {
          p_country: country,
          p_province: params.province || null
        }),
        loadCategoryMeta(supabase)
      ]);
      if (error) {
        console.error('device_facets failed:', error.message);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ models: [], categories: [], groups: [] })
        };
      }
      // Attach label / group / ordering to every category. A category with no
      // group (lesion_removal) is bucketed last rather than dropped, so 38
      // clinics do not vanish from a three-tier filter.
      const out = data || { models: [], categories: [], groups: [] };
      out.categories = (out.categories || []).map(c => {
        const m = (meta || {})[c.category] || {};
        return {
          category:    c.category,
          clinics:     c.clinics,
          label:       m.label_en || String(c.category || '').replace(/_/g, ' '),
          sort_order:  m.sort_order == null ? 999 : m.sort_order,
          group_key:   m.group_key   || '_other',
          group_label: m.group_label || 'Other',
          group_order: m.group_order == null ? 900 : m.group_order
        };
      });

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600',
        },
        body: JSON.stringify(out),
      };
    }

    if (params.mode === 'index') {
      const metroIdx = params.metro || '';
      const stateIdx = params.state || '';
      let idxQuery = supabase
        .from('clinics')
        .select('id, name, slug, neighbourhood, region, photo, logo, lat, lng, rating, reviews')
        .eq('approved', true)
        .eq('country', country);
      if (metroIdx) idxQuery = idxQuery.ilike('metro', metroIdx);
      if (stateIdx) idxQuery = idxQuery.ilike('state', stateIdx);
      const { data, error } = await idxQuery
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
    const metro         = params.metro || '';
    const stateFilter   = params.state || '';
    const search        = (params.search || '').trim();
    // M18: restrict to clinics a manufacturer directory lists for this device,
    // e.g. verified_device=鳳凰電波 Thermage FLX. Empty means no restriction.
    const verifiedDevice = (params.verified_device || '').trim();
    // M19: the patient-facing technology filter.
    const deviceSlug = (params.device || '').trim().toLowerCase();
    const deviceCat  = (params.devicecat || '').trim();
    const from          = page * PAGE_SIZE;
    const needed        = from + PAGE_SIZE;

    // ── RESOLVE MANUFACTURER VERIFIED CLINIC IDS ─────────────
    // Only evidence_type='manufacturer_directory' counts here. Clinic declared
    // entries are shown on a profile but never qualify a clinic for the
    // verified filter, because that badge is the whole promise.
    // verified_device='__all__' means the union of every manufacturer-verified
    // device (the "原廠認證診所" option). A specific value filters to that device.
    let verifiedIdList = null;
    if (verifiedDevice) {
      let vq = supabase
        .from('clinic_technologies')
        .select('clinic_id')
        .eq('evidence_type', 'manufacturer_directory')
        .range(0, 29999);
      if (verifiedDevice !== '__all__') vq = vq.eq('technology', verifiedDevice);

      const vRes = await vq;
      if (vRes.error) {
        console.error('Supabase error (verified devices):', vRes.error);
        return { statusCode: 500, body: JSON.stringify({ error: vRes.error.message }) };
      }
      verifiedIdList = [...new Set((vRes.data || []).map(r => String(r.clinic_id)))];
    }

    // ── BUILD BASE QUERY ─────────────────────────────────────
    // Always scoped to country. Neighbourhood slugs for Taiwan are
    // city-prefixed (e.g. taipei-daan, new-taipei-banqiao) and stored
    // verbatim in the neighbourhood column, use exact eq() match.
    // No fuzzy ilike needed: slugs are clean ASCII, no accent variants.
    //
    // IMPORTANT: PostgREST cannot AND two filters on the SAME column. The
    // priced buckets below add a second .in('id', pricedIdList), so if the
    // base query also did .in('id', verifiedIdList) the two collide and a
    // device + neighbourhood search silently returns nothing. We therefore
    // fold the verified-device restriction into a JS Set and filter after
    // fetching, instead of chaining a second .in('id') here.
    const verifiedIdSet = verifiedIdList ? new Set(verifiedIdList) : null;
    const deviceIdSet   = await resolveDeviceClinicIds(supabase, deviceSlug, deviceCat);

    const buildBase = () => {
      let q = supabase
        .from('clinics')
        .select(CARD_FIELDS, { count: 'exact' })
        .eq('approved', true)
        .eq('country', country);

      if (search)        q = q.ilike('name', `%${search}%`);
      if (neighbourhood) q = q.eq('neighbourhood', neighbourhood);
      if (metro)         q = q.ilike('metro', metro);
      if (stateFilter)   q = q.ilike('state', stateFilter);

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
    const currency = country === 'taiwan' ? 'NTD' : (country === 'usa' ? 'USD' : (country === 'hongkong' ? 'HKD' : 'CAD'));

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
    // When a verified-device filter is active we filter the fetched rows by the
    // id Set in JS (see note on buildBase). The verified set is small (<=~500),
    // so widen the range enough that the post-filter still fills the page.
    const verifiedWiden = (verifiedIdSet || deviceIdSet) ? Math.max(30000, needed) : 0;
    const unpricedNeeded = needed + pricedIdList.length + verifiedWiden;
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

    // Apply the verified-device restriction here (kept off the SQL to avoid the
    // two-.in('id') collision that made device + neighbourhood return nothing).
    const passVerified = (c) =>
      (!verifiedIdSet || verifiedIdSet.has(String(c.id))) &&
      (!deviceIdSet   || deviceIdSet.has(String(c.id)));

    const unpricedClaimed   = (claimedAllRes.data   || []).filter(c => !pricedIdSet.has(String(c.id)) && passVerified(c));
    const unpricedUnclaimed = (unclaimedAllRes.data || []).filter(c => !pricedIdSet.has(String(c.id)) && passVerified(c));

    const pool = [
      ...(pricedClaimedRes.data   || []).filter(passVerified),
      ...(pricedUnclaimedRes.data || []).filter(passVerified),
      ...unpricedClaimed,
      ...unpricedUnclaimed,
    ];

    // When verified-filtering in JS, the DB count is the unfiltered total, so
    // derive the count from the filtered pool instead. (The wide range above
    // means the pool holds every matching row, so pool.length is exact.)
    const totalCount = (verifiedIdSet || deviceIdSet) ? pool.length : (countRes.count || 0);
    const pageSlice  = pool.slice(from, from + PAGE_SIZE);

    // ── FETCH clinic_prices FOR THIS PAGE ─────────────────────
    const clinicIds = pageSlice.map(c => String(c.id));
    const devicesMap = await fetchDevicesFor(supabase, clinicIds);
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
      'id', 'name', 'slug', 'neighbourhood', 'region', 'country', 'state', 'metro',
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

      // Devices are attached AFTER the keep whitelist, deliberately: an empty
      // list is omitted entirely rather than rendered as "no devices", because
      // most clinics have simply not been crawled yet.
      const devs = devicesMap[String(clinic.id)];
      if (devs && devs.length) out.devices = devs;

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

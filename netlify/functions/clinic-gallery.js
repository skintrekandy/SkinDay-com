// SkinDay M12: clinic-gallery
//
// Public JSON endpoint for a clinic's published before/after cases.
//
//   GET /api/clinic-gallery?clinic_id=386
//
// No authentication. This is the developer-facing tier of gallery delivery: a
// clinic's own developer can call it and build any layout they like. The embed
// script (gallery-embed.js) and the hosted gallery page both consume this too.
//
// Security: this endpoint holds only the ANON key. The consent filter is
// enforced inside the get_clinic_gallery database function, which cannot return
// an unconsented, unpublished, or deleted case. No service-role credential is
// present in this path, deliberately: a public endpoint should not be able to
// read anything a stranger should not see, even if it is misused.
//
// CORS is open because clinic websites on their own domains embed this.
// Everything it returns is already consented to public disclosure.
//
// M12: THE SAME DATA, TWO READINGS.
//
// The response now carries both `cases` and `series`.
//
//   cases   flat, one entry per stored case, exactly as before plus three new
//           fields. This is the contract a clinic's developer already built
//           against, and it does not change shape.
//
//   series  the same cases grouped by the Studio grid they came from. One grid
//           is one patient at one sitting: several angles, or several
//           timepoints. Visualize matches on individual pairs and always will,
//           because a pair is what grounds a generation. A website visitor is
//           looking at a person, not a pair, and showing them two cards with the
//           same before photo reads as two patients.
//
// Nothing is discarded and nothing is duplicated: `series` holds references to
// the same case objects. A consumer picks whichever reading suits it.
//
// A case with no series_id (saved before M12) becomes a series of one, so the
// grouped reading degrades cleanly rather than dropping old work on the floor.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

const PUBLIC_BUCKET = 'clinic-cases-public';

// Studio's column order, so a three-angle series always reads left to right the
// way the clinic photographed it rather than the order rows came back.
const ANGLE_ORDER = { frontal: 0, oblique_right: 1, oblique_left: 2 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      CORS,
      extraHeaders || {}
    ),
    body: JSON.stringify(body)
  };
}

// Group the flat cases into series, and decide how each one wants to be read.
//
// The mode is derived, not stored, because it is already implied by the data and
// a stored copy is a second source of truth that can disagree with the first.
//
//   timeline  one angle, more than one interval. A 3-timepoint grid.
//             Before, then 3 months, then 12 months: one patient, tracked.
//             This is the longitudinal view almost no clinic website shows.
//
//   angles    one interval, more than one angle. A 2x2 or 2x3 grid.
//             The same result seen from the front and from both obliques, which
//             is the honest way to show volume work.
//
//   pair      everything else, including any case that was published alone out
//             of a larger grid. A series of one is still a series.
function buildSeries(cases) {
  const groups = new Map();

  cases.forEach((c) => {
    const key = c.series_id || c.case_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });

  const out = [];

  groups.forEach((items, key) => {
    const intervals = new Set(
      items.map((i) => i.interval_months).filter((v) => v !== null && v !== undefined)
    );
    const angles = new Set(items.map((i) => i.angle).filter(Boolean));

    let mode = 'pair';
    if (items.length > 1 && intervals.size > 1) mode = 'timeline';
    else if (items.length > 1 && angles.size > 1) mode = 'angles';

    if (mode === 'timeline') {
      items.sort((a, b) => (a.interval_months || 0) - (b.interval_months || 0));
    } else if (mode === 'angles') {
      const rank = (a) => {
        const r = ANGLE_ORDER[a.angle];
        return r === undefined ? 99 : r;
      };
      items.sort((a, b) => rank(a) - rank(b));
    }

    // A series is one patient, so treatment, subtype and crop are the same on
    // every case in it. Read them off the first rather than inventing a merge
    // rule for a disagreement that cannot happen: Studio applies one preset and
    // one label to a whole grid.
    const first = items[0];

    // The series is as recent as its most recent case, so a clinic that adds a
    // 12-month follow-up to an old grid sees that patient move up the page,
    // which is what they would expect and what the patient's progress deserves.
    const createdAt = items
      .map((i) => i.created_at)
      .filter(Boolean)
      .sort()
      .pop() || first.created_at;

    out.push({
      series_id: key,
      mode,
      treatment: first.treatment,
      subtype: first.subtype,
      treatment_label: first.treatment_label || null,
      crop: first.crop || null,
      angle: mode === 'angles' ? null : first.angle,
      interval_months: mode === 'timeline' ? null : first.interval_months,
      created_at: createdAt,
      cases: items
    });
  });

  out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'GET') {
      return json(405, { ok: false, error: 'method not allowed' });
    }

    const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_URL || !ANON_KEY) {
      return json(500, { ok: false, error: 'server not configured' });
    }

    const params = event.queryStringParameters || {};
    const clinicId = (params.clinic_id || '').trim();
    if (!clinicId) {
      return json(400, { ok: false, error: 'clinic_id is required' });
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_clinic_gallery`, {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_clinic_id: clinicId })
    });

    if (!res.ok) {
      const detail = await res.text();
      return json(502, { ok: false, error: `gallery unavailable: ${detail}` });
    }

    const rows = await res.json();
    const cases = (Array.isArray(rows) ? rows : []).map((r) => ({
      case_id: r.case_id,
      series_id: r.series_id || null,
      treatment: r.treatment,
      subtype: r.subtype,
      // The clinic's own caption, from Studio step 5. Display only. Null falls
      // back to the treatment category name.
      treatment_label: r.treatment_label || null,
      angle: r.angle,
      crop: r.crop || null,
      phenotype: r.phenotype,
      interval_months:
        r.interval_months === null || r.interval_months === undefined
          ? null
          : Number(r.interval_months),
      before_date: r.before_date,
      after_date: r.after_date,
      before_url: `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${r.published_before_path}`,
      after_url: `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${r.published_after_path}`,
      created_at: r.created_at
    }));

    const series = buildSeries(cases);

    return json(
      200,
      {
        ok: true,
        clinic_id: clinicId,
        count: cases.length,
        series_count: series.length,
        cases,
        series
      },
      // Ten seconds, not sixty.
      //
      // The cache exists to absorb a burst of visitors, and ten seconds does that
      // as well as sixty does. What sixty seconds ALSO did was outlast a clinic's
      // patience: publish a case, switch tabs, reload, and see the old gallery.
      // The clinic does not conclude "the cache has not expired". They conclude
      // the product is broken, and they are not wrong to, because a product that
      // does not do what you just told it to is broken from where they sit.
      //
      // The database read this costs is trivial. The confusion it cost was not.
      { 'Cache-Control': 'public, max-age=10, s-maxage=10' }
    );
  } catch (err) {
    console.error('clinic-gallery failed', err);
    return json(500, {
      ok: false,
      error: 'unhandled error',
      detail: (err && err.message) || String(err)
    });
  }
};

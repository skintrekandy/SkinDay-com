// rehost-photos.js
// Downloads each clinic's Google photo once and re-hosts it in Supabase
// Storage, so the directory stops depending on Google's signed CDN links.
// Deploy to: netlify/functions/rehost-photos.js
//
// WHY THIS EXISTS
// clinics.photo held lh3.googleusercontent.com/gps-cs-s/... URLs. Those are
// signed and time-limited: the rows were fine, the URLs stopped resolving, and
// every card fell back to the grey 診所 placeholder. Re-fetching only buys
// fresh URLs that expire again, so we keep our own copy.
//
// ⚠️ THE UNKNOWN THIS TOOL RESOLVES
// It was never confirmed whether the stored URLs are actually dead or merely
// blocked in some other way. So START WITH ?action=probe. It fetches a handful
// of URLs, writes NOTHING, and reports the HTTP status of each:
//   • mostly 200  -> the URLs still work. Skip straight to action=run.
//   • mostly 403/404 -> they are expired. The URLs must be refreshed from
//     Outscraper FIRST (place_id is on every row), because you cannot download
//     an image from a dead link. Then run this.
//
// USAGE (secret via ?secret= or the x-admin-secret header)
//   ?action=probe            — read-only, 8 URLs, reports status codes
//   ?action=stats            — how many remain
//   ?action=run&limit=25     — re-host one batch, returns remaining
//   ?action=run&country=taiwan — restrict to one country
// Call run repeatedly until remaining hits 0. Netlify's sync function timeout
// is short, hence batches rather than one long loop.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET       = 'clinic-photos';

// ── TARGETS ────────────────────────────────────────────────────────────────
// ?target=photo (default) or ?target=logo. Everything below is driven off this
// table so the two paths cannot drift apart.
//
// ⭐ LOGOS GO IN `clinic-photos` UNDER A `logos/` PREFIX, NOT IN `clinic-logos`.
// That bucket holds media CLAIMED CLINICS UPLOADED THEMSELVES through the
// portal. Writing our crawl output beside it is how a future cleanup deletes a
// paying clinic's own artwork by mistake — that near-miss already happened once
// with the clinic-<id>/ folders.
//
// ⭐ AND LOGOS DEFAULT TO 160px, NOT 480. A photo fills the card; a logo is a
// small badge in its corner. At 480 the ~14,800 logos would cost as much as a
// whole country of photos and look no different.
const TARGETS = {
  photo: {
    col:        'photo',
    sourceCol:  'photo_source',
    stampCol:   'photo_rehosted_at',
    prefix:     '',
    defaultPx:  800,
    label:      'card photo'
  },
  logo: {
    col:        'logo',
    sourceCol:  'logo_source',
    stampCol:   'logo_rehosted_at',
    prefix:     'logos/',
    defaultPx:  160,
    label:      'clinic logo'
  }
};

// Ask Google for a card-sized image rather than the full original. lh3 accepts
// a size suffix on the URL, and this is the single most important line in the
// file: the Supabase free tier is 1GB, and full-size originals measured
// 1,363 kB EACH — 8,534 of those is 11.6 GB, eleven times over the limit.
//
// ⭐ THE BUG THIS REPLACES: the stored Outscraper URLs ALREADY carry Google's
// own suffix (...token=w1920-h1080-k-no). The first version saw an existing
// "=" and bailed out with "already sized, leave it alone", which faithfully
// downloaded 1920px originals. Preserving Google's size was never the goal.
// An existing suffix is now REPLACED, not respected.
//
// Two shapes are still left untouched, because appending would break them:
// a URL ending in a real filename (photo.jpg=w800 is not a valid lh3 request)
// and one carrying a query string. A full-size image that loads still beats a
// resized one that 404s.
function sized(url, px) {
  if (!url) return url;
  if (url.includes('?')) return url;                 // query string: leave alone
  const cut  = url.lastIndexOf('/');
  const tail = url.slice(cut + 1);
  if (/\.[a-z0-9]{2,4}$/i.test(tail)) return url;    // real filename: leave alone
  const eq    = tail.indexOf('=');
  const token = eq === -1 ? tail : tail.slice(0, eq); // drop Google's suffix
  return url.slice(0, cut + 1) + token + '=w' + px;
}

function ok(body)      { return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body, null, 2) }; }
function bad(code, m)  { return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: m }) }; }

exports.handler = async (event) => {
  const q      = event.queryStringParameters || {};
  const secret = q.secret || event.headers['x-admin-secret'] || '';
  const expected = [process.env.ADMIN_SECRET, process.env.VISUALIZE_ADMIN_SECRET].filter(Boolean);
  if (!expected.length)              return bad(500, 'No ADMIN_SECRET or VISUALIZE_ADMIN_SECRET is set');
  if (!expected.includes(secret))    return bad(401, 'Bad secret');
  if (!SUPABASE_URL || !SUPABASE_KEY) return bad(500, 'Supabase env vars missing');

  const sb      = createClient(SUPABASE_URL, SUPABASE_KEY);
  const action  = q.action || 'stats';
  const country = q.country || null;
  // ⭐ STATE. "USA" is no longer one cohort: California was refreshed today and
  // New York still holds original-import URLs months old. Without this the tool
  // grinds on New York's dead links and never reaches California.
  const state   = q.state || null;
  const limit   = Math.min(parseInt(q.limit || '25', 10) || 25, 50);

  const targetKey = (q.target === 'logo') ? 'logo' : 'photo';
  const T         = TARGETS[targetKey];
  const px        = Math.min(parseInt(q.px || String(T.defaultPx), 10) || T.defaultPx, 1600);

  // ⭐ SKIP ROWS THAT HAVE NEVER BEEN REFRESHED. This is the fix for the night
  // 1,062 never-refreshed New York rows sat AHEAD of California in the id order
  // and the tool ground on their long-dead URLs for 212,959 requests without
  // ever reaching the live ones. A row whose data was never refreshed is
  // holding an original-import URL, which is months old and certainly dead.
  // Default ON; pass fresh_only=0 to include them.
  const freshOnly = q.fresh_only !== '0';

  const scope = (sel) => {
    sel = sel.like(T.col, '%googleusercontent.com%').is(T.stampCol, null);
    if (country)   sel = sel.eq('country', country);
    if (state)     sel = sel.eq('state', state);
    if (freshOnly) sel = sel.not('data_refreshed_at', 'is', null);
    return sel;
  };

  // rows still pointing at Google
  const pending = async (n) => {
    const { data, error } = await scope(
      sb.from('clinics').select(`id, name, country, ${T.col}, ${T.sourceCol}`)
    ).limit(n);
    if (error) throw new Error(error.message);
    return data || [];
  };

  const countRemaining = async () => {
    const { count, error } = await scope(
      sb.from('clinics').select('id', { count: 'exact', head: true })
    );
    if (error) throw new Error(error.message);
    return count || 0;
  };

  try {
    // ── STATS ──────────────────────────────────────────────────────────────
    if (action === 'stats') {
      return ok({ action, target: targetKey, label: T.label,
                  country: country || 'all', state: state || 'all',
                  fresh_only: freshOnly,
                  remaining: await countRemaining() });
    }

    // ── RESET — undo re-hosting so rows can be redone at a smaller size ────
    // Points photo back at photo_source and clears the stamp, which makes the
    // rows eligible again. The storage objects are left in place: run uses the
    // same {country}/{id}.{ext} path with upsert, so they are overwritten and
    // the bucket total drops to the new size rather than doubling.
    if (action === 'reset') {
      let sel = sb.from('clinics')
        .select(`id, ${T.sourceCol}`)
        .not(T.stampCol, 'is', null)
        .limit(500);
      if (country) sel = sel.eq('country', country);
      if (state)   sel = sel.eq('state', state);
      const { data, error } = await sel;
      if (error) throw new Error(error.message);
      const rows = (data || []).filter(r => r[T.sourceCol]);
      const done = await Promise.all(rows.map(r =>
        sb.from('clinics')
          .update({ [T.col]: r[T.sourceCol], [T.stampCol]: null })
          .eq('id', r.id)
          .then(res => !res.error)
      ));
      return ok({
        action, target: targetKey,
        reset: done.filter(Boolean).length, attempted: rows.length,
        skipped_no_source: (data || []).length - rows.length,
        note: 'These rows are eligible again. Re-run with a smaller px.'
      });
    }

    // ── PROBE — reads only, writes nothing. Run this first. ────────────────
    if (action === 'probe') {
      const rows = await pending(8);
      const results = await Promise.all(rows.map(async r => {
        try {
          const res = await fetch(sized(r[T.col], px), { redirect: 'follow' });
          const len = res.headers.get('content-length');
          return {
            id: r.id, name: (r.name || '').slice(0, 28),
            status: res.status,
            type: res.headers.get('content-type') || '',
            kb: len ? Math.round(parseInt(len, 10) / 1024) : null
          };
        } catch (e) { return { id: r.id, status: 'FETCH FAILED', detail: String(e.message || e) }; }
      }));
      const live = results.filter(r => r.status === 200).length;
      return ok({
        action, target: targetKey, label: T.label, tested: results.length, live,
        verdict: results.length === 0
          ? 'NOTHING LEFT — every image in this selection has already been copied. Pick another country or state.'
          : live === 0
          ? 'ALL DEAD — the stored URLs have expired. Refresh them from Outscraper using place_id BEFORE running action=run; you cannot download from a dead link.'
          : live === results.length
            ? 'ALL LIVE — the URLs still work. Go straight to action=run.'
            : 'MIXED — some expired. action=run re-hosts the live ones and reports the rest as failed, so run it, then refresh only what is left.',
        results
      });
    }

    // ── RUN — download, upload, repoint ────────────────────────────────────
    if (action === 'run') {
      const rows = await pending(limit);
      if (!rows.length) return ok({ action, done: true, remaining: 0, message: 'Nothing left to re-host.' });

      const out = await Promise.all(rows.map(async r => {
        try {
          const res = await fetch(sized(r[T.col], px), { redirect: 'follow' });
          if (!res.ok) return { id: r.id, ok: false, status: res.status };

          const type = res.headers.get('content-type') || 'image/jpeg';
          if (!type.startsWith('image/')) return { id: r.id, ok: false, status: 'not an image: ' + type };

          const buf  = Buffer.from(await res.arrayBuffer());
          if (!buf.length) return { id: r.id, ok: false, status: 'empty body' };

          const ext  = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
          const path = `${T.prefix}${r.country || 'unknown'}/${r.id}.${ext}`;

          const up = await sb.storage.from(BUCKET)
            .upload(path, buf, { contentType: type, upsert: true, cacheControl: '31536000' });
          if (up.error) return { id: r.id, ok: false, status: 'upload: ' + up.error.message };

          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

          // The source column keeps the Google origin so a run is reversible.
          // Only the live column is repointed, so every page picks it up with
          // no front-end change at all.
          // ⭐ coalesce in SQL is not available here, so the origin is written
          // ONLY when it is still empty — re-running must never overwrite the
          // origin with our own storage URL.
          const patch = { [T.col]: publicUrl, [T.stampCol]: new Date().toISOString() };
          if (!r[T.sourceCol]) patch[T.sourceCol] = r[T.col];
          const upd = await sb.from('clinics')
            .update(patch)
            .eq('id', r.id);
          if (upd.error) return { id: r.id, ok: false, status: 'db: ' + upd.error.message };

          return { id: r.id, ok: true, kb: Math.round(buf.length / 1024) };
        } catch (e) {
          return { id: r.id, ok: false, status: String(e.message || e) };
        }
      }));

      const good = out.filter(r => r.ok);
      return ok({
        action, target: targetKey, attempted: out.length,
        rehosted: good.length,
        failed: out.length - good.length,
        kb_stored: good.reduce((a, r) => a + (r.kb || 0), 0),
        remaining: await countRemaining(),
        failures: out.filter(r => !r.ok).slice(0, 10),
        note: 'Call again until remaining is 0.'
      });
    }

    return bad(400, 'Unknown action. Use probe, stats, run or reset.');
  } catch (e) {
    return bad(500, String(e.message || e));
  }
};

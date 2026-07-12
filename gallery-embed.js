/*
 * SkinDay gallery embed
 *
 * A clinic's developer installs this once, then the clinic self-serves forever:
 * every case they publish in SkinDay appears here automatically, with no further
 * developer involvement. That recurring friction is the thing this replaces.
 *
 * Install (one line, anywhere in the page body):
 *
 *   <script src="https://skinday.com/gallery-embed.js"
 *           data-clinic-id="386"
 *           data-columns="3"></script>
 *
 * Optional attributes:
 *   data-columns   grid columns on desktop (default 3)
 *   data-limit     maximum cases to show (default all)
 *   data-target    id of an existing element to render into
 *
 * It renders a self-contained before/after grid with scoped styles, so it will
 * not fight the host site's CSS. Only cases the patient consented to publish are
 * ever returned by the API, so this script cannot display anything unconsented.
 */
(function () {
  'use strict';

  var API = 'https://skinday.com/api/clinic-gallery';
  var script = document.currentScript;
  if (!script) return;

  var clinicId = script.getAttribute('data-clinic-id');
  if (!clinicId) {
    console.error('[skinday] gallery embed needs data-clinic-id');
    return;
  }

  var columns = parseInt(script.getAttribute('data-columns'), 10) || 3;
  var limit = parseInt(script.getAttribute('data-limit'), 10) || 0;
  var targetId = script.getAttribute('data-target');

  var root = document.createElement('div');
  root.className = 'skinday-gallery';
  if (targetId && document.getElementById(targetId)) {
    document.getElementById(targetId).appendChild(root);
  } else {
    script.parentNode.insertBefore(root, script);
  }

  var css =
    '.skinday-gallery{--sd-deep:#1C1714;--sd-cream:#FAF7F2;--sd-rose:#C8725A;' +
    '--sd-gold:#C9A96E;font-family:inherit;color:var(--sd-deep);}' +
    '.skinday-gallery *{box-sizing:border-box;}' +
    '.sd-grid{display:grid;grid-template-columns:repeat(' + columns + ',1fr);gap:20px;}' +
    '@media (max-width:900px){.sd-grid{grid-template-columns:repeat(2,1fr);}}' +
    '@media (max-width:600px){.sd-grid{grid-template-columns:1fr;}}' +
    '.sd-case{background:var(--sd-cream);border:1px solid #e6ddd3;border-radius:12px;' +
    'overflow:hidden;}' +
    '.sd-pair{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:#e6ddd3;}' +
    '.sd-fig{position:relative;margin:0;background:#fff;}' +
    '.sd-fig img{display:block;width:100%;height:100%;object-fit:cover;aspect-ratio:4/5;}' +
    '.sd-tag{position:absolute;left:8px;bottom:8px;background:rgba(28,23,20,.82);' +
    'color:var(--sd-cream);font-size:11px;letter-spacing:.08em;text-transform:uppercase;' +
    'padding:3px 8px;border-radius:4px;}' +
    '.sd-meta{padding:12px 14px;font-size:13px;display:flex;gap:10px;flex-wrap:wrap;' +
    'align-items:center;}' +
    '.sd-treat{font-weight:600;text-transform:capitalize;}' +
    '.sd-angle{color:#6b615a;}' +
    '.sd-note{margin-top:16px;font-size:12px;color:#6b615a;}' +
    '.sd-empty{padding:24px;text-align:center;color:#6b615a;font-size:14px;' +
    'background:var(--sd-cream);border-radius:12px;}';

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  var grid = document.createElement('div');
  grid.className = 'sd-grid';
  root.appendChild(grid);

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function figure(url, label) {
    return (
      '<figure class="sd-fig">' +
      '<img loading="lazy" src="' + esc(url) + '" alt="' + label + '">' +
      '<figcaption class="sd-tag">' + label + '</figcaption>' +
      '</figure>'
    );
  }

  function render(cases) {
    if (!cases.length) {
      grid.outerHTML = '<div class="sd-empty">No cases published yet.</div>';
      return;
    }
    var html = '';
    cases.forEach(function (c) {
      var meta = '';
      if (c.treatment) meta += '<span class="sd-treat">' + esc(c.treatment) + '</span>';
      if (c.angle) meta += '<span class="sd-angle">' + esc(c.angle) + '</span>';
      html +=
        '<div class="sd-case">' +
        '<div class="sd-pair">' +
        figure(c.before_url, 'Before') +
        figure(c.after_url, 'After') +
        '</div>' +
        (meta ? '<div class="sd-meta">' + meta + '</div>' : '') +
        '</div>';
    });
    grid.innerHTML = html;

    var note = document.createElement('p');
    note.className = 'sd-note';
    note.textContent =
      'Individual results vary. Published with patient consent.';
    root.appendChild(note);
  }

  fetch(API + '?clinic_id=' + encodeURIComponent(clinicId))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.ok) {
        console.error('[skinday] gallery error', data);
        grid.outerHTML = '<div class="sd-empty">Gallery unavailable.</div>';
        return;
      }
      var cases = data.cases || [];
      if (limit > 0) cases = cases.slice(0, limit);
      render(cases);
    })
    .catch(function (err) {
      console.error('[skinday] gallery fetch failed', err);
      grid.outerHTML = '<div class="sd-empty">Gallery unavailable.</div>';
    });
})();

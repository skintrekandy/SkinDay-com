// SkinDay MI app shell. Scope is /mi-dashboard only, so the patient site is
// never touched. Data calls always go to the network; only the page itself,
// fonts and icons are kept for a fast, offline-tolerant open.
var SHELL = 'mi-shell-v2';
var PAGE = '/mi-dashboard';

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return c.addAll([PAGE, '/mi-app/icon-192.png', '/mi-app/apple-touch-icon.png']);
  }).catch(function () {}));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('mi-') === 0 && k !== SHELL; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.pathname.indexOf('/.netlify/') === 0) return;   // live data, never cached

  // The page: network first so a deploy shows up straight away; the saved copy
  // is used when the network is slow (over 3s) or missing.
  if (req.mode === 'navigate') {
    e.respondWith(new Promise(function (resolve) {
      var done = false;
      var fallback = function () {
        if (done) return;
        caches.match(PAGE).then(function (r) { if (r && !done) { done = true; resolve(r); } });
      };
      var t = setTimeout(fallback, 3000);
      fetch(req).then(function (res) {
        clearTimeout(t);
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(PAGE, copy); });
        }
        if (!done) { done = true; resolve(res); }
      }).catch(function () {
        clearTimeout(t);
        caches.match(PAGE).then(function (r) {
          if (!done) { done = true; resolve(r || Response.error()); }
        });
      });
    }));
    return;
  }

  // Fonts and icons: saved copy first, refreshed in the background.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com' ||
      url.pathname.indexOf('/mi-app/') === 0) {
    e.respondWith(caches.open(SHELL).then(function (c) {
      return c.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || net;
      });
    }));
  }
});

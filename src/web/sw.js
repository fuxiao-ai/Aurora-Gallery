/* global self, caches */
/* Service worker for installability and faster shell load. */
var CACHE_NAME = 'aurora-gallery-shell-v29';
var SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest?v=5',
  '/apple-touch-icon.png?v=5',
  '/app-icon-192.png?v=5',
  '/app-icon-512.png?v=5',
  '/app-icon.svg',
  '/playback-strategy.js',
  '/hls-attach.js',
  '/js/web-theme-shared.js',
  '/js/app.js',
  '/js/photo-compare.js?v=1',
  '/photo-compare.css?v=1',
  '/js/ai-views.js?v=1',
  '/ai-web-views.css?v=1',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(SHELL_ASSETS);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (key) {
            if (key !== CACHE_NAME) return caches.delete(key);
            return Promise.resolve();
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Never cache API/media endpoints.
  if (
    url.pathname.indexOf('/api/') === 0 ||
    url.pathname.indexOf('/photo/') === 0 ||
    url.pathname.indexOf('/preview-image/') === 0 ||
    url.pathname.indexOf('/video/') === 0 ||
    url.pathname.indexOf('/thumb/') === 0 ||
    url.pathname.indexOf('/hls/') === 0
  ) {
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req)
        .then(function (resp) {
          if (!resp || resp.status !== 200) return resp;
          var copy = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, copy);
          });
          return resp;
        })
        .catch(function () {
          return caches.match('/index.html');
        });
    }),
  );
});

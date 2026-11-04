/* GFF Receipts service worker: caches the app shell so the app opens with no signal.
   Bump CACHE when any shell file changes (the app then shows "A new version is ready").
   Only same-origin GETs are handled; calls to the Apps Script backend always go to the network. */
'use strict';
var CACHE = 'gff-receipts-7.0.0';
var SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './favicon.ico',
  './fonts/assistant-latin.woff2', './fonts/merriweathersans-latin.woff2',
  './icons/icon-32.png', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './icons/maskable-192.png', './icons/maskable-512.png'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('gff-receipts-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (e) { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // API + anything else: straight to network
  if (req.mode === 'navigate') {
    // App page: cached copy first (instant + offline), ignoring ?go=... shortcuts.
    e.respondWith(caches.match('./index.html').then(function (hit) { return hit || fetch(req); }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  }));
});

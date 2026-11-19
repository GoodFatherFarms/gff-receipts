/* GFF Receipts service worker: caches the app shell so the app opens with no signal.
   Bump CACHE when any shell file changes (the app then shows "A new version is ready").
   Only same-origin requests are handled; calls to the Apps Script backend always go to the network.
   v8: the sign-in and new-PIN forms really submit (POST ./signed-in, ./pin-set) so iCloud Keychain offers to
   save the PIN. Those POSTs are answered here from the cache and never reach the network. */
'use strict';
var CACHE = 'gff-receipts-8.1.0';
var SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './favicon.ico',
  './fonts/assistant-latin.woff2', './fonts/merriweathersans-latin.woff2',
  './icons/icon-32.png', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './icons/apple-touch-icon-v8.png', './icons/maskable-192.png', './icons/maskable-512.png'
];
var FORM_POSTS = /\/(signed-in|pin-set)$/;
self.addEventListener('install', function (e) {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages sends max-age=600), so a new version
  // never gets stored with an old file.
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('gff-receipts-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (e) { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
function appPage() {
  return caches.match('./index.html').then(function (hit) { return hit || fetch('./index.html'); });
}
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // API + anything else: straight to network
  if (req.method === 'POST') {
    // The sign-in / new-PIN form submission: answer with the app page; the body (name + PIN) is dropped here.
    if (req.mode === 'navigate' && FORM_POSTS.test(url.pathname)) e.respondWith(appPage());
    return;
  }
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    // App page: cached copy first (instant + offline), ignoring ?go=... shortcuts.
    e.respondWith(appPage());
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  }));
});

// ponytail: app-shell cache, network-first for API. Cache name carries the app version so
// every deploy ships fresh JS (RC-5). Shared modules + vendored lucide are precached so the
// app boots fully offline (RC-6).
const CACHE = 'att-3.1.0';
const SHELL = [
  './', 'index.html', 'admin.html', 'teacher.html', 'style.css', 'app.js', 'manifest.json',
  '../shared/config.js', '../shared/connection.js', '../shared/pairing.js',
  '../shared/vendor/lucide.min.js', '../shared/vendor/peerjs.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/signal')) return; // never cache API/signalling
  // Cache-first for the shell; fall back to network and cache new GETs.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (e.request.method === 'GET' && res.ok && url.origin === location.origin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

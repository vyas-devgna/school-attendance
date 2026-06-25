// ponytail: admin app-shell cache. Version in the name → every deploy ships fresh JS (RC-5).
// Shared modules + vendored lucide precached so the panel works without a CDN (RC-6).
const CACHE = 'admin-2.1.0-subdomain-fix';
const SHELL = [
  './', 'index.html', 'manifest.json',
  '../shared/config.js', '../shared/connection.js', '../shared/pairing.js', '../shared/vendor/lucide.min.js',
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
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/signal')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (e.request.method === 'GET' && res.ok && url.origin === location.origin) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

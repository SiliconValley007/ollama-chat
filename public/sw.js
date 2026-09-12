// Service Worker for PWA — cache shell assets for offline
const CACHE = 'claude-chat-v3';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  // API calls: always network only, never intercept
  if (e.request.url.includes('/api/')) return;
  // HTML: network-first so index.html edits always take effect; fall back to cache offline
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Other shell assets: cache first, fallback to network
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

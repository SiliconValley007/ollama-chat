// Service Worker for PWA — cache shell assets for offline
const CACHE = 'claude-chat-v2';
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
  // Shell assets: cache first, fallback to network
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

const CACHE_NAME = 'zaptalk-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/chat.html',
  '/style.css',
  '/chat.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
});
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('/index.html');
        return new Response('You are offline ⚡', { headers: { 'Content-Type': 'text/plain' } });
      });
    })
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => {
    if (key !== CACHE_NAME) return caches.delete(key);
  }))));
});

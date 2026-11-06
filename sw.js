const CACHE_PREFIX = 'lae-scanner-shell-';
const CACHE_NAME = 'lae-scanner-shell-v1.3.0';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './app.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Los archivos de la app se consultan primero en GitHub Pages. Así una
  // recarga normal obtiene el último despliegue sin pedir borrar la caché.
  // La caché queda como respaldo cuando el dispositivo está sin Internet.
  const cacheKey = new Request(url.origin + url.pathname);

  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response && response.ok && response.type !== 'opaque') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(cacheKey, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(cacheKey);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const fallback = await caches.match(new Request(new URL('./index.html', self.registration.scope).toString()));
        if (fallback) return fallback;
      }
      return Response.error();
    }
  })());
});

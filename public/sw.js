/*
 * AK Cash Club service worker (lets the site be installed as an app).
 *
 * Deliberately small and privacy-safe:
 *  - Pages are always fetched from the network and are NEVER stored, so
 *    member pages (results, account details) are never kept on the device.
 *    If the network is down, a simple "you're offline" page is shown.
 *  - Only fingerprinted build files (/_astro/), brand images and icons are
 *    cached, because they never contain personal information.
 */
const VERSION = 'akc-v1';
const STATIC_CACHE = `${VERSION}-static`;
const OFFLINE_URL = '/offline/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll([OFFLINE_URL, '/brand/app-icon-192.png'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/brand/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
      }),
    );
  }
  // Everything else: normal network behaviour, nothing stored.
});

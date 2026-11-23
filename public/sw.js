const CACHE_NAME = 'amazon-duaa-cache-v5';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((asset) =>
          fetch(asset, { cache: 'no-store' })
            .then((response) => {
              if (response && response.ok && response.type === 'basic') {
                return cache.put(asset, response);
              }
            })
            .catch(() => {})
        )
      );
    })
  );

  // First-time install activates immediately; subsequent updates wait for user confirmation via SKIP_WAITING
  if (!self.registration || !self.registration.active) {
    self.skipWaiting();
  }
});

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept or cache cross-origin requests (Firebase, Firestore, Google APIs, CDN images)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never cache /sw.js itself so browsers always detect server-side SW updates immediately
  if (url.pathname === '/sw.js') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

  // Network-only (no-store) for API routes; return offline JSON only on network failure
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => {
        return new Response(
          JSON.stringify({ error: 'أنت في وضع عدم الاتصال بالإنترنت (Offline Mode).' }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      })
    );
    return;
  }

  // Network-first for HTML navigation so storefront always serves latest deployment immediately
  const isNavigation =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html';

  if (isNavigation) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          const ct = networkResponse.headers.get('content-type') || '';
          if (networkResponse && networkResponse.ok && networkResponse.type === 'basic' && ct.includes('text/html')) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Network-first with cache fallback for same-origin static assets (never cache text/html fallback for JS/CSS)
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((networkResponse) => {
        const contentType = networkResponse.headers.get('content-type') || '';
        const isAssetFile = /\.(?:js|mjs|css|json|svg|png|jpe?g|webp|woff2?)$/i.test(url.pathname);
        if (
          networkResponse &&
          networkResponse.ok &&
          networkResponse.type === 'basic' &&
          !(isAssetFile && contentType.includes('text/html'))
        ) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});

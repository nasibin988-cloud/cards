/* Cards: minimal hand-rolled service worker.
 * Strategy:
 *   - Precache shell on install (root + key routes + manifest).
 *   - cache-first for /_next/static/*, fonts, sql-wasm.
 *   - stale-while-revalidate for same-origin HTML routes — return cache
 *     immediately if present, refresh in the background, fall back to
 *     network-first when no cache.
 *   - opportunistic cache for Wikimedia upload thumbnails so the AskAI
 *     /image grid stays warm offline.
 *   - bypass /api/*, anthropic.com, and any non-GET request.
 */

const VERSION = 'v5-2026-05-02';
const STATIC_CACHE = `cards-static-${VERSION}`;
const RUNTIME_CACHE = `cards-runtime-${VERSION}`;
const IMAGE_CACHE = `cards-images-${VERSION}`;

// Derive the basePath from the SW's own URL so the same `sw.js` file works
// at any deploy prefix (e.g. `/sw.js` locally, `/cards/sw.js` in prod).
// `self.location.pathname` is the URL the SW was loaded from; stripping the
// trailing `/sw.js` gives the basePath the registration controls.
const BASE = self.location.pathname.replace(/\/sw\.js$/, '');

const SHELL_URLS = [
  `${BASE}/`,
  `${BASE}/decks/new`,
  `${BASE}/import`,
  `${BASE}/settings`,
  `${BASE}/stats`,
  `${BASE}/audit`,
  `${BASE}/trouble`,
  `${BASE}/tags`,
  `${BASE}/sessions`,
  `${BASE}/practice`,
  `${BASE}/exam`,
  `${BASE}/read`,
  `${BASE}/generate`,
  // NOTE: manifest.json deliberately NOT precached. Chrome reads the
  // manifest through the SW during PWA install/update, so caching it
  // makes display/display_override changes (e.g. window-controls-overlay)
  // get stuck on whatever was cached at SW-install time. The fetch
  // handler below also bypasses it for the same reason.
  `${BASE}/sql-wasm/sql-wasm.wasm`,
  `${BASE}/sql-wasm/sql-wasm-browser.wasm`,
  `${BASE}/pdf.worker.min.mjs`,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(SHELL_URLS).catch(() => {})),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![STATIC_CACHE, RUNTIME_CACHE, IMAGE_CACHE].includes(k))
          .map(k => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Always bypass these — direct network only.
  if (url.pathname.startsWith(`${BASE}/api/`)) return;
  if (url.host.includes('api.anthropic.com')) return;
  if (url.host.includes('anthropic.com')) return;
  // manifest.json must hit the network so PWA install/update sees the
  // current display_override etc.; SW caching kept Chrome locked into
  // a pre-WCO manifest across reinstalls.
  if (url.pathname === `${BASE}/manifest.json`) return;

  // Static assets: cache-first. The .mjs worker for pdfjs is immutable per
  // file content (we ship a fixed version under public/), so it belongs
  // here too — without this it'd fall through to stale-while-revalidate
  // and re-fetch on every page-load until first use.
  if (
    url.pathname.startsWith(`${BASE}/_next/static/`) ||
    url.pathname.startsWith(`${BASE}/sql-wasm/`) ||
    url.pathname === `${BASE}/pdf.worker.min.mjs` ||
    url.host.includes('fonts.gstatic.com') ||
    url.host.includes('fonts.googleapis.com')
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Wikimedia upload thumbnails: cache opportunistically. Lets repeated
  // /image queries reuse hits without another fetch round-trip.
  if (url.host.includes('upload.wikimedia.org')) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // Same-origin HTML / data: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

async function cacheFirst(request, cacheName = STATIC_CACHE) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone()).catch(() => {});
  }
  return res;
}

/**
 * Stale-while-revalidate: serve from cache instantly if present, kick off a
 * network refresh in parallel that updates the cache for next time. On a cold
 * cache (first visit) it falls back to network-first behavior.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);

  if (cached) {
    // Don't await the refresh — it lands silently for the next visit.
    networkPromise.catch(() => { /* swallow */ });
    return cached;
  }

  const fresh = await networkPromise;
  if (fresh) return fresh;

  // Offline + not in cache: navigation requests get the precached home page.
  if (request.mode === 'navigate') {
    const home = await caches.match(`${BASE}/`);
    if (home) return home;
  }
  throw new Error('offline and not cached');
}

// Gather — service worker
//
// Deliberately network-first, not offline-first: every request tries the
// network before ever touching the cache, so a new deploy shows up the
// next time the app loads or refreshes — no different from how updates
// have always worked here. The cache only kicks in if the network request
// actually fails (genuinely no signal), so there's still *something* to
// show rather than a blank error screen.
//
// Bump CACHE_NAME (e.g. to "gather-v2") if this file itself changes in a
// way that needs old caches cleared out — it's what triggers activate()
// to delete anything from a previous version.

const CACHE_NAME = "gather-v1";
const OFFLINE_URL = "/index.html";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only ever handle simple page/asset loads. Never intercept the app's
  // own API calls (/api/state, /api/sync-bring, /api/extract-recipe) —
  // those need to always hit the live function, never a cached response.
  if (req.method !== "GET" || req.url.indexOf("/api/") !== -1) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return response;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match(OFFLINE_URL)))
  );
});

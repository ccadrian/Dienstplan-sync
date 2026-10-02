// Service Worker: hält die App-Hülle offline verfügbar.
// Strategie "Netzwerk zuerst": Updates kommen sofort an, offline greift der Cache.
// Anfragen an die API (andere Domain) werden nicht angefasst.
const CACHE = "dienstplan-sync-v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: "no-cache" });
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ??
          (request.mode === "navigate" ? await cache.match("index.html") : undefined);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});

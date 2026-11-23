const base = new URL(self.registration.scope);
const cachePrefix = "skillissues:" + base.pathname;
const appCache = cachePrefix + "app-3";
const runtimeCache = cachePrefix + "python-1";
const appAssets = ["./", "./app.js", "./cp.js", "./cp-bridge.js", "./highlight.js", "./icon.svg", "./index.html", "./python-worker.js", "./style.css"];
const appURLs = new Set(appAssets.map((asset) => new URL(asset, base).href));
const runtimePath = new URL("runtime/", base).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(appCache)
    .then((cache) => cache.addAll([...appURLs]))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([1, 2].map((version) => caches.delete(cachePrefix + "app-" + version)))
    .then(() => self.clients.claim()));
});

function isRuntimeURL(url) {
  if (url.origin === base.origin) {
    return url.pathname.startsWith(runtimePath);
  }
  return url.origin === "https://cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/v0.29.3/full/");
}

async function loadAsset(request, cacheName, cacheFirst) {
  let cache;
  let saved;
  try {
    cache = await caches.open(cacheName);
    saved = await cache.match(request);
  } catch {
    // The app still works online when device storage is unavailable.
  }
  if (cacheFirst && saved) return { response: saved };

  try {
    const response = await fetch(request);
    const isHTML = response.headers.get("Content-Type")?.startsWith("text/html");
    const stored = cache && response.ok && !(cacheFirst && isHTML)
      ? cache.put(request, response.clone()).catch(() => {})
      : undefined;
    return { response, stored };
  } catch (error) {
    if (saved) return { response: saved };
    throw error;
  }
}

function respondWithAsset(event, request, cacheName, cacheFirst) {
  const asset = loadAsset(request, cacheName, cacheFirst);
  event.respondWith(asset.then(({ response }) => response));
  event.waitUntil(asset.then(({ stored }) => stored, () => {}));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isRuntimeURL(url)) {
    respondWithAsset(event, request, runtimeCache, true);
    return;
  }
  url.search = "";
  if (!appURLs.has(url.href)) return;
  // Cache the app entry point at its canonical URL for offline reloads.
  const assetRequest = request.mode === "navigate" && request.url !== url.href
    ? new Request(url.href)
    : request;
  respondWithAsset(event, assetRequest, appCache, false);
});

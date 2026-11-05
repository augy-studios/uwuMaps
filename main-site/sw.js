// uwuMaps' service worker. Bump CACHE_VERSION on every change to anything listed below: the browser
// compares this file byte for byte, so that bump is what makes an update happen at all.
//
// What happens to each request:
//
//   navigation              the shell for the app's own addresses, / and the share links; anything else
//                           from the network
//   /api/                   not intercepted: it needs the network and says so itself
//   same origin assets      cache first
//   OpenFreeMap's tiles     cache first, in a cache that outlives versions
//   Google Fonts            cache first, in a cache that outlives versions
//   other cross origin      not intercepted: search, routing, Overture, analytics and ads
//   range requests          not intercepted
//   anything but GET        not intercepted
//
// Rules that are easy to break here:
//
// 1. A new version downloads and then waits. Nothing here calls skipWaiting() or clients.claim() except
//    the message handler, so a person pressing Reload on the update bar is what brings it in
//    (docs/update-bar-spec.md).
//
// 2. Navigations are answered from this worker's own shell, not the network. The shell's modules are
//    cache first, so a network page would pair a new index.html with the previous build's JavaScript.
//
// 3. Nothing redirected goes in the shell. cleanUrls redirects /index.html to /, and a redirected response
//    can't answer a navigation: the page fails with ERR_FAILED for anybody this worker controls.
//
// 4. Precache entries are fetched one at a time with cache: "reload". addAll fails the whole install on
//    one bad path, and without "reload" a bumped worker can fill its new cache from the HTTP cache's old
//    files.
//
// 5. Nothing under /api/ is ever cached, and saved packs, tiles and the font survive a new version.

const CACHE_VERSION = "v7";
const SHELL_CACHE = `uwumaps-shell-${CACHE_VERSION}`;
// Not versioned, so a new version of the app doesn't throw away what's been seen or saved.
const TILE_CACHE = "uwumaps-tiles";
const FONT_CACHE = "uwumaps-fonts";
const TILE_LIMIT = 1500;

const GLYPH_RANGES = [
  "0-255", "256-511", "512-767", "768-1023", "1024-1279", "1536-1791", "2304-2559", "2816-3071",
  "3328-3583", "3584-3839", "3840-4095", "4096-4351", "5888-6143", "7424-7679", "7680-7935", "8192-8447", "8448-8703",
];
const GLYPH_FONTS = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];

// Addresses the browser asks for. "/index.html" is absent because cleanUrls redirects it to "/" (rule 3).
const SHELL = [
  "/",
  "/style.css",
  "/script.js",
  "/manifest.json",
  "/favicon.ico",
  "/MAP-main.png",
  "/MAP-192.png",
  "/MAP-512.png",
  "/js/buildings.js",
  "/js/directions.js",
  "/js/icons.js",
  "/js/map.js",
  "/js/mrt-doors.js",
  "/js/nav.js",
  "/js/nearby.js",
  "/js/p2p.js",
  "/js/pack-list.js",
  "/js/pack-read.js",
  "/js/packs.js",
  "/js/places.js",
  "/js/route-client.js",
  "/js/route-core.js",
  "/js/route-worker.js",
  "/js/search.js",
  "/js/share.js",
  "/js/theme.js",
  "/js/transit.js",
  "/js/tray.js",
  "/js/ui.js",
  "/js/update.js",
  "/vendor/maplibre/maplibre-gl.mjs",
  "/vendor/maplibre/maplibre-gl-worker.mjs",
  "/vendor/maplibre/maplibre-gl.css",
  "/vendor/pmtiles/pmtiles.js",
  "/vendor/peerjs/peerjs.min.js",
  "/vendor/qrcode/qrcode.mjs",
  "/data/sg-rail.json",
  "/data/sg-bus-stops.json",
  "/data/sg-mrt-doors.json",
  "/data/my-transit.json",
  "/map/styles/liberty.json",
  "/map/styles/dark.json",
  "/map/sprites/ofm.json",
  "/map/sprites/ofm.png",
  "/map/sprites/ofm@2x.json",
  "/map/sprites/ofm@2x.png",
  ...GLYPH_FONTS.flatMap((font) => GLYPH_RANGES.map((r) => `/map/fonts/${encodeURIComponent(font)}/${r}.pbf`)),
];

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Jua&display=swap";

// The app's font, kept so it still draws offline. It's a nicety, so a failure here doesn't stop the
// app installing: the fallback font is perfectly readable.
async function cacheAppFont() {
  try {
    const cache = await caches.open(FONT_CACHE);
    const css = await fetch(FONT_CSS);
    if (!css.ok) return;
    await cache.put(FONT_CSS, css.clone());
    const urls = (await css.text()).match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || [];
    await Promise.all(urls.map(async (url) => {
      const res = await fetch(url);
      if (res.ok) await cache.put(url, res);
    }));
  } catch {
    // Picked up later by the fetch handler, the next time it's online.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([fillShell(), cacheAppFont()]));
  // No skipWaiting. The new worker waits until somebody accepts the update.
});

async function fillShell() {
  const cache = await caches.open(SHELL_CACHE);
  const failed = [];
  await Promise.all(SHELL.map(async (path) => {
    try {
      const response = await fetch(new Request(path, { cache: "reload" }));
      if (!response.ok) throw new Error(`${response.status}`);
      if (response.redirected) throw new Error("redirected");
      await cache.put(path, response);
    } catch (cause) {
      failed.push(`${path} (${cause?.message ?? cause})`);
    }
  }));
  if (failed.length) {
    console.warn(`[uwumaps] ${failed.length} of ${SHELL.length} precache entries failed. Offline is degraded, not off:\n  ${failed.join("\n  ")}`);
  }
}

// Old versions of the shell go. Saved packs, tiles and the font never do.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith("uwumaps-shell-") && k !== SHELL_CACHE) || /^uwumaps-v\d+$/.test(k)).map((k) => caches.delete(k)));
  })());
  // No clients.claim, for the same reason there is no skipWaiting above.
});

self.addEventListener("message", (event) => {
  const type = typeof event.data === "string" ? event.data : event.data?.type;

  if (type === "version") {
    event.source?.postMessage({ type: "version", version: CACHE_VERSION });
    return;
  }

  // The only place either of these is ever called.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

async function staticAsset(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  // Kept by the path alone, so a query string doesn't miss it.
  const hit = await cache.match(url.pathname);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(url.pathname, response.clone());
    return response;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

// The app is the only page, and reads the address itself. So a share link opens offline too, and can say
// it needs a connection rather than failing to load. Any other address goes to the network.
const APP_ROUTES = /^\/(?:(?:go|trip|eta|list)\/[^/]+\/?)?$/;

async function navigation(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const page = await cache.match("/");
  if (page && APP_ROUTES.test(url.pathname)) return page;
  try {
    return await fetch(request);
  } catch {
    // Offline and not a page this worker holds: the app is the only page.
    return page ?? Response.error();
  }
}

// Whether a same origin response may be kept. Every write to the shell after install goes through here.
function isCacheable(response) {
  if (!response || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  if (response.redirected) return false;
  const control = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  return !control.includes("no-store") && !control.includes("private");
}

let trimming = false;
async function trimTiles() {
  if (trimming) return;
  trimming = true;
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    const extra = keys.length - TILE_LIMIT;
    // Oldest first, and a few more than needed so this isn't run for every tile.
    if (extra > 0) await Promise.all(keys.slice(0, extra + 50).map((k) => cache.delete(k)));
  } finally {
    trimming = false;
  }
}

// Map tiles seen before stay available. An address names its version, so what's kept stays right.
async function tile(request, event) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) {
    event.waitUntil(cache.put(request, res.clone()).then(trimTiles));
  }
  return res;
}

async function appFont(request, event) {
  const cache = await caches.open(FONT_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok || res.type === "opaque") event.waitUntil(cache.put(request.url, res.clone()));
    return res;
  } catch {
    return new Response("", { status: 503 });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;
  const url = new URL(request.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(appFont(request, event));
    return;
  }
  if (url.hostname === "tiles.openfreemap.org") {
    event.respondWith(tile(request, event));
    return;
  }
  // Everything else off site is left alone: search, online routing, Overture's buildings over range
  // requests, analytics and ads. None of it is needed for the app to run.
  if (url.origin !== self.location.origin) return;
  // The API needs the network and says so itself. Pack downloads go straight through.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(request.mode === "navigate" ? navigation(request, url) : staticAsset(request, url));
});

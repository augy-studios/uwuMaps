// uwuMaps' service worker. Bump CACHE_VERSION on every change to anything listed below: the browser
// compares this file byte for byte, so that bump is what makes an update happen at all.
//
// A new version downloads and then waits. Nothing here calls skipWaiting() or clients.claim() except
// the message handler, so a person pressing Reload on the update bar is what brings it in
// (docs/update-bar-spec.md).

const CACHE_VERSION = "v6";
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

const SHELL = [
  "/",
  "/index.html",
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
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    await cacheAppFont();
  })());
});

// Old versions of the shell go. Saved packs, tiles and the font never do.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith("uwumaps-shell-") && k !== SHELL_CACHE) || /^uwumaps-v\d+$/.test(k)).map((k) => caches.delete(k)));
  })());
});

self.addEventListener("message", (event) => {
  const type = typeof event.data === "string" ? event.data : event.data?.type;

  // The only place either of these is ever called.
  if (type === "skip-waiting") {
    event.waitUntil(self.skipWaiting().then(() => self.clients.claim()));
  }
});

async function fromShell(request) {
  const url = new URL(request.url);
  const cache = await caches.open(SHELL_CACHE);
  // Precached by the full address, so a query string doesn't miss it.
  const hit = await cache.match(url.pathname);
  if (hit) return hit;
  return fetch(request);
}

// Every page of the site is the one app, which reads the address itself. So a share link opens
// offline too, and can say it needs a connection rather than failing to load.
async function appPage() {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match("/index.html");
  return hit || fetch("/index.html");
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
  const res = await fetch(request);
  if (res.ok || res.type === "opaque") event.waitUntil(cache.put(request.url, res.clone()));
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
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

  if (request.mode === "navigate") {
    event.respondWith(appPage());
    return;
  }
  event.respondWith(fromShell(request));
});

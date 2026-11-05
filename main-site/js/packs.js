// Offline packs: downloading them, keeping them, and answering the map's tile requests from them.
//
// A pack is four files, built by .github/workflows/offline-packs.yml and kept on a GitHub release.
// A page can't fetch those itself, since GitHub's downloads send no CORS headers, so /api/mappack
// hands them over in 4 MiB pieces, kept here in the Cache API. Pieces already kept are skipped, so a
// stopped download carries on where it was. A new build goes alongside the old one, which stays in use
// until the new one is complete: a pack never stops working because an update started.

import { ARCHIVES, PACKS, PART_SIZE } from "./pack-list.js";
import { archiveReader, packCacheName, partUrl, readPackMeta } from "./pack-read.js";
import { $, escapeHtml, formatBytes, isOnline, openModal, readJson, toast, writeJson } from "./ui.js";

const PARALLEL = 4;
const TRIES = 3;
const OVERTURE_KEY = "uwumaps.overtureRelease";
const TILEJSON_KEY = "uwumaps.ofmTiles";
// In step with the release Overture had when this was written. Only used until /api/overture answers.
const OVERTURE_FALLBACK = "2026-10-21.0";
const OFM_FALLBACK = "https://tiles.openfreemap.org/planet/20260930_001001_pt/{z}/{x}/{y}.pbf";

const installed = new Map(); // id -> { meta, base, buildings }
const downloads = new Map(); // id -> { done, total, abort, error }
let catalogue = null; // id -> { build, size, built, archives }

/* ---- reading a kept pack ---- */

class CacheSource {
  constructor(id, build, archive) {
    this.key = `${id}/${build}/${archive}`;
    this.read = archiveReader(id, build, archive);
  }

  getKey() {
    return this.key;
  }

  async getBytes(offset, length) {
    const bytes = await this.read(offset, length);
    return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }
}

function open(meta) {
  installed.set(meta.id, {
    meta,
    base: new window.pmtiles.PMTiles(new CacheSource(meta.id, meta.build, "base")),
    buildings: new window.pmtiles.PMTiles(new CacheSource(meta.id, meta.build, "buildings")),
  });
}

export async function initPacks() {
  await Promise.all(PACKS.map(async (p) => {
    const meta = await readPackMeta(p.id);
    if (meta?.complete) open(meta);
  }));
}

export const installedPacks = () => [...installed.values()].map((p) => p.meta);

const tileBounds = (z, x, y) => {
  const n = 2 ** z;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
};
const contains = (b, t) => t[0] >= b[0] && t[1] >= b[1] && t[2] <= b[2] && t[3] <= b[3];
const overlaps = (b, t) => t[0] < b[2] && t[2] > b[0] && t[1] < b[3] && t[3] > b[1];

export function packAt(lat, lon) {
  for (const p of installed.values()) {
    const [w, s, e, n] = p.meta.bounds;
    if (lon >= w && lon <= e && lat >= s && lat <= n) return p.meta;
  }
  return null;
}

// Tiles from whichever pack can answer. Whole tiles first: a tile a pack only partly covers is cut off
// at the pack's edge, so it's only used when there's nothing better.
async function fromPacks(archive, z, x, y, { whole }) {
  const t = tileBounds(z, x, y);
  for (const p of installed.values()) {
    if (!(whole ? contains : overlaps)(p.meta.bounds, t)) continue;
    try {
      const got = await p[archive].getZxy(z, x, y);
      if (got) return got.data;
    } catch (err) {
      console.warn(`Reading the ${p.meta.id} pack:`, err.message);
    }
  }
  return null;
}

function ofmTemplate() {
  return readJson(TILEJSON_KEY, null) || OFM_FALLBACK;
}

async function refreshOfmTemplate() {
  try {
    const res = await fetch("https://tiles.openfreemap.org/planet");
    if (res.ok) {
      const json = await res.json();
      if (json.tiles?.[0]) writeJson(TILEJSON_KEY, json.tiles[0]);
    }
  } catch {
    // The last one known still answers from what's been seen.
  }
}

let ofmReady = null;

export async function baseTile(z, x, y) {
  const inPack = await fromPacks("base", z, x, y, { whole: true });
  if (inPack) return inPack;
  ofmReady ||= refreshOfmTemplate();
  await ofmReady;
  try {
    const url = ofmTemplate().replace("{z}", z).replace("{x}", x).replace("{y}", y);
    const res = await fetch(url);
    if (res.ok) return await res.arrayBuffer();
  } catch {
    // Offline. The service worker has already tried what it's seen.
  }
  return fromPacks("base", z, x, y, { whole: false });
}

/* ---- Overture's buildings, online ---- */

let overture = null;

async function openOverture() {
  let release = readJson(OVERTURE_KEY, null) || OVERTURE_FALLBACK;
  try {
    const res = await fetch("/api/overture");
    if (res.ok) {
      const body = await res.json();
      if (body.release) {
        release = body.release;
        writeJson(OVERTURE_KEY, release);
      }
    }
  } catch {
    // The last known release.
  }
  return new window.pmtiles.PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`);
}

// The promise is what's kept: every tile asks at once, and the lookup should only happen once.
const overtureArchive = () => (overture ||= openOverture());

export async function buildingTile(z, x, y) {
  const inPack = await fromPacks("buildings", z, x, y, { whole: true });
  if (inPack) return inPack;
  if (!isOnline()) return fromPacks("buildings", z, x, y, { whole: false });
  try {
    const archive = await overtureArchive();
    const got = await archive.getZxy(z, x, y);
    if (got) return got.data;
  } catch (err) {
    console.debug("Overture:", err.message);
    // A release can be retired under a page left open: look it up again next time.
    overture = null;
  }
  return fromPacks("buildings", z, x, y, { whole: false });
}

/* ---- downloading ---- */

async function fetchCatalogue() {
  if (!isOnline()) return catalogue;
  try {
    const res = await fetch("/api/mappack");
    if (res.ok) catalogue = (await res.json()).packs;
  } catch {
    // Listed without sizes.
  }
  return catalogue;
}

class StartAgain extends Error {}

async function fetchPart(id, build, archive, n, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`/api/mappack?id=${encodeURIComponent(id)}&archive=${archive}&part=${n}&v=${build}`, { signal });
      if (res.status === 409) throw new StartAgain();
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (err instanceof StartAgain || err.name === "AbortError" || attempt >= TRIES) throw err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}

async function download(id) {
  const info = catalogue?.[id];
  if (!info) throw new Error("That map isn't available yet");

  const state = { done: 0, total: info.size, abort: new AbortController(), error: null };
  downloads.set(id, state);
  renderPacks();

  const { signal } = state.abort;
  try {
    // Asks the browser to keep this: a saved map evicted while travelling is the worst time to find out.
    try {
      await navigator.storage?.persist?.();
    } catch {
      // Kept on a best effort basis instead.
    }
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < info.size) {
      throw new Error(`Not enough storage: it needs ${formatBytes(info.size)}`);
    }

    const cache = await caches.open(packCacheName(id));
    const jobs = [];
    for (const archive of ARCHIVES) {
      const a = info.archives[archive];
      if (!a) throw new Error(`The map is missing its ${archive} file`);
      const parts = Math.ceil(a.size / PART_SIZE);
      for (let n = 0; n < parts; n++) jobs.push({ archive, n, bytes: n === parts - 1 ? a.size - n * PART_SIZE : PART_SIZE });
    }

    let next = 0;
    let lastDraw = 0;
    const draw = () => {
      const now = Date.now();
      if (now - lastDraw < 200) return;
      lastDraw = now;
      renderProgress(id);
    };
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        const url = partUrl(id, info.build, job.archive, job.n);
        if (!(await cache.match(url))) {
          const bytes = await fetchPart(id, info.build, job.archive, job.n, signal);
          // Length is checked rather than trusted: a short piece would corrupt the archive for good.
          if (bytes.byteLength !== job.bytes) throw new Error("A piece of the map came back the wrong size");
          await cache.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
        }
        state.done += job.bytes;
        draw();
      }
    }));

    const meta = { id, build: info.build, built: info.built, bounds: PACKS.find((p) => p.id === id).bounds, size: info.size, archives: info.archives, complete: true };
    await cache.put(`/packs/${id}.json`, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
    open(meta);

    // The older build, now that this one is complete.
    for (const req of await cache.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith(`/packs/${id}/`) && !path.startsWith(`/packs/${id}/${info.build}/`)) await cache.delete(req);
    }

    downloads.delete(id);
    toast(`${PACKS.find((p) => p.id === id).name} is ready to use offline`);
    window.dispatchEvent(new CustomEvent("uwu:packs"));
  } catch (err) {
    if (err instanceof StartAgain) {
      // Rebuilt since this started. Look up the new build and go again, once per click of the button.
      downloads.delete(id);
      await fetchCatalogue();
      toast("That map was just rebuilt. Press Download to start the new one.");
    } else if (err.name === "AbortError") {
      downloads.delete(id);
    } else {
      state.error = err.message;
      state.abort = null;
    }
  }
  renderPacks();
}

export async function removePack(id) {
  await caches.delete(packCacheName(id));
  installed.delete(id);
  window.dispatchEvent(new CustomEvent("uwu:packs"));
  renderPacks();
}

/* ---- the sheet ---- */

function renderProgress(id) {
  const state = downloads.get(id);
  const row = document.querySelector(`[data-pack="${id}"]`);
  if (!row || !state) return;
  const bar = row.querySelector("progress");
  const text = row.querySelector(".pack-sub");
  if (bar) bar.value = state.total ? state.done / state.total : 0;
  if (text) text.textContent = `${formatBytes(state.done)} of ${formatBytes(state.total)}`;
}

function packRow(p) {
  const meta = installed.get(p.id)?.meta;
  const info = catalogue?.[p.id];
  const state = downloads.get(p.id);
  const update = meta && info && info.build !== meta.build;
  let sub = "";
  let actions = "";

  if (state && !state.error) {
    sub = `${formatBytes(state.done)} of ${formatBytes(state.total)}`;
    actions = `<button class="btn" type="button" data-pack-stop="${p.id}">Stop</button>`;
  } else if (state?.error) {
    sub = state.error;
    actions = `<button class="btn btn-primary" type="button" data-pack-get="${p.id}">Try again</button>`;
  } else if (meta) {
    sub = update ? `Saved. A newer map is ready, ${formatBytes(info.size)}` : `Saved, ${formatBytes(meta.size)}`;
    actions = `${update ? `<button class="btn btn-primary" type="button" data-pack-get="${p.id}">Update</button>` : ""}
      <button class="icon-btn small" type="button" data-pack-remove="${p.id}" aria-label="Delete ${escapeHtml(p.name)}" title="Delete"><span data-icon="trash"></span></button>`;
  } else if (info) {
    sub = formatBytes(info.size);
    actions = `<button class="btn" type="button" data-pack-get="${p.id}"><span data-icon="download"></span>Download</button>`;
  } else {
    sub = isOnline() ? "Not ready yet" : "Connect to download";
  }

  return `
    <div class="pack" data-pack="${p.id}">
      <div class="pack-top">
        <div>
          <div class="pack-name">${escapeHtml(p.name)}</div>
          <div class="pack-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="row">${actions}</div>
      </div>
      ${state && !state.error ? `<progress max="1" value="${state.total ? state.done / state.total : 0}" aria-label="Downloading ${escapeHtml(p.name)}"></progress>` : ""}
    </div>`;
}

function renderPacks() {
  const list = $("#packsList");
  if (!list) return;
  const groups = new Map();
  for (const p of PACKS) {
    if (!groups.has(p.region)) groups.set(p.region, []);
    groups.get(p.region).push(p);
  }
  list.innerHTML = [...groups].map(([region, packs]) => `<p class="pack-group">${escapeHtml(region)}</p>${packs.map(packRow).join("")}`).join("");
  window.dispatchEvent(new CustomEvent("uwu:hydrate", { detail: list }));
}

async function renderStorage() {
  const el = $("#packsStorage");
  try {
    const e = await navigator.storage?.estimate?.();
    el.textContent = e?.quota ? `Using ${formatBytes(e.usage || 0)} of ${formatBytes(e.quota)} available here.` : "";
  } catch {
    el.textContent = "";
  }
}

export function openPacks() {
  openModal("packsModal");
  renderPacks();
  renderStorage();
  fetchCatalogue().then(renderPacks);
}

export function wirePacks() {
  $("#packsList").addEventListener("click", (e) => {
    const get = e.target.closest("[data-pack-get]");
    if (get) {
      if (!isOnline()) {
        toast("Downloading a map needs a connection", { error: true });
        return;
      }
      download(get.dataset.packGet);
      return;
    }
    const stop = e.target.closest("[data-pack-stop]");
    if (stop) {
      downloads.get(stop.dataset.packStop)?.abort?.abort();
      return;
    }
    const remove = e.target.closest("[data-pack-remove]");
    if (remove) removePack(remove.dataset.packRemove).then(renderStorage);
  });
}

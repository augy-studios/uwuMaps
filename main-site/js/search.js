// Finding places: saved places and public transport first, then the search files of saved packs, then
// Photon when there's a connection. Works with none of the network parts present.

import { installedPacks } from "./packs.js";
import { archiveReader } from "./pack-read.js";
import { gunzip } from "./route-core.js";
import { searchTransit } from "./transit.js";
import { escapeHtml, isOnline, metresBetween } from "./ui.js";

const PHOTON = "https://photon.komoot.io/api/";
const headers = new Map(); // pack id -> { read, dataStart, dir }

// In step with normalise() in tools/packs/compile-graph.mjs.
const normalise = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const words = (s) => normalise(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

async function indexOf(pack) {
  const key = `${pack.id}/${pack.build}`;
  if (headers.has(key)) return headers.get(key);
  const read = archiveReader(pack.id, pack.build, "search");
  const head = await read(0, 12);
  const len = new DataView(head.buffer, head.byteOffset, 12).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(await gunzip(await read(12, len))));
  const index = { read, dataStart: 12 + len, dir: header.dir };
  headers.set(key, index);
  return index;
}

const KIND_LABEL = ["Place", "Area", "Place of interest", "Stop", "Street"];

async function searchPack(pack, query, near) {
  const q = words(query);
  if (!q.length) return [];
  const longest = q.reduce((a, b) => (b.length > a.length ? b : a));
  const bucket = CJK.test(longest) ? [...longest][0] : [...longest].slice(0, 2).join("");
  const { read, dataStart, dir } = await indexOf(pack);
  const entry = dir[bucket];
  if (!entry) return [];

  const text = new TextDecoder().decode(await gunzip(await read(dataStart + entry[0], entry[1])));
  const results = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [name, lat, lon, kind, alias] = line.split("\t");
    const hay = normalise(`${name} ${alias || ""}`);
    if (!q.every((w) => hay.includes(w))) continue;
    const la = Number(lat);
    const lo = Number(lon);
    const exact = normalise(name) === q.join(" ");
    const prefix = normalise(name).startsWith(q[0]);
    const dist = near ? metresBetween(near.lat, near.lon, la, lo) : 0;
    // Close matches beat kinds beat distance, in round numbers so one can't quite swamp the others.
    const score = (exact ? 0 : prefix ? 1000 : 2000) + Number(kind) * 200 + Math.min(600, dist / 500);
    results.push({ name, sub: KIND_LABEL[Number(kind)] || "Place", lat: la, lon: lo, score, source: "pack" });
  }
  return results.sort((a, b) => a.score - b.score).slice(0, 8);
}

async function searchOnline(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: "8" });
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lon));
  }
  const res = await fetch(`${PHOTON}?${params}`, { signal });
  if (!res.ok) throw new Error(`Search answered ${res.status}`);
  const body = await res.json();
  return (body.features || []).map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    const sub = [p.street, p.city, p.state, p.country].filter((v, i, a) => v && v !== p.name && a.indexOf(v) === i).join(", ");
    return { name: p.name || p.street || sub, sub, lat, lon, source: "online" };
  }).filter((r) => r.name);
}

// Answers places matching a query, best first.
export async function findPlaces(query, { near, signal, saved = [] } = {}) {
  const q = normalise(query.trim());
  const out = [];
  for (const p of saved) if (normalise(p.name).includes(q)) out.push({ ...p, sub: "Saved", source: "saved" });
  out.push(...await searchTransit(query));

  const packs = installedPacks();
  const fromPacks = await Promise.allSettled(packs.map((p) => searchPack(p, query, near)));
  const local = fromPacks.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => a.score - b.score);
  out.push(...local.slice(0, 8));

  if (isOnline()) {
    try {
      out.push(...await searchOnline(query, near, signal));
    } catch (err) {
      if (err.name === "AbortError") throw err;
      // Whatever was found locally still stands.
    }
  }

  // The same place from two sources shows once.
  const seen = new Set();
  return out.filter((r) => {
    const key = `${normalise(r.name)}|${r.lat.toFixed(3)}|${r.lon.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

export function renderSuggestions(list, results, emptyText) {
  list.innerHTML = results.length
    ? results.map((r, i) => `<li><button type="button" data-result="${i}"><span data-icon="${r.source === "saved" ? "bookmark" : "pin"}"></span><span><span class="s-name">${escapeHtml(r.name)}</span>${r.sub ? `<span class="s-sub">${escapeHtml(r.sub)}</span>` : ""}</span></button></li>`).join("")
    : `<li class="s-empty">${escapeHtml(emptyText)}</li>`;
  list.classList.remove("hidden");
}

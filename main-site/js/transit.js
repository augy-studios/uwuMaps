// The map's layers and the Layers sheet: everything somebody can turn on and off.
//
// Singapore: MRT and LRT lines, stations and their exits (sgraildata, as SG Bus Timings vendors it),
// LTA's bus stops, and on a station's card, which train doors stop nearest the lifts, stairs and
// escalators. To get to a station or stop by public transport, the card hands over to SG Bus Timings.
//
// Malaysia: Rapid KL and KTMB lines and stations and bus stops (data.gov.my's GTFS), and where trains
// and buses are right now (/api/my-live), with the card handing over to the Malaysia site.
//
// The static data ships with the app, so those layers work offline. Live vehicles need a connection.

import { addBuildings, setBuildingsVisible } from "./buildings.js";
import { getMap, onStyle } from "./map.js";
import { doorsHtml, wireDoors } from "./mrt-doors.js";
import { getStoredMode } from "./theme.js";
import { $, escapeHtml, isOnline, readJson, writeJson } from "./ui.js";

const STATE_KEY = "uwumaps.layers";
const LIVE_REFRESH_MS = 20000;
const FONT = ["Noto Sans Regular"];

const SGBUS = "https://sgbus.uwuapps.org";
const MALAYSIA = "https://malaysia.uwuapps.org";

// What Singapore and Malaysia's layers are worth loading for, west, south, east, north.
const SG_AREA = [103.5, 1.1, 104.2, 1.55];
const MY_AREA = [99.0, 0.7, 119.5, 7.6];
// Singapore, short of the Johor shore. A view wholly inside this has nothing of Malaysia's to show.
const SG_ONLY = [103.59, 1.15, 104.1, 1.46];

export const LAYERS = [
  { id: "buildings", group: "Map", label: "3D buildings", on: true },
  { id: "saved", group: "Map", label: "Saved places", on: true },
  { id: "sg-lines", group: "Singapore", label: "MRT and LRT lines", on: true },
  { id: "sg-stations", group: "Singapore", label: "Train stations", on: true },
  { id: "sg-exits", group: "Singapore", label: "Station exits", on: true },
  { id: "sg-stops", group: "Singapore", label: "Bus stops", on: true },
  { id: "my-lines", group: "Malaysia", label: "Train lines", on: true },
  { id: "my-stations", group: "Malaysia", label: "Train stations", on: true },
  { id: "my-stops", group: "Malaysia", label: "Bus stops", on: true },
  { id: "my-live-trains", group: "Malaysia", label: "Live trains", on: true, live: true },
  { id: "my-live-buses", group: "Malaysia", label: "Live buses", on: true, live: true },
];

const saved = readJson(STATE_KEY, {});
export const isOn = (id) => saved[id] ?? LAYERS.find((l) => l.id === id).on;

// Each layer's map layers.
const MAP_LAYERS = {
  saved: ["saved"],
  "sg-lines": ["sg-lines"],
  "sg-stations": ["sg-stations", "sg-station-labels"],
  "sg-exits": ["sg-exits"],
  "sg-stops": ["sg-stops", "sg-stop-labels"],
  "my-lines": ["my-lines"],
  "my-stations": ["my-stations", "my-station-labels"],
  "my-stops": ["my-stops", "my-stop-labels"],
  "my-live-trains": ["my-live-trains", "my-live-trains-arrow"],
  "my-live-buses": ["my-live-buses", "my-live-buses-arrow"],
};

/* ---- the shipped data ---- */

const cache = {};
function dataset(name) {
  cache[name] ||= fetch(`/data/${name}.json`).then((r) => {
    if (!r.ok) throw new Error(`/data/${name}.json answered ${r.status}`);
    return r.json();
  }).catch((err) => {
    delete cache[name];
    throw err;
  });
  return cache[name];
}

const fc = (features) => ({ type: "FeatureCollection", features });
const pointFeature = (lon, lat, properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties });
const EMPTY = fc([]);

const lineOfCode = (code) => String(code).replace(/\d.*$/, "");

async function sgRailData() {
  const rail = await dataset("sg-rail");
  const colour = Object.fromEntries(rail.lines.map((l) => [l.code, l.color]));
  const lines = [];
  for (const [code, paths] of Object.entries(rail.tracks)) {
    for (const path of paths) {
      lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: path.map(([la, lo]) => [lo, la]) }, properties: { color: colour[code] || "#888888", code } });
    }
  }
  const stations = rail.stations.map((s) => pointFeature(s.lng, s.lat, {
    kind: "sg-station",
    name: s.name,
    codes: s.codes.join(" "),
    color: colour[lineOfCode(s.codes[0])] || "#888888",
  }));
  const exits = rail.stations.flatMap((s) => (s.exits || []).map(([la, lo]) => pointFeature(lo, la, { kind: "sg-exit", name: `${s.name} exit`, color: colour[lineOfCode(s.codes[0])] || "#888888" })));
  return { lines: fc(lines), stations: fc(stations), exits: fc(exits), rail };
}

async function sgStopData() {
  const stops = await dataset("sg-bus-stops");
  return fc(stops.map((s) => pointFeature(s.lo, s.la, { kind: "sg-stop", name: s.n, code: s.c, road: s.r })));
}

async function myData() {
  const d = await dataset("my-transit");
  return {
    lines: fc(d.lines.map((l) => ({ type: "Feature", geometry: { type: "LineString", coordinates: l.path.map(([la, lo]) => [lo, la]) }, properties: { color: l.color, name: l.name } }))),
    stations: fc(d.stations.map((s) => pointFeature(s.lng, s.lat, { kind: "my-station", name: s.name, agency: s.agency, lines: s.lines.join(", "), color: s.color }))),
    stops: fc(d.busStops.map((s) => pointFeature(s.lo, s.la, { kind: "my-stop", name: s.n, agency: s.a }))),
  };
}

/* ---- drawing ---- */

function addSources(map) {
  for (const id of ["sg-lines", "sg-stations", "sg-exits", "sg-stops", "my-lines", "my-stations", "my-stops", "my-live-trains", "my-live-buses"]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: lastData[id] || EMPTY });
  }
}

const lastData = {};
function setData(id, data) {
  lastData[id] = data;
  getMap()?.getSource(id)?.setData(data);
}

function arrowImage(map) {
  if (map.hasImage("uwu-arrow")) return;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  c.fillStyle = "#ffffff";
  c.beginPath();
  c.moveTo(16, 3);
  c.lineTo(25, 22);
  c.lineTo(16, 17);
  c.lineTo(7, 22);
  c.closePath();
  c.fill();
  map.addImage("uwu-arrow", c.getImageData(0, 0, size, size), { pixelRatio: 2 });
}

function addLayers(map) {
  const dark = getStoredMode() === "dark";
  const halo = dark ? "#0c100e" : "#ffffff";
  const ink = dark ? "#eef2ef" : "#121815";
  const dotFill = dark ? "#121815" : "#ffffff";
  const vis = (id) => (isOn(id) ? "visible" : "none");
  const add = (spec) => {
    if (!map.getLayer(spec.id)) map.addLayer(spec);
  };
  const label = (id, layerId, source, minzoom, size = 11) => add({
    id, type: "symbol", source, minzoom,
    layout: { visibility: vis(layerId), "text-field": ["get", "name"], "text-font": FONT, "text-size": size, "text-offset": [0, 1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": ink, "text-halo-color": halo, "text-halo-width": 1.4 },
  });

  add({ id: "sg-lines", type: "line", source: "sg-lines", minzoom: 9, layout: { visibility: vis("sg-lines"), "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 16, 5] } });
  add({ id: "my-lines", type: "line", source: "my-lines", minzoom: 6, layout: { visibility: vis("my-lines"), "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.2, 16, 5] } });

  add({ id: "sg-stops", type: "circle", source: "sg-stops", minzoom: 14.5, layout: { visibility: vis("sg-stops") }, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 14.5, 2.5, 18, 6], "circle-color": "#2e9e5b", "circle-stroke-color": dotFill, "circle-stroke-width": 1.2 } });
  label("sg-stop-labels", "sg-stops", "sg-stops", 17);
  add({ id: "my-stops", type: "circle", source: "my-stops", minzoom: 14.5, layout: { visibility: vis("my-stops") }, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 14.5, 2.5, 18, 6], "circle-color": "#2e9e5b", "circle-stroke-color": dotFill, "circle-stroke-width": 1.2 } });
  label("my-stop-labels", "my-stops", "my-stops", 17);

  add({ id: "sg-exits", type: "circle", source: "sg-exits", minzoom: 16, layout: { visibility: vis("sg-exits") }, paint: { "circle-radius": 3.5, "circle-color": ["get", "color"], "circle-stroke-color": dotFill, "circle-stroke-width": 1 } });

  add({ id: "sg-stations", type: "circle", source: "sg-stations", minzoom: 10, layout: { visibility: vis("sg-stations") }, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 7], "circle-color": dotFill, "circle-stroke-color": ["get", "color"], "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 3] } });
  label("sg-station-labels", "sg-stations", "sg-stations", 13, 12);
  add({ id: "my-stations", type: "circle", source: "my-stations", minzoom: 8, layout: { visibility: vis("my-stations") }, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 7], "circle-color": dotFill, "circle-stroke-color": ["get", "color"], "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 3] } });
  label("my-station-labels", "my-stations", "my-stations", 12, 12);

  arrowImage(map);
  const live = (id, colour, minzoom) => {
    add({ id, type: "circle", source: id, minzoom, layout: { visibility: vis(id) }, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 10], "circle-color": colour, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } });
    add({ id: `${id}-arrow`, type: "symbol", source: id, minzoom: Math.max(minzoom, 11), filter: ["has", "bearing"], layout: { visibility: vis(id), "icon-image": "uwu-arrow", "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 16, 1], "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map", "icon-allow-overlap": true } });
  };
  live("my-live-trains", "#1b5e9f", 6);
  live("my-live-buses", "#d9480f", 9);
}

function applyVisibility(map) {
  for (const [id, ids] of Object.entries(MAP_LAYERS)) {
    for (const layerId of ids) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", isOn(id) ? "visible" : "none");
    }
  }
  setBuildingsVisible(map, isOn("buildings"));
}

/* ---- loading what's on, where it's wanted ---- */

function viewTouches(map, area) {
  const b = map.getBounds();
  return b.getWest() < area[2] && b.getEast() > area[0] && b.getSouth() < area[3] && b.getNorth() > area[1];
}

function viewTouchesMalaysia(map) {
  if (!viewTouches(map, MY_AREA)) return false;
  const b = map.getBounds();
  return !(b.getWest() >= SG_ONLY[0] && b.getEast() <= SG_ONLY[2] && b.getSouth() >= SG_ONLY[1] && b.getNorth() <= SG_ONLY[3]);
}

const loaded = new Set();

async function loadVisible() {
  const map = getMap();
  if (!map) return;
  const inSg = viewTouches(map, SG_AREA);
  const inMy = viewTouchesMalaysia(map);
  try {
    if (inSg && !loaded.has("sg") && (isOn("sg-lines") || isOn("sg-stations") || isOn("sg-exits"))) {
      loaded.add("sg");
      const d = await sgRailData();
      setData("sg-lines", d.lines);
      setData("sg-stations", d.stations);
      setData("sg-exits", d.exits);
    }
    if (inSg && !loaded.has("sg-stops") && isOn("sg-stops") && map.getZoom() >= 13) {
      loaded.add("sg-stops");
      setData("sg-stops", await sgStopData());
    }
    if (inMy && !loaded.has("my") && (isOn("my-lines") || isOn("my-stations") || (isOn("my-stops") && map.getZoom() >= 13))) {
      loaded.add("my");
      const d = await myData();
      setData("my-lines", d.lines);
      setData("my-stations", d.stations);
      setData("my-stops", d.stops);
    }
  } catch (err) {
    console.warn("Transport layers:", err.message);
    loaded.clear();
  }
  refreshLive();
}

/* ---- live vehicles ---- */

// Which feeds to ask, by what's on screen. Each answers for its own part of the country.
const BUS_FEEDS = [
  { feed: "rapid-bus-kl", area: [100.9, 2.5, 102.2, 3.7] },
  { feed: "rapid-bus-mrtfeeder", area: [101.2, 2.7, 102.0, 3.5] },
  { feed: "rapid-bus-penang", area: [99.9, 4.8, 100.9, 6.0] },
  { feed: "mybas-johor", area: [103.3, 1.2, 104.3, 2.0] },
];

let liveTimer = null;
let liveStatus = "";

async function fetchFeed(feed) {
  const res = await fetch(`/api/my-live?feed=${feed}`);
  if (!res.ok) throw new Error(`The live feed answered ${res.status}`);
  return res.json();
}

const vehicleFeatures = (body, kind) => body.vehicles.map((v) => pointFeature(v.lon, v.lat, {
  kind,
  id: v.id || "",
  route: v.route || "",
  at: v.at || 0,
  feed: body.feed,
  ...(v.bearing != null && { bearing: v.bearing }),
}));

async function refreshLive() {
  clearTimeout(liveTimer);
  const map = getMap();
  if (!map) return;
  const wantTrains = isOn("my-live-trains");
  const wantBuses = isOn("my-live-buses");
  const inMy = viewTouchesMalaysia(map);

  if ((wantTrains || wantBuses) && inMy && isOnline() && document.visibilityState === "visible") {
    const jobs = [];
    if (wantTrains && map.getZoom() >= 6) jobs.push(fetchFeed("ktmb").then((b) => setData("my-live-trains", fc(vehicleFeatures(b, "my-live-train")))));
    if (wantBuses && map.getZoom() >= 9) {
      const feeds = BUS_FEEDS.filter((f) => viewTouches(map, f.area));
      if (feeds.length) {
        jobs.push(Promise.allSettled(feeds.map((f) => fetchFeed(f.feed))).then((results) => {
          const features = results.flatMap((r) => (r.status === "fulfilled" ? vehicleFeatures(r.value, "my-live-bus") : []));
          setData("my-live-buses", fc(features));
          if (results.every((r) => r.status === "rejected")) throw results[0].reason;
        }));
      }
    }
    const results = await Promise.allSettled(jobs);
    liveStatus = results.some((r) => r.status === "rejected") ? "Can't reach the live feed right now." : "";
  } else if (!isOnline()) {
    liveStatus = "Live vehicles need a connection.";
    setData("my-live-trains", EMPTY);
    setData("my-live-buses", EMPTY);
  } else {
    liveStatus = "";
  }
  renderLiveStatus();
  // One timer, re-armed each round, and asleep with the tab: see the visibility listener below.
  liveTimer = setTimeout(refreshLive, LIVE_REFRESH_MS);
}

function renderLiveStatus() {
  const el = $("#layersLiveNote");
  if (el) {
    el.textContent = liveStatus;
    el.hidden = !liveStatus;
  }
}

/* ---- the cards ---- */

const CLICK_LAYERS = ["my-live-trains", "my-live-buses", "sg-stations", "my-stations", "sg-exits", "sg-stops", "my-stops"];

const sgTransitLink = (lat, lon, name) => `${SGBUS}/#nav/here/${lat.toFixed(5)},${lon.toFixed(5)}~${encodeURIComponent(name).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

// What the card a tapped marker opens says. Answers null for what it isn't.
async function cardFor(feature) {
  const p = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  const base = { lat, lon, name: p.name };
  switch (p.kind) {
    case "sg-station": {
      const codes = p.codes.split(" ");
      let detail = "";
      try {
        detail = doorsHtml(codes, (await dataset("sg-mrt-doors")).platforms || []);
      } catch {
        // The station card still works without them.
      }
      return { ...base, sub: `${p.codes.replace(/ /g, " · ")} · Train station`, detail, links: [{ href: sgTransitLink(lat, lon, `${p.name} MRT`), text: "Go by public transport", icon: "train" }] };
    }
    case "sg-exit":
      return { ...base, sub: "Station exit", links: [{ href: sgTransitLink(lat, lon, p.name), text: "Go by public transport", icon: "train" }] };
    case "sg-stop":
      return {
        ...base,
        sub: `${p.code} · ${p.road} · Bus stop`,
        links: [
          { href: sgTransitLink(lat, lon, p.name), text: "Go by public transport", icon: "train" },
          { href: `${SGBUS}/#${encodeURIComponent(p.code)}`, text: "Bus timings", icon: "bus" },
        ],
      };
    case "my-station":
      return { ...base, sub: `${p.agency} · ${p.lines}`, links: [{ href: `${MALAYSIA}/trains/`, text: "Train schedules", icon: "train" }] };
    case "my-stop":
      return { ...base, sub: `${p.agency} · Bus stop`, links: [{ href: `${MALAYSIA}/bus/`, text: "Bus routes", icon: "bus" }] };
    case "my-live-train":
    case "my-live-bus": {
      const isTrain = p.kind === "my-live-train";
      const what = isTrain ? "Train" : "Bus";
      const when = p.at ? `Seen ${Math.max(0, Math.round((Date.now() / 1000 - p.at) / 60))} min ago` : "";
      return {
        ...base,
        name: `${what}${p.route ? ` ${p.route}` : ""}`,
        sub: [p.id && `Vehicle ${p.id}`, when].filter(Boolean).join(" · "),
        links: [{ href: `${MALAYSIA}/${isTrain ? "trains" : "bus"}/`, text: `Live ${isTrain ? "trains" : "buses"}`, icon: isTrain ? "train" : "bus" }],
      };
    }
    default:
      return null;
  }
}

// Answers the card for whatever transport marker is at this point, or null.
export async function transitCardAt(point) {
  const map = getMap();
  const layers = CLICK_LAYERS.filter((id) => map.getLayer(id) && isOn(id));
  if (!layers.length) return null;
  const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
  const hit = map.queryRenderedFeatures(box, { layers })[0];
  return hit ? cardFor({ properties: hit.properties, geometry: hit.geometry }) : null;
}

export const transitLayerIds = () => CLICK_LAYERS;

/* ---- searching the shipped data ---- */

const fold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// Stations and stops with the shape search results take, nearest the query's words first.
export async function searchTransit(query) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const map = getMap();
  const out = [];
  const add = (name, sub, lat, lon, rank) => out.push({ name, sub, lat, lon, rank, source: "transit" });
  try {
    if (viewTouches(map, SG_AREA) || !map) {
      const rail = await dataset("sg-rail");
      for (const s of rail.stations) {
        if (fold(s.name).includes(q) || s.codes.some((c) => fold(c) === q)) add(s.name, `${s.codes.join(" · ")} · Train station`, s.lat, s.lng, 0);
      }
      const stops = await dataset("sg-bus-stops");
      for (const s of stops) {
        if (s.c === q || fold(s.n).includes(q)) add(s.n, `${s.c} · ${s.r} · Bus stop`, s.la, s.lo, s.c === q ? 0 : 2);
      }
    }
    if (viewTouchesMalaysia(map)) {
      const d = await dataset("my-transit");
      for (const s of d.stations) if (fold(s.name).includes(q)) add(s.name, `${s.agency} · Train station`, s.lat, s.lng, 1);
    }
  } catch {
    // Search still has its other sources.
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 8);
}

/* ---- the sheet ---- */

function renderLayersSheet() {
  const body = $("#layersList");
  const groups = new Map();
  for (const l of LAYERS) {
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group).push(l);
  }
  body.innerHTML = [...groups].map(([group, layers]) => `
    <p class="modal-section-label">${escapeHtml(group)}</p>
    ${layers.map((l) => `
      <label class="layer-row">
        <span>${escapeHtml(l.label)}</span>
        <input type="checkbox" class="switch" data-layer="${l.id}" ${isOn(l.id) ? "checked" : ""}>
      </label>`).join("")}`).join("");
  renderLiveStatus();
}

export function openLayers() {
  renderLayersSheet();
}

export function wireLayers() {
  wireDoors();
  $("#layersList").addEventListener("change", (e) => {
    const box = e.target.closest("[data-layer]");
    if (!box) return;
    saved[box.dataset.layer] = box.checked;
    writeJson(STATE_KEY, saved);
    applyVisibility(getMap());
    loadVisible();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshLive();
    else clearTimeout(liveTimer);
  });
  window.addEventListener("online", refreshLive);
  window.addEventListener("offline", refreshLive);
}

export function initTransit() {
  onStyle((map) => {
    addBuildings(map, getStoredMode() === "dark" ? "dark" : "light", isOn("buildings"));
    addSources(map);
    addLayers(map);
    applyVisibility(map);
  });
  const map = getMap();
  map.on("moveend", loadVisible);
  map.on("load", loadVisible);
  const pointer = () => {
    map.getCanvas().style.cursor = "pointer";
  };
  const plain = () => {
    map.getCanvas().style.cursor = "";
  };
  for (const id of CLICK_LAYERS) {
    map.on("mouseenter", id, pointer);
    map.on("mouseleave", id, plain);
  }
}

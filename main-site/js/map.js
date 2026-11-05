// The map: MapLibre over OpenFreeMap's styles, with its tiles coming from a saved pack where there is
// one and from the network otherwise. Styles, fonts and icons ship with the app, so it draws offline.

import * as maplibregl from "/vendor/maplibre/maplibre-gl.mjs";
import { baseTile, buildingTile } from "./packs.js";
import { getStoredMode } from "./theme.js";
import { readJson, writeJson } from "./ui.js";

maplibregl.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

const VIEW_KEY = "uwumaps.view";
// Marina Bay: somewhere the 3D buildings show what they can do on a first visit.
const DEFAULT_VIEW = { center: [103.8565, 1.2835], zoom: 15.3, pitch: 58, bearing: -20 };
const BASE_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

let map = null;
let currentStyle = null;
const styleCallbacks = [];

export const getMap = () => map;
export { maplibregl };

// Called now if the style's in, and again each time the style changes, since changing it clears
// everything the app has added.
export function onStyle(callback) {
  styleCallbacks.push(callback);
  if (map?.isStyleLoaded() && map.getSource("openmaptiles")) callback(map);
}

const styleName = () => (getStoredMode() === "dark" ? "dark" : "liberty");

async function loadStyle(name) {
  const res = await fetch(`/map/styles/${name}.json`);
  const style = await res.json();
  style.sprite = `${location.origin}/map/sprites/ofm`;
  style.glyphs = `${location.origin}/map/fonts/{fontstack}/{range}.pbf`;
  style.sources = {
    openmaptiles: {
      type: "vector",
      tiles: ["uwu://base/{z}/{x}/{y}"],
      minzoom: 0,
      maxzoom: 14,
      attribution: BASE_ATTRIBUTION,
    },
  };
  // The shaded relief is online only and adds little, and the plain 3D buildings make way for ours.
  style.layers = style.layers.filter((l) => (!l.source || l.source === "openmaptiles") && l.id !== "building-3d" && l.type !== "raster");
  return style;
}

export async function refreshStyle() {
  if (!map) return;
  const name = styleName();
  if (name === currentStyle) return;
  currentStyle = name;
  map.setStyle(await loadStyle(name), { diff: false });
}

function registerProtocol() {
  maplibregl.addProtocol("uwu", async (params) => {
    const m = /^uwu:\/\/(base|buildings)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error(`Unknown tile address ${params.url}`);
    const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
    const data = m[1] === "base" ? await baseTile(z, x, y) : await buildingTile(z, x, y);
    // Nothing there, or nothing reachable: an empty tile rather than an error, which would retry.
    return { data: data || new ArrayBuffer(0) };
  });
}

export async function initMap() {
  registerProtocol();
  const saved = readJson(VIEW_KEY, null);
  currentStyle = styleName();
  map = new maplibregl.Map({
    container: "map",
    style: await loadStyle(currentStyle),
    ...(saved || DEFAULT_VIEW),
    // Tilting from 58 to 75 degrees nearly halved the frame rate, with far more tiles in view at the horizon.
    maxPitch: 60,
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: false },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

  map.on("style.load", () => {
    for (const callback of styleCallbacks) callback(map);
  });
  if (window.innerWidth <= 640) {
    map.once("load", () => {
      document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      document.querySelector(".maplibregl-ctrl-attrib")?.removeAttribute("open");
    });
  }
  // A tile the network couldn't answer isn't worth troubling anybody about.
  map.on("error", (e) => {
    if (e?.error?.status !== 404) console.debug("map:", e?.error?.message);
  });
  map.on("moveend", () => {
    const c = map.getCenter();
    writeJson(VIEW_KEY, { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
  });
  return map;
}

/* ---- markers ---- */

let placeMarker = null;
let youMarker = null;
const endMarkers = {};

function pinMarker(className) {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = `<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7.5-6.8 7.5-12.3a7.5 7.5 0 0 0-15 0C4.5 15.2 12 22 12 22z"/><circle cx="12" cy="9.7" r="2.6" fill="currentColor"/></svg>`;
  return new maplibregl.Marker({ element: el, anchor: "bottom" });
}

export function setPlaceMarker(lat, lon) {
  placeMarker ||= pinMarker("marker-pin");
  placeMarker.setLngLat([lon, lat]).addTo(map);
}

// The two ends of a route being planned. An end of null or "here" has no pin of its own.
export function setEndMarkers(from, to) {
  for (const [which, end, className] of [["from", from, "marker-pin marker-from"], ["to", to, "marker-pin"]]) {
    if (end?.lat == null) {
      endMarkers[which]?.remove();
      continue;
    }
    endMarkers[which] ||= pinMarker(className);
    endMarkers[which].setLngLat([end.lon, end.lat]).addTo(map);
  }
}

export function clearPlaceMarker() {
  placeMarker?.remove();
}

export function setYouMarker(lat, lon) {
  if (!youMarker) {
    const el = document.createElement("div");
    el.className = "marker-you";
    el.setAttribute("aria-label", "Your location");
    youMarker = new maplibregl.Marker({ element: el });
  }
  youMarker.setLngLat([lon, lat]).addTo(map);
}

/* ---- the route on the map ---- */

let routeCoords = null;

function drawRoute() {
  if (!map.getSource("route")) {
    // Not added yet: the style is still arriving, and this runs again when it's in.
    if (!map.getStyle()?.layers?.length) return;
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b3d91", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 16, 12] } });
    map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#3b8bff", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 16, 8] } });
  }
  map.getSource("route").setData(routeCoords
    ? { type: "Feature", geometry: { type: "LineString", coordinates: routeCoords }, properties: {} }
    : { type: "FeatureCollection", features: [] });
  // Over the train lines and everything else added since.
  map.moveLayer("route-casing");
  map.moveLayer("route-line");
}

export function showRoute(coords) {
  routeCoords = coords;
  drawRoute();
}

export function clearRoute() {
  routeCoords = null;
  drawRoute();
}

// Puts everything back after a change of style.
onStyle(drawRoute);

// Fits points in, leaving room for the panels and for the tray along the right.
export function fitCoords(coords) {
  if (!coords.length) return;
  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  const narrow = window.innerWidth <= 920;
  map.fitBounds(bounds, {
    // Narrow, the panel takes up to 46% of the height from the bottom.
    padding: narrow ? { top: 80, right: 70, bottom: Math.round(window.innerHeight * 0.5), left: 30 } : { top: 80, right: 80, bottom: 60, left: 420 },
    maxZoom: 16,
    pitch: 0,
    bearing: 0,
  });
}

// Getting a route: from a saved pack when one covers both ends, so it works the same with or without a
// connection, and otherwise from the public OSRM servers (the same ones SG Bus Timings uses).

import { packAt } from "./packs.js";
import { stepText } from "./route-core.js";
import { isOnline } from "./ui.js";

const OSRM = {
  foot: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
  bike: "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
  car: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
};

let worker = null;
let nextId = 1;
const waiting = new Map();

function offlineRoute(pack, from, to, mode) {
  if (!worker) {
    worker = new Worker("/js/route-worker.js", { type: "module" });
    worker.addEventListener("message", ({ data }) => {
      const job = waiting.get(data.id);
      if (!job) return;
      waiting.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.route);
    });
    worker.addEventListener("error", (e) => {
      for (const job of waiting.values()) job.reject(new Error(e.message || "The router stopped"));
      waiting.clear();
      worker = null;
    });
  }
  const id = nextId++;
  // An older request has been told to stop: it answers null when it does.
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, pack: { id: pack.id, build: pack.build }, from, to, mode });
  });
}

const MODIFIER_ANGLE = { "sharp left": -140, left: -90, "slight left": -35, straight: 0, "slight right": 35, right: 90, "sharp right": 140, uturn: 180 };
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

function osrmStep(s, index) {
  const m = s.maneuver;
  let type = "turn";
  if (m.type === "depart") type = "depart";
  else if (m.type === "arrive") type = "arrive";
  else if (m.type === "roundabout" || m.type === "rotary") type = "roundabout";
  else if (m.type === "on ramp" || m.type === "off ramp") type = "ramp";
  else if (m.type === "new name" || m.modifier === "straight") type = "continue";
  else if (s.mode === "ferry") type = "ferry";
  const step = {
    type,
    name: s.name || s.ref || "",
    distance: Math.round(s.distance),
    duration: Math.round(s.duration),
    at: m.location,
    index,
    angle: MODIFIER_ANGLE[m.modifier] ?? 0,
    exit: m.exit,
    compass: COMPASS[Math.round((m.bearing_after || 0) / 45) % 8],
  };
  step.text = stepText(step);
  return step;
}

async function onlineRoute(from, to, mode, signal) {
  const url = `${OSRM[mode]}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The route server answered ${res.status}`);
  const body = await res.json();
  const r = body.routes?.[0];
  if (!r) return null;
  const coords = r.geometry.coordinates;
  // Each step's place along the line, by the point nearest where it happens.
  let at = 0;
  const steps = r.legs.flatMap((l) => l.steps).map((s) => {
    const [lon, lat] = s.maneuver.location;
    for (let i = at; i < coords.length; i++) {
      if (Math.abs(coords[i][0] - lon) < 1e-5 && Math.abs(coords[i][1] - lat) < 1e-5) {
        at = i;
        break;
      }
    }
    return osrmStep(s, at);
  });
  return { source: "online", mode, distance: Math.round(r.distance), duration: Math.round(r.duration), coords, steps };
}

export class NoRoute extends Error {}

// Answers a route, or throws NoRoute with something worth reading.
export async function getRoute(from, to, mode, { signal } = {}) {
  const a = packAt(from.lat, from.lon);
  const b = packAt(to.lat, to.lon);
  const pack = a && b && a.id === b.id ? a : null;

  if (pack) {
    try {
      const route = await offlineRoute(pack, from, to, mode);
      if (route) return route;
    } catch (err) {
      console.warn("Offline router:", err.message);
    }
    if (!isOnline()) throw new NoRoute("No way there was found on the saved map.");
  }
  if (!isOnline()) throw new NoRoute("You're offline. Save this area in Offline maps to get directions here.");
  try {
    const route = await onlineRoute(from, to, mode, signal);
    if (!route) throw new NoRoute("No way there was found.");
    return route;
  } catch (err) {
    if (err.name === "AbortError" || err instanceof NoRoute) throw err;
    throw new NoRoute("Couldn't reach the route server. Try again in a moment.");
  }
}

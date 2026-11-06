// You on the map, live: the dot, the camera following it, the compass turning the map, and how fast you're
// going. The same as lib/nav/you.dart in the app.
//
// The dot and the camera move together, frame by frame, so the dot stays in the middle of the screen the whole
// way. Moving the marker and then easing the camera after it leaves the dot off centre until the camera catches up.

import { getMap, setYouMarker } from "./map.js";
import { $, currentPosition, formatSpeed, hydrateIcons, toast } from "./ui.js";

// A fix's glide to the next, about as long as they come apart.
export const GLIDE_MS = 800;
// With no fix for this long, a speed on screen is old news: in a tunnel, say.
const STALE_MS = 5000;
// 9 km/h and 5.4 km/h, in metres a second: when a speed shows with no route to say how you're travelling.
const SPEED_FROM = 2.5;
const SPEED_BELOW = 1.5;
// How long a device gets to report which way it's facing, before it's taken not to have a compass.
const COMPASS_WAIT_MS = 2500;
const MAX_PITCH = 60;

// "none", "follow" (the map stays on you) or "compass" (and turns the way you're facing).
let mode = "none";
let navigating = false;
let dot = null; // Where the dot's drawn.
let glide = null; // { from, to, start }
let heading = null; // Which way the device faces, in degrees.
let frame = null;
let watchId = null;
let wantWatch = false;
let staleTimer = null;
let compassTimer = null;
let listening = false;
let speedMps = null;
let flying = 0; // Counts up, so a drag during the flight to you can call off following at the end of it.

const OWN = { own: true };

/* ---- how fast ---- */

// Whether there's a speed to show, and what it is. On a route, the mode says: a car or a bike always shows it,
// stopped at the lights too, and on foot never does. With no route nothing says how you're travelling, so it
// shows once you're clearly faster than a walk, and stays until you've slowed down.
export function speedToShow(speed, shownNow, routeMode) {
  if (speed == null || speed < 0) return null;
  if (routeMode === "car" || routeMode === "bike") return speed;
  if (routeMode) return null;
  return speed >= (shownNow == null ? SPEED_FROM : SPEED_BELOW) ? speed : null;
}

function drawSpeed() {
  for (const el of [$("#speedBadge"), $("#navSpeed")]) {
    el.textContent = speedMps == null ? "" : formatSpeed(speedMps);
    el.classList.toggle("hidden", speedMps == null);
  }
}

/* ---- the camera ---- */

function draw() {
  $("#locateBtn").setAttribute("aria-pressed", String(mode !== "none"));
  const compass = $("#compassBtn");
  if (compass) {
    const on = mode === "compass";
    compass.setAttribute("aria-pressed", String(on));
    const label = on ? "Face north, and flat" : "Point the map the way you are facing";
    compass.setAttribute("aria-label", label);
    compass.title = label;
  }
}

function setMode(next) {
  mode = next;
  draw();
  run();
}

function run() {
  if (frame == null && (glide || (mode === "compass" && heading != null))) frame = requestAnimationFrame(tick);
}

function tick(now) {
  frame = null;
  if (glide) {
    const t = Math.min(1, (now - glide.start) / GLIDE_MS);
    dot = { lat: glide.from.lat + (glide.to.lat - glide.from.lat) * t, lon: glide.from.lon + (glide.to.lon - glide.from.lon) * t };
    setYouMarker(dot.lat, dot.lon);
    if (t >= 1) glide = null;
  }
  const map = getMap();
  // Fingers on the map win: following picks up again with the next frame after them.
  if (mode !== "none" && !map.isMoving()) {
    const camera = {};
    if (dot) camera.center = [dot.lon, dot.lat];
    if (mode === "compass" && heading != null) {
      const bearing = map.getBearing();
      camera.bearing = bearing + (((heading - bearing + 540) % 360) - 180) * 0.15;
    }
    map.jumpTo(camera, OWN);
  }
  run();
}

/* ---- where you are ---- */

// One fix: the dot moves there, and so does the camera if it's following. routeMode is the route being
// followed, if there is one.
export function fix(lat, lon, { mps, routeMode } = {}) {
  const to = { lat, lon };
  if (dot) {
    glide = { from: { ...dot }, to, start: performance.now() };
  } else {
    dot = to;
    setYouMarker(lat, lon);
  }
  run();

  speedMps = speedToShow(mps, speedMps, routeMode);
  drawSpeed();
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    speedMps = null;
    drawSpeed();
  }, STALE_MS);
}

function stopWatching() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function startWatching() {
  wantWatch = true;
  if (watchId != null || !("geolocation" in navigator) || document.visibilityState !== "visible") return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      // Navigation has fixes of its own.
      if (!navigating) fix(pos.coords.latitude, pos.coords.longitude, { mps: pos.coords.speed });
    },
    (err) => console.debug("Location:", err.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

// My location: to where you are, and with you from then on, until the map's dragged away.
export async function followLocation() {
  try {
    const pos = await currentPosition();
    fix(pos.lat, pos.lon);
    const map = getMap();
    const id = ++flying;
    map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 16) });
    map.once("moveend", () => {
      if (id === flying) setMode("follow");
    });
    startWatching();
  } catch (err) {
    toast(err.code === 1 ? "Allow location access to see where you are" : "Couldn't find your location", { error: true });
  }
}

/* ---- the compass ---- */

function onOrientation(e) {
  // Safari says the heading outright. Elsewhere it's worked out from alpha, if alpha is true to north.
  let reading = e.webkitCompassHeading;
  if (reading == null) {
    if (e.alpha == null || !(e.absolute || e.type === "deviceorientationabsolute")) return;
    reading = 360 - e.alpha;
  }
  clearTimeout(compassTimer);
  heading = (reading + (screen.orientation?.angle || 0)) % 360;
  run();
}

function listenToCompass() {
  if (listening) return;
  listening = true;
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
}

function stopListeningToCompass() {
  listening = false;
  heading = null;
  clearTimeout(compassTimer);
  window.removeEventListener("deviceorientationabsolute", onOrientation);
  window.removeEventListener("deviceorientation", onOrientation);
}

// The compass button: the map turns as the device does, and a second press puts it north and flat.
export async function toggleCompass() {
  const map = getMap();
  if (mode === "compass") {
    stopListeningToCompass();
    setMode("none");
    map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
    return;
  }
  // iPhones ask, and only from a press.
  const ask = window.DeviceOrientationEvent?.requestPermission;
  if (ask) {
    try {
      if ((await ask.call(window.DeviceOrientationEvent)) !== "granted") throw new Error("Refused");
    } catch {
      toast("Allow motion and orientation access to point the map the way you're facing", { error: true });
      return;
    }
  }
  listenToCompass();
  setMode("compass");
  // The compass needs no location: without one the map still turns, just without following you.
  startWatching();
  compassTimer = setTimeout(() => {
    stopListeningToCompass();
    setMode(dot ? "follow" : "none");
    toast("This device can't tell which way it's facing", { error: true });
  }, COMPASS_WAIT_MS);
}

/* ---- navigation ---- */

export const cameraFollows = () => mode !== "none";

export function navigationStarted() {
  navigating = true;
}

// Navigation's over: nothing's following, and a speed from its route doesn't apply any more.
export function navigationEnded() {
  navigating = false;
  speedMps = null;
  drawSpeed();
  stopListeningToCompass();
  setMode("none");
}

/* ---- the controls on the map ---- */

// Tilts and turns by a drag on the handle, in pixels: up tilts further, down flattens, and sideways turns the view.
function orbitBy(dx, dy) {
  const map = getMap();
  // Turning the view by hand wins over the compass. The map stays on you.
  if (mode === "compass") {
    stopListeningToCompass();
    setMode("follow");
  }
  map.jumpTo({ pitch: Math.max(0, Math.min(MAX_PITCH, map.getPitch() - dy * 0.5)), bearing: map.getBearing() + dx * 0.8 }, OWN);
}

function wireOrbit(handle) {
  let last = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    last = [e.clientX, e.clientY];
  });
  handle.addEventListener("pointermove", (e) => {
    if (!last) return;
    orbitBy(e.clientX - last[0], e.clientY - last[1]);
    last = [e.clientX, e.clientY];
  });
  const end = () => {
    last = null;
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  const STEP = { ArrowUp: [0, -30], ArrowDown: [0, 30], ArrowLeft: [-30, 0], ArrowRight: [30, 0] };
  handle.addEventListener("keydown", (e) => {
    if (!STEP[e.key]) return;
    e.preventDefault();
    orbitBy(...STEP[e.key]);
  });
}

class MapControls {
  onAdd(map) {
    const el = document.createElement("div");
    el.className = "maplibregl-ctrl map-controls";
    el.innerHTML = `
      <div class="maplibregl-ctrl-group">
        <button type="button" id="orbitHandle" class="map-ctl orbit-handle" aria-label="Drag to tilt and turn the map" title="Drag to tilt and turn the map"><span data-icon="orbit"></span></button>
      </div>
      <div class="maplibregl-ctrl-group">
        <button type="button" class="map-ctl" id="zoomInBtn" aria-label="Zoom in" title="Zoom in"><span data-icon="plus"></span></button>
        <button type="button" class="map-ctl" id="zoomOutBtn" aria-label="Zoom out" title="Zoom out"><span data-icon="minus"></span></button>
        <button type="button" class="map-ctl" id="compassBtn" aria-pressed="false"><span data-icon="compass"></span></button>
      </div>`;
    hydrateIcons(el);
    el.querySelector("#zoomInBtn").addEventListener("click", () => map.zoomIn({}, OWN));
    el.querySelector("#zoomOutBtn").addEventListener("click", () => map.zoomOut({}, OWN));
    el.querySelector("#compassBtn").addEventListener("click", toggleCompass);
    wireOrbit(el.querySelector("#orbitHandle"));
    this.el = el;
    return el;
  }

  onRemove() {
    this.el.remove();
  }
}

export function initYou(map) {
  // Off so two fingers always pan: MapLibre's tilt starts once two level fingers go up or down, and stops the
  // map panning until they lift. The handle tilts instead.
  map.touchPitch.disable();
  map.addControl(new MapControls(), "bottom-right");
  draw();

  // A drag away ends following.
  map.on("dragstart", () => {
    flying++;
    if (mode === "compass") stopListeningToCompass();
    if (mode !== "none") setMode("none");
  });
  // So does anything else taking the camera, such as flying to a place. Fingers zooming don't, and nor do the buttons.
  map.on("movestart", (e) => {
    if (mode !== "none" && !e.own && !e.originalEvent) {
      if (mode === "compass") stopListeningToCompass();
      setMode("none");
    }
  });
  // A twist ends the compass, and the map stays on you.
  map.on("rotatestart", (e) => {
    if (mode === "compass" && e.originalEvent) {
      stopListeningToCompass();
      setMode("follow");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") stopWatching();
    else if (wantWatch) startWatching();
  });
}

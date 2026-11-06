// Live navigation: following somebody along a route, saying what's next, and finding a new way when
// they leave it. Everything here works offline: positions come from the device, the route from a saved
// pack, and the voice from the device's own speech engine.

import { getRoute, NoRoute } from "./route-client.js";
import { getMap, showRoute, clearRoute } from "./map.js";
import { stepIcon } from "./icons.js";
import { $, formatClock, formatDistance, formatDuration, hydrateIcons, metresBetween, readJson, toast, writeJson } from "./ui.js";
import { GLIDE_MS, cameraFollows, fix, navigationEnded, navigationStarted } from "./you.js";

const VOICE_KEY = "uwumaps.navVoice";
// Further off the line than this, a few fixes running, is off the route rather than a poor fix.
const OFF_ROUTE_M = { foot: 35, bike: 45, car: 60 };
const OFF_ROUTE_FIXES = 3;
const REROUTE_GAP_MS = 10000;
const ARRIVED_M = 25;
const ANNOUNCE_AT_M = { foot: [60], bike: [120], car: [800, 200] };

let nav = null;
let etaHooks = { update() {}, stop() {} };
export const setEtaHooks = (h) => {
  etaHooks = { ...etaHooks, ...h };
};
export const isNavigating = () => Boolean(nav);
export const navProgress = () => (nav ? { ...nav.progress, route: nav.route, to: nav.to, mode: nav.route.mode } : null);

/* ---- where along the route ---- */

function cumulative(coords) {
  const out = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + metresBetween(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return out;
}

// The nearest point on the line, looking only a little behind and ahead of the last one, so a road
// that doubles back on itself doesn't make somebody jump along the route.
function locate(coords, along, fromIndex, lat, lon) {
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = { d: Infinity, index: fromIndex, m: along[fromIndex] };
  const start = Math.max(0, fromIndex - 5);
  const end = Math.min(coords.length - 1, fromIndex + 200);
  for (let i = start; i < end; i++) {
    const ax = coords[i][0] * cos;
    const ay = coords[i][1];
    const bx = coords[i + 1][0] * cos;
    const by = coords[i + 1][1];
    const px = lon * cos;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (lat - ay) * dy) / l2)) : 0;
    const d = Math.hypot(px - ax - t * dx, lat - ay - t * dy) * 111195;
    if (d < best.d) best = { d, index: i, m: along[i] + t * (along[i + 1] - along[i]) };
  }
  return best;
}

/* ---- the display ---- */

function say(text) {
  if (!nav?.voice || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // The screen still says it.
  }
}

function drawVoice() {
  const btn = $("#navVoice");
  btn.setAttribute("aria-pressed", String(nav.voice));
  btn.querySelector("[data-icon]").dataset.icon = nav.voice ? "sound" : "mute";
  hydrateIcons(btn);
}

function draw() {
  const { progress, route } = nav;
  const step = route.steps[progress.stepIndex + 1] || route.steps[route.steps.length - 1];
  const iconEl = $("#navIcon");
  iconEl.dataset.icon = stepIcon(step);
  hydrateIcons(iconEl.parentElement);
  $("#navDistance").textContent = formatDistance(progress.toStep);
  $("#navText").textContent = step.text;
  const secondsLeft = route.distance > 0 ? route.duration * (progress.left / route.distance) : 0;
  $("#navEta").textContent = formatClock(Date.now() + secondsLeft * 1000);
  $("#navLeft").textContent = `${formatDuration(secondsLeft)} · ${formatDistance(progress.left)}`;
  progress.secondsLeft = secondsLeft;
}

function announce() {
  const { progress, route } = nav;
  const next = route.steps[progress.stepIndex + 1];
  if (!next) return;
  for (const at of ANNOUNCE_AT_M[route.mode]) {
    const key = `${progress.stepIndex}:${at}`;
    if (progress.toStep <= at && !nav.said.has(key)) {
      for (const a of ANNOUNCE_AT_M[route.mode]) if (a >= at) nav.said.add(`${progress.stepIndex}:${a}`);
      say(`In ${formatDistance(progress.toStep).replace(" m", " metres").replace(" km", " kilometres")}, ${next.text}`);
      return;
    }
  }
}

/* ---- following ---- */

function useRoute(route) {
  nav.route = route;
  nav.along = cumulative(route.coords);
  nav.index = 0;
  // Where each step begins, in metres along the route.
  nav.stepAt = route.steps.map((s) => nav.along[Math.min(s.index, route.coords.length - 1)]);
  nav.said = new Set();
  showRoute(route.coords);
}

function stepIndexAt(m) {
  let i = 0;
  while (i + 1 < nav.stepAt.length && nav.stepAt[i + 1] <= m) i++;
  return i;
}

async function reroute(lat, lon) {
  if (nav.rerouting || Date.now() - nav.reroutedAt < REROUTE_GAP_MS) return;
  nav.rerouting = true;
  nav.reroutedAt = Date.now();
  const current = nav;
  try {
    const route = await getRoute({ lat, lon }, current.to, current.route.mode);
    if (nav !== current) return;
    useRoute(route);
    nav.offCount = 0;
    say("Route updated.");
  } catch (err) {
    if (err instanceof NoRoute) toast(err.message, { error: true });
  } finally {
    current.rerouting = false;
  }
}

function onPosition(pos) {
  if (!nav) return;
  const { latitude: lat, longitude: lon, heading } = pos.coords;

  const { route, along } = nav;
  fix(lat, lon, { mps: pos.coords.speed, routeMode: route.mode });
  const here = locate(route.coords, along, nav.index, lat, lon);
  nav.index = here.index;
  nav.lastFix = { lat, lon, t: Date.now(), accuracy: pos.coords.accuracy };

  if (here.d > OFF_ROUTE_M[route.mode]) {
    nav.offCount++;
    if (nav.offCount >= OFF_ROUTE_FIXES) reroute(lat, lon);
  } else nav.offCount = 0;

  const left = Math.max(0, along[along.length - 1] - here.m);
  const stepIndex = stepIndexAt(here.m);
  const nextAt = nav.stepAt[stepIndex + 1] ?? along[along.length - 1];
  nav.progress = { left, stepIndex, toStep: Math.max(0, nextAt - here.m) };
  draw();
  announce();

  const end = route.coords[route.coords.length - 1];
  if (left < ARRIVED_M || metresBetween(lat, lon, end[1], end[0]) < ARRIVED_M) {
    finish(true);
    return;
  }

  // The way ahead is up, tilted, when moving. Otherwise along the line.
  const nextPoint = route.coords[Math.min(here.index + 1, route.coords.length - 1)];
  const lineBearing = (Math.atan2(
    (nextPoint[0] - lon) * Math.cos((lat * Math.PI) / 180),
    nextPoint[1] - lat,
  ) * 180) / Math.PI;
  const bearing = Number.isFinite(heading) && heading !== null && pos.coords.speed > 1 ? heading : lineBearing;
  // Unless My location or the compass have the camera already. Dragged away, it's back with the next fix. In a
  // straight line, as the dot glides, so the dot stays in the middle.
  if (!cameraFollows()) getMap().easeTo({ center: [lon, lat], zoom: route.mode === "car" ? 17 : 18, pitch: 60, bearing, duration: GLIDE_MS, easing: (t) => t, essential: false });
  etaHooks.update();
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    toast("Allow location access to follow the route", { error: true });
    finish(false);
  } else {
    toast("Waiting for your location...");
  }
}

/* ---- the screen staying on ---- */

async function holdScreen() {
  if (!nav || !("wakeLock" in navigator)) return;
  try {
    nav.wake = await navigator.wakeLock.request("screen");
  } catch {
    // Not everywhere, and not on low battery. Navigation works regardless.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && nav) holdScreen();
});

/* ---- starting and stopping ---- */

export function startNavigation(route, { from, to }) {
  if (nav) stopNavigation();
  nav = {
    voice: readJson(VOICE_KEY, true),
    to,
    from,
    progress: { left: route.distance, stepIndex: 0, toStep: route.steps[0]?.distance ?? route.distance },
    offCount: 0,
    reroutedAt: 0,
    rerouting: false,
    watch: null,
    wake: null,
  };
  useRoute(route);
  navigationStarted();
  document.body.classList.add("navigating");
  $("#navHud").classList.remove("hidden");
  $("#navShareLabel").textContent = "Share ETA";
  drawVoice();
  draw();
  say(route.steps[0]?.text || "");
  holdScreen();
  if ("geolocation" in navigator) {
    nav.watch = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  } else {
    toast("This device can't report its location", { error: true });
  }
  window.dispatchEvent(new CustomEvent("uwu:navstart"));
}

function finish(arrived) {
  if (!nav) return;
  if (arrived) {
    say("You have arrived.");
    toast("You have arrived");
  }
  etaHooks.stop(arrived);
  stopNavigation();
}

export function stopNavigation() {
  if (!nav) return;
  if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
  nav.wake?.release?.().catch?.(() => {});
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  nav = null;
  navigationEnded();
  document.body.classList.remove("navigating");
  $("#navHud").classList.add("hidden");
  clearRoute();
  window.dispatchEvent(new CustomEvent("uwu:navstop"));
}

export function wireNav() {
  $("#navStop").addEventListener("click", () => {
    etaHooks.stop(false);
    stopNavigation();
  });
  $("#navVoice").addEventListener("click", () => {
    if (!nav) return;
    nav.voice = !nav.voice;
    writeJson(VOICE_KEY, nav.voice);
    if (!nav.voice && "speechSynthesis" in window) window.speechSynthesis.cancel();
    drawVoice();
  });
}

export const lastFix = () => nav?.lastFix || null;

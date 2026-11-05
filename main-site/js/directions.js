// The directions panel: two ends, how to travel, and the route between them.

import { clearRoute, fitCoords, getMap, setEndMarkers, setYouMarker, showRoute } from "./map.js";
import { hidePlace, savedPlaces } from "./places.js";
import { NoRoute, getRoute } from "./route-client.js";
import { findPlaces, renderSuggestions } from "./search.js";
import { stepIcon } from "./icons.js";
import { $, currentPosition, escapeHtml, formatDistance, formatDuration, hydrateIcons, readJson, writeJson } from "./ui.js";

const MODE_KEY = "uwumaps.travelMode";
const HERE_LABEL = "My location";

const state = {
  from: "here", // "here" or a place
  to: null,
  mode: readJson(MODE_KEY, "car"),
  route: null,
};
let handlers = { start() {}, share() {} };
export const setDirectionsHandlers = (h) => {
  handlers = { ...handlers, ...h };
};
export const directionsState = () => state;

let requestId = 0;
// Which end a tap on the map fills: the field last chosen, then whichever's empty.
let picking = null;

const endLabel = (end) => (end === "here" ? HERE_LABEL : end?.name || "");

function drawModes() {
  document.querySelectorAll("#travelModes .mode-btn").forEach((el) => {
    const on = el.dataset.travel === state.mode;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

function drawEnds() {
  $("#routeFrom").value = endLabel(state.from);
  $("#routeTo").value = endLabel(state.to);
  setEndMarkers(state.from, state.to);
}

const nextEmpty = () => (!state.from ? "from" : !state.to ? "to" : null);
const askForEnd = () => `${state.to ? "Where from?" : "Where to?"} Type it, or tap the map.`;

function setPicking(which) {
  picking = which;
  document.querySelectorAll("[data-pick]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.pick === which)));
}

function status(text) {
  $("#routeStatus").textContent = text;
  $("#routeStatus").hidden = !text;
}

function drawRoute(route) {
  $("#routeTime").textContent = formatDuration(route.duration);
  $("#routeDistance").textContent = formatDistance(route.distance);
  $("#routeSource").textContent = route.source === "offline" ? "Offline" : "Online";
  $("#routeSteps").innerHTML = route.steps.map((s, i) => `
    <li data-step="${i}">
      <span data-icon="${stepIcon(s)}"></span>
      <span>${escapeHtml(s.text)}${s.distance ? `<span class="step-len">${formatDistance(s.distance)}</span>` : ""}</span>
    </li>`).join("");
  hydrateIcons($("#routeSteps"));
  $("#routeResult").classList.remove("hidden");
}

async function resolveEnd(end) {
  if (end !== "here") return end;
  const pos = await currentPosition();
  setYouMarker(pos.lat, pos.lon);
  return { name: HERE_LABEL, ...pos };
}

export async function planRoute({ fit = true } = {}) {
  const id = ++requestId;
  state.route = null;
  $("#routeResult").classList.add("hidden");
  clearRoute();
  if (!state.from || !state.to) {
    status(askForEnd());
    return;
  }
  if (state.from === "here" && state.to === "here") {
    status("Pick somewhere other than where you are.");
    return;
  }
  status("Finding the way...");
  try {
    const [from, to] = await Promise.all([resolveEnd(state.from), resolveEnd(state.to)]);
    const route = await getRoute(from, to, state.mode);
    if (id !== requestId) return;
    state.route = route;
    state.resolved = { from, to };
    status("");
    drawRoute(route);
    showRoute(route.coords);
    if (fit) fitCoords(route.coords);
  } catch (err) {
    if (id !== requestId) return;
    if (err instanceof NoRoute) status(err.message);
    else if (err.code != null) status("Allow location access to start from where you are, or type a start.");
    else {
      console.warn(err);
      status("Couldn't find the way. Try again in a moment.");
    }
  }
}

export function openDirections({ from, to, mode } = {}) {
  if (from !== undefined) state.from = from;
  if (to !== undefined) state.to = to;
  if (mode) setMode(mode);
  hidePlace();
  drawModes();
  drawEnds();
  document.body.classList.add("directions-open");
  $("#directionsPanel").classList.remove("hidden");
  setPicking(nextEmpty());
  if (state.from && state.to) planRoute();
  else {
    status(askForEnd());
    // Not with a finger: the keyboard would come up over the map there is to tap.
    if (!state.to && matchMedia("(pointer: fine)").matches) $("#routeTo").focus({ preventScroll: true });
  }
}

export const directionsOpen = () => !$("#directionsPanel").classList.contains("hidden");

// A tap on the map, as an end of the route. Answers false if neither end is waiting for one.
export function pickFromMap(place) {
  const which = picking || nextEmpty();
  if (!which) return false;
  state[which] = { name: place.name, lat: place.lat, lon: place.lon };
  $("#routeSuggestions").classList.add("hidden");
  document.activeElement?.blur();
  setPicking(nextEmpty());
  drawEnds();
  planRoute();
  return true;
}

export function closeDirections() {
  requestId++;
  state.route = null;
  setPicking(null);
  setEndMarkers(null, null);
  document.body.classList.remove("directions-open");
  $("#directionsPanel").classList.add("hidden");
  $("#routeSuggestions").classList.add("hidden");
  clearRoute();
}

function setMode(mode) {
  state.mode = mode;
  writeJson(MODE_KEY, mode);
}

/* ---- typing an end ---- */

function attachSuggest(input, which) {
  let timer = null;
  let results = [];
  let controller = null;
  const list = $("#routeSuggestions");

  const pick = (place) => {
    state[which] = place;
    list.classList.add("hidden");
    setPicking(nextEmpty());
    drawEnds();
    planRoute();
  };

  const offer = (found, emptyText) => {
    results = found;
    list.dataset.for = which;
    renderSuggestions(list, results, emptyText);
    hydrateIcons(list);
    list.pickResult = (i) => {
      const r = results[i];
      pick(r.here ? "here" : r);
    };
  };
  const HERE = { name: HERE_LABEL, lat: 0, lon: 0, here: true };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    state[which] = null;
    setEndMarkers(state.from, state.to);
    if (q.length < 2) {
      list.classList.add("hidden");
      return;
    }
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      const asked = controller;
      const c = getMap().getCenter();
      let found;
      try {
        found = await findPlaces(q, { near: { lat: c.lat, lon: c.lng }, signal: asked.signal, saved: savedPlaces() });
      } catch {
        return;
      }
      if (asked !== controller) return;
      offer(which === "from" ? [HERE, ...found] : found, "Nothing found");
    }, 250);
  });
  input.addEventListener("focus", () => {
    input.select();
    setPicking(which);
    list.classList.add("hidden");
    // The way back to starting from here, once a start's been picked.
    if (which === "from" && state.from !== "here") offer([HERE], "");
  });
}

export function wireDirections() {
  $("#directionsClose").addEventListener("click", closeDirections);
  $("#travelModes").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-travel]");
    if (!btn) return;
    setMode(btn.dataset.travel);
    drawModes();
    planRoute();
  });
  $("#routeSwap").addEventListener("click", () => {
    [state.from, state.to] = [state.to, state.from];
    setPicking(nextEmpty());
    drawEnds();
    planRoute();
  });
  document.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", () => {
    const which = btn.dataset.pick;
    setPicking(picking === which ? null : which);
    $("#routeSuggestions").classList.add("hidden");
    status(picking ? `Tap the map for ${which === "from" ? "where to start" : "where to go"}.` : "");
  }));
  attachSuggest($("#routeFrom"), "from");
  attachSuggest($("#routeTo"), "to");
  $("#routeSuggestions").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-result]");
    if (btn) $("#routeSuggestions").pickResult?.(Number(btn.dataset.result));
  });
  $("#routeStart").addEventListener("click", () => state.route && handlers.start(state.route, state.resolved));
  $("#routeShare").addEventListener("click", () => state.route && handlers.share(state));
  $("#routeSteps").addEventListener("click", (e) => {
    const li = e.target.closest("[data-step]");
    if (!li || !state.route) return;
    const step = state.route.steps[Number(li.dataset.step)];
    getMap().flyTo({ center: step.at, zoom: Math.max(getMap().getZoom(), 16) });
  });
  drawModes();
}

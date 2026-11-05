// uwuMaps: where it all starts.

import { COLOR_THEMES, applyColorTheme, applyMode, getModePreference, getStoredColorTheme, getStoredMode, initTheme } from "./js/theme.js";
import { $, closeModal, currentPosition, hydrateIcons, openModal, toast } from "./js/ui.js";
import { initTray } from "./js/tray.js";
import { initUpdateBar } from "./js/update.js";
import { initPacks, openPacks, wirePacks } from "./js/packs.js";
import { getMap, initMap, onStyle, refreshStyle, setYouMarker } from "./js/map.js";
import { initTransit, openLayers, transitCardAt, wireLayers } from "./js/transit.js";
import { addSavedLayer, hidePlace, openSaved, savedPlaces, setPlaceHandlers, showPlace, wirePlaces } from "./js/places.js";
import { closeDirections, openDirections, setDirectionsHandlers, wireDirections } from "./js/directions.js";
import { isNavigating, startNavigation, wireNav } from "./js/nav.js";
import { openIncoming, receiveShared, shareDirections, shareList, sharePlace, wireShare } from "./js/share.js";
import { onNearbyReceive, openNearby, wireNearby } from "./js/nearby.js";
import { findPlaces, renderSuggestions } from "./js/search.js";

/* ---- the theme sheet ---- */

function buildThemeModal() {
  const grid = document.getElementById("swatchGrid");
  grid.innerHTML = COLOR_THEMES.map(
    (t) => `
      <button class="swatch" data-theme-id="${t.id}" style="--swatch-color:${t.hex}" type="button" aria-label="${t.label}">
        <span class="swatch-dot"></span>
        <span class="swatch-label">${t.label}</span>
      </button>`
  ).join("");

  syncThemeModalState();

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-id]");
    if (!btn) return;
    applyColorTheme(btn.dataset.themeId);
    syncThemeModalState();
  });

  document.getElementById("modeToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    applyMode(btn.dataset.mode);
    syncThemeModalState();
    refreshStyle();
  });

  // A tab left open across 09:00 or 18:00 re-resolves itself; redraw the
  // modal so the note and pressed state stay in step with the change.
  document.addEventListener("uwu:modechange", () => {
    syncThemeModalState();
    refreshStyle();
  });
}

function syncThemeModalState() {
  const activeTheme = getStoredColorTheme();
  const activePreference = getModePreference();
  const resolvedMode = getStoredMode();

  document.querySelectorAll("#swatchGrid .swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeId === activeTheme);
  });
  document.querySelectorAll("#modeToggle .mode-btn").forEach((el) => {
    const isActive = el.dataset.mode === activePreference;
    el.classList.toggle("active", isActive);
    el.setAttribute("aria-pressed", String(isActive));
  });

  const note = document.getElementById("modeNote");
  if (note) {
    note.hidden = activePreference !== "time";
    if (activePreference === "time") {
      note.textContent = `Following the clock. Currently ${resolvedMode}.`;
    }
  }

  updateThemeButtonIcon();
}

function updateThemeButtonIcon() {
  const span = document.querySelector("#themeBtn [data-icon]");
  span.setAttribute("data-icon", getStoredMode() === "dark" ? "moon" : "sun");
  hydrateIcons(document.getElementById("themeBtn"));
}

function wireModals() {
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".modal-backdrop:not(.hidden)");
    if (open) closeModal(open.id);
  });
  document.getElementById("themeBtn").addEventListener("click", () => openModal("themeModal"));
}

/* ---- the search box ---- */

function wireSearch() {
  const input = $("#searchInput");
  const list = $("#searchResults");
  let timer = null;
  let results = [];
  let controller = null;

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      list.classList.add("hidden");
      return;
    }
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
    // Only online search can be cancelled, so an older answer can still arrive after a newer question.
    if (asked !== controller) return;
    results = found;
    renderSuggestions(list, results, "Nothing found. Saved areas are searched offline.");
    hydrateIcons(list);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      run();
    } else if (e.key === "Escape") {
      list.classList.add("hidden");
    }
  });
  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-result]");
    if (!btn) return;
    const r = results[Number(btn.dataset.result)];
    list.classList.add("hidden");
    input.value = r.name;
    closeDirections();
    showPlace(r);
  });
}

/* ---- tapping the map ---- */

function nameAt(map, point) {
  const box = [[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]];
  const hit = map.queryRenderedFeatures(box).find((f) => f.layer.type === "symbol" && (f.properties["name:en"] || f.properties.name));
  return hit ? { name: hit.properties["name:en"] || hit.properties.name, coords: hit.geometry.type === "Point" ? hit.geometry.coordinates : null } : null;
}

function wireMapTap(map) {
  map.on("click", async (e) => {
    if (isNavigating()) return;
    $("#searchResults").classList.add("hidden");
    const pin = map.getLayer("saved") && map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ["saved"] })[0];
    if (pin) {
      const place = savedPlaces().find((p) => p.id === pin.properties.id);
      if (place) {
        showPlace(place, { fly: false });
        return;
      }
    }
    const transit = await transitCardAt(e.point);
    if (transit) {
      showPlace(transit, { fly: false });
      return;
    }
    const named = nameAt(map, e.point);
    if (named) {
      const [lon, lat] = named.coords || [e.lngLat.lng, e.lngLat.lat];
      showPlace({ name: named.name, lat, lon }, { fly: false });
      return;
    }
    if ($("#placeCard").classList.contains("hidden")) {
      showPlace({ name: "Dropped pin", lat: e.lngLat.lat, lon: e.lngLat.lng }, { fly: false });
    } else {
      hidePlace();
    }
  });
}

/* ---- the tray ---- */

function wireTray() {
  $("#directionsBtn").addEventListener("click", () => {
    if ($("#directionsPanel").classList.contains("hidden")) openDirections();
    else closeDirections();
  });
  $("#savedBtn").addEventListener("click", openSaved);
  $("#packsBtn").addEventListener("click", openPacks);
  $("#layersBtn").addEventListener("click", () => {
    openLayers();
    openModal("layersModal");
  });
  $("#nearbyBtn").addEventListener("click", () => openNearby(null));
  $("#locateBtn").addEventListener("click", async () => {
    try {
      const pos = await currentPosition();
      setYouMarker(pos.lat, pos.lon);
      const map = getMap();
      map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 16) });
    } catch (err) {
      toast(err.code === 1 ? "Allow location access to see where you are" : "Couldn't find your location", { error: true });
    }
  });
}

/* ---- starting up ---- */

async function boot() {
  initTheme();
  hydrateIcons();
  updateThemeButtonIcon();
  buildThemeModal();
  wireModals();
  initTray();
  initUpdateBar();

  wirePacks();
  wirePlaces();
  wireDirections();
  wireNav();
  wireShare();
  wireNearby();
  wireLayers();
  wireTray();
  wireSearch();

  window.addEventListener("uwu:hydrate", (e) => hydrateIcons(e.detail));
  setPlaceHandlers({
    directions: (place) => openDirections({ from: "here", to: place }),
    share: sharePlace,
    shareList,
  });
  setDirectionsHandlers({
    start: (route, ends) => {
      closeDirections();
      startNavigation(route, ends);
    },
    share: shareDirections,
  });
  onNearbyReceive(receiveShared);

  await initPacks();
  const map = await initMap();
  // Saved places first, so the layers' saved on and off applies to them too.
  onStyle(addSavedLayer);
  initTransit();
  wireMapTap(map);
  map.once("load", () => {
    openIncoming();
    // A link opened in a tab already on the app changes only the part after the #.
    window.addEventListener("hashchange", openIncoming);
  });
}

boot().catch((err) => {
  console.error(err);
  toast("The map couldn't start. Try reloading.", { error: true });
});

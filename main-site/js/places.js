// Saved places, the card a place opens in, and syncing them between devices with a code.
//
// Places live on the device first. Each carries when it last changed, and a deleted one stays as a
// marker for a while, so two devices merging can tell "deleted there" from "not added here yet".

import { fitCoords, clearPlaceMarker, getMap, setPlaceMarker } from "./map.js";
import { $, escapeHtml, hydrateIcons, isOnline, openModal, closeModal, readJson, roundCoord, toast, writeJson } from "./ui.js";

const PLACES_KEY = "uwumaps.places";
const SYNC_KEY = "uwumaps.syncCode";
const DEFAULT_LIST = "Saved";
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 12;

let places = readJson(PLACES_KEY, {});
let currentPlace = null;
let handlers = { directions() {}, share() {}, shareList() {} };

export const setPlaceHandlers = (h) => {
  handlers = { ...handlers, ...h };
};

export const savedPlaces = () => Object.values(places).filter((p) => !p.deleted).sort((a, b) => a.name.localeCompare(b.name));

const placeId = (p) => `${roundCoord(p.lat)},${roundCoord(p.lon)}`;
export const isSaved = (p) => Boolean(places[placeId(p)] && !places[placeId(p)].deleted);

function persist() {
  writeJson(PLACES_KEY, places);
  scheduleSync();
}

export function savePlace(p, list = DEFAULT_LIST) {
  const id = placeId(p);
  places[id] = { id, name: p.name, sub: p.sub || "", lat: roundCoord(p.lat), lon: roundCoord(p.lon), list, t: Date.now() };
  persist();
  drawSavedPins();
}

export function unsavePlace(p) {
  const id = placeId(p);
  if (places[id]) places[id] = { id, deleted: true, t: Date.now(), lat: places[id].lat, lon: places[id].lon, name: places[id].name };
  persist();
  drawSavedPins();
}

/* ---- the card ---- */

export function hidePlace() {
  currentPlace = null;
  $("#placeCard").classList.add("hidden");
  clearPlaceMarker();
}

function syncSaveButton() {
  if (!currentPlace) return;
  $("#placeSaveLabel").textContent = isSaved(currentPlace) ? "Saved" : "Save";
}

// place: { name, sub, lat, lon, detail (trusted HTML, built by the app), links }
export function showPlace(place, { fly = true } = {}) {
  currentPlace = place;
  $("#placeName").textContent = place.name;
  $("#placeSub").textContent = place.sub || `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
  $("#placeDetail").innerHTML = place.detail || "";
  $("#placeLinks").innerHTML = (place.links || []).map((l) => `<a class="btn" href="${escapeHtml(l.href)}" target="_blank" rel="noopener"><span data-icon="${escapeHtml(l.icon || "share")}"></span>${escapeHtml(l.text)}</a>`).join("");
  hydrateIcons($("#placeLinks"));
  $("#placeLinks").hidden = !(place.links || []).length;
  syncSaveButton();
  $("#placeCard").classList.remove("hidden");
  setPlaceMarker(place.lat, place.lon);
  if (fly) {
    const map = getMap();
    map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(map.getZoom(), 16), essential: false });
  }
}

export const getCurrentPlace = () => currentPlace;

/* ---- saved pins on the map ---- */

export function drawSavedPins() {
  const map = getMap();
  if (!map?.getSource("saved")) return;
  map.getSource("saved").setData({
    type: "FeatureCollection",
    features: savedPlaces().map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { id: p.id, name: p.name } })),
  });
}

export function addSavedLayer(map) {
  if (!map.getSource("saved")) map.addSource("saved", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  if (!map.getLayer("saved")) {
    map.addLayer({ id: "saved", type: "circle", source: "saved", paint: { "circle-radius": 7, "circle-color": "#e8486f", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  }
  drawSavedPins();
}

/* ---- the sheet ---- */

const lists = () => [...new Set(savedPlaces().map((p) => p.list || DEFAULT_LIST))].sort();

function renderSaved() {
  const body = $("#savedList");
  const all = savedPlaces();
  if (!all.length) {
    body.innerHTML = `<p class="empty-note">Places you save show here, and work offline.</p>`;
    return;
  }
  const names = lists();
  body.innerHTML = `<datalist id="savedLists">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("")}</datalist>` + names.map((list) => `
    <div class="pack-top">
      <p class="pack-group">${escapeHtml(list)}</p>
      <button class="btn" type="button" data-share-list="${escapeHtml(list)}"><span data-icon="share"></span>Share list</button>
    </div>
    ${all.filter((p) => (p.list || DEFAULT_LIST) === list).map((p) => `
      <div class="saved-item">
        <button class="saved-open" type="button" data-open="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>
        <input class="field list-field" list="savedLists" value="${escapeHtml(p.list || DEFAULT_LIST)}" data-move="${escapeHtml(p.id)}" aria-label="List for ${escapeHtml(p.name)}">
        <button class="icon-btn small" type="button" data-forget="${escapeHtml(p.id)}" aria-label="Remove ${escapeHtml(p.name)}" title="Remove"><span data-icon="trash"></span></button>
      </div>`).join("")}`).join("");
  hydrateIcons(body);
}

/* ---- sync ---- */

let syncTimer = null;
let syncState = "";
const syncCode = () => {
  try {
    return localStorage.getItem(SYNC_KEY) || "";
  } catch {
    return "";
  }
};

function setSyncCode(code) {
  try {
    if (code) localStorage.setItem(SYNC_KEY, code);
    else localStorage.removeItem(SYNC_KEY);
  } catch {
    // For this page view.
  }
}

function newCode() {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < limit) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}

const normaliseCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

function scheduleSync() {
  if (!syncCode()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

export async function syncNow() {
  const code = syncCode();
  if (!code || !isOnline()) return;
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, places }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
    // The server's answer already holds the newest of everything, this device's included.
    places = body.places || places;
    writeJson(PLACES_KEY, places);
    drawSavedPins();
    syncState = `Synced at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    renderSaved();
    syncSaveButton();
  } catch (err) {
    syncState = err.message;
  }
  renderSync();
}

function renderSync() {
  const el = $("#syncSection");
  const code = syncCode();
  if (code) {
    el.innerHTML = `
      <p class="code-big">${escapeHtml(code.replace(/(.{4})(?=.)/g, "$1 "))}</p>
      <p class="muted">Enter this code on another device to share these places. Anyone with it can see and change them.</p>
      <p class="muted" role="status">${escapeHtml(syncState)}</p>
      <div class="row">
        <button class="btn" type="button" id="syncRun"><span data-icon="sync"></span>Sync now</button>
        <button class="btn btn-quiet" type="button" id="syncOff">Turn off</button>
      </div>`;
  } else {
    el.innerHTML = `
      <p class="muted">Keep saved places the same on your devices, with a code and no account.</p>
      <div class="row">
        <button class="btn" type="button" id="syncNew"><span data-icon="sync"></span>Start syncing</button>
      </div>
      <div class="row">
        <input class="field grow" id="syncJoinCode" type="text" placeholder="Or enter a code" aria-label="Sync code" autocomplete="off" autocapitalize="characters">
        <button class="btn" type="button" id="syncJoin">Join</button>
      </div>
      <p class="muted" role="status">${escapeHtml(syncState)}</p>`;
  }
  hydrateIcons(el);
}

export function openSaved() {
  openModal("savedModal");
  renderSaved();
  renderSync();
}

export function wirePlaces() {
  $("#placeClose").addEventListener("click", hidePlace);
  $("#placeGo").addEventListener("click", () => currentPlace && handlers.directions(currentPlace));
  $("#placeFrom").addEventListener("click", () => currentPlace && handlers.directionsFrom(currentPlace));
  $("#placeShare").addEventListener("click", () => currentPlace && handlers.share(currentPlace));
  $("#placeSave").addEventListener("click", () => {
    if (!currentPlace) return;
    if (isSaved(currentPlace)) unsavePlace(currentPlace);
    else savePlace(currentPlace);
    syncSaveButton();
  });

  $("#savedList").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) {
      const p = places[open.dataset.open];
      closeModal("savedModal");
      if (p) showPlace(p);
      return;
    }
    const forget = e.target.closest("[data-forget]");
    if (forget) {
      unsavePlace(places[forget.dataset.forget]);
      renderSaved();
      return;
    }
    const share = e.target.closest("[data-share-list]");
    if (share) {
      const name = share.dataset.shareList;
      const items = savedPlaces().filter((p) => (p.list || DEFAULT_LIST) === name);
      closeModal("savedModal");
      handlers.shareList(name, items);
    }
  });
  $("#savedList").addEventListener("change", (e) => {
    const move = e.target.closest("[data-move]");
    if (!move) return;
    const p = places[move.dataset.move];
    if (!p) return;
    p.list = move.value.trim() || DEFAULT_LIST;
    p.t = Date.now();
    persist();
    renderSaved();
  });

  $("#syncSection").addEventListener("click", (e) => {
    if (e.target.closest("#syncNew")) {
      if (!isOnline()) {
        toast("Syncing needs a connection", { error: true });
        return;
      }
      setSyncCode(newCode());
      syncState = "";
      renderSync();
      syncNow();
    } else if (e.target.closest("#syncJoin")) {
      const code = normaliseCode($("#syncJoinCode").value);
      if (code.length !== CODE_LENGTH || ![...code].every((c) => CODE_ALPHABET.includes(c))) {
        syncState = `A code is ${CODE_LENGTH} letters and numbers.`;
        renderSync();
        return;
      }
      setSyncCode(code);
      syncState = "";
      renderSync();
      syncNow();
    } else if (e.target.closest("#syncRun")) {
      syncNow();
    } else if (e.target.closest("#syncOff")) {
      setSyncCode("");
      syncState = "";
      renderSync();
    }
  });

  window.addEventListener("online", scheduleSync);
  if (syncCode()) scheduleSync();
}

// Puts several places on the map at once, for a list opened from a link.
export function fitPlaces(items) {
  fitCoords(items.map((p) => [p.lon, p.lat]));
}

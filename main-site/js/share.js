// Sharing: short links through /api/share (places, directions, live ETAs and lists), and links that
// hold everything themselves, which is what makes sharing possible with no connection. Also what
// opening any of those does.

import { closeDirections, openDirections } from "./directions.js";
import { clearRoute, fitCoords, setYouMarker, showRoute } from "./map.js";
import { navProgress, isNavigating, lastFix, setEtaHooks } from "./nav.js";
import { openNearby, selfLink } from "./nearby.js";
import { fitPlaces, savePlace, showPlace } from "./places.js";
import { $, closeModal, escapeHtml, formatClock, formatDuration, hydrateIcons, isOnline, openModal, readJson, roundCoord, toast } from "./ui.js";

const NAME_KEY = "uwumaps.shareName";
const ETA_EVERY_MS = 15000;
const ETA_POLL_MS = 10000;

let card = null;

const placeOf = (p) => ({ label: p.name, lat: roundCoord(p.lat), lng: roundCoord(p.lon) });
const fromLink = (p) => ({ name: p.label, lat: p.lat, lon: p.lng });
const endOf = (end) => (end === "here" ? "here" : placeOf(end));
const thin = (coords, max) => {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)]);
};
const pathOf = (coords) => thin(coords, 400).map(([lon, lat]) => [roundCoord(lat), roundCoord(lon)]);

async function makeLink(kind, data) {
  const res = await fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, data }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
  return body;
}

/* ---- the sheet ---- */

async function showCard({ title, kind, data, offlineUrl, payload }) {
  card = { title, kind, data, offlineUrl, payload, url: offlineUrl };
  $("#shareWhat").textContent = title;
  $("#shareLink").value = offlineUrl;
  $("#shareNote").textContent = "";
  $("#shareMap").classList.add("hidden");
  $("#shareMap").removeAttribute("src");
  openModal("shareModal");

  if (!isOnline()) {
    $("#shareNote").textContent = "You're offline, so this is a long link. Nearby sends it with a QR code.";
    return;
  }
  $("#shareNote").textContent = "Making a short link...";
  try {
    const made = await makeLink(kind, data);
    if (card?.kind !== kind || card.title !== title) return;
    card.url = `${location.origin}${made.path}`;
    $("#shareLink").value = card.url;
    $("#shareNote").textContent = "";
    $("#shareMap").src = `/api/share-map?id=${encodeURIComponent(made.id)}`;
    $("#shareMap").onload = () => $("#shareMap").classList.remove("hidden");
    $("#shareMap").onerror = () => $("#shareMap").classList.add("hidden");
  } catch {
    // Long links work everywhere the short ones do.
    if (card?.kind === kind) $("#shareNote").textContent = "";
  }
}

export function sharePlace(p) {
  const data = placeOf(p);
  showCard({
    title: p.name,
    kind: "place",
    data,
    offlineUrl: selfLink({ kind: "place", data }),
    payload: { kind: "place", data },
  });
}

export function shareDirections(state) {
  const data = {
    from: endOf(state.from === "here" ? "here" : state.from),
    to: endOf(state.to === "here" ? "here" : state.to),
    mode: state.mode,
    summary: `${formatDuration(state.route.duration)}, ${(state.route.distance / 1000).toFixed(1)} km`,
    path: pathOf(state.route.coords),
  };
  const compact = { kind: "directions", data: { from: data.from, to: data.to, mode: data.mode } };
  const fromName = data.from === "here" ? "Your location" : data.from.label;
  const toName = data.to === "here" ? "Your location" : data.to.label;
  showCard({ title: `${fromName} to ${toName}`, kind: "directions", data, offlineUrl: selfLink(compact), payload: compact });
}

export function shareList(name, items) {
  const data = { name, places: items.slice(0, 200).map(placeOf) };
  const payload = { kind: "list", data };
  showCard({ title: `${name} (${data.places.length} places)`, kind: "list", data, offlineUrl: selfLink(payload), payload });
}

function wireShareSheet() {
  $("#shareCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#shareLink").value);
      toast("Link copied");
    } catch {
      $("#shareLink").select();
      toast("Press copy on your keyboard");
    }
  });
  $("#shareSend").addEventListener("click", async () => {
    const url = $("#shareLink").value;
    if (navigator.share) {
      try {
        await navigator.share({ title: card?.title || "uwuMaps", url });
      } catch {
        // Closed.
      }
    } else {
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copied");
      } catch {
        $("#shareLink").select();
      }
    }
  });
  $("#shareNearby").addEventListener("click", () => {
    closeModal("shareModal");
    openNearby(card?.payload || null);
  });
  $("#listSaveAll").addEventListener("click", () => {
    const list = $("#listModal").list;
    if (!list) return;
    for (const p of list.places) savePlace(fromLink(p), list.name);
    closeModal("listModal");
    toast(`Saved ${list.places.length} places to ${list.name}`);
  });
}

/* ---- sharing an ETA while navigating ---- */

let eta = null; // { id, secret, url, timer }

function etaBody(extra = {}) {
  const p = navProgress();
  const fix = lastFix();
  return {
    name: readJson(NAME_KEY, ""),
    to: placeOf(p.to),
    arriveAt: Math.round(Date.now() + (p.secondsLeft ?? p.route.duration) * 1000),
    mode: p.mode,
    path: pathOf(p.route.coords),
    me: fix ? { lat: roundCoord(fix.lat), lng: roundCoord(fix.lon), accuracy: fix.accuracy, t: fix.t } : null,
    ended: false,
    stopped: false,
    ...extra,
  };
}

async function pushEta(extra) {
  if (!eta) return;
  try {
    await fetch("/api/share", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: eta.id, secret: eta.secret, data: etaBody(extra) }),
    });
  } catch {
    // The next one will catch up.
  }
}

async function toggleEta() {
  if (eta) {
    await stopEta("stopped");
    return;
  }
  if (!isOnline()) {
    toast("Sharing an ETA needs a connection", { error: true });
    return;
  }
  try {
    const made = await makeLink("eta", etaBody());
    eta = { id: made.id, secret: made.secret, url: `${location.origin}${made.path}`, last: Date.now() };
    $("#navShareLabel").textContent = "Stop sharing";
    const url = eta.url;
    if (navigator.share) {
      try {
        await navigator.share({ title: "My ETA on uwuMaps", url });
        return;
      } catch {
        // Closed: fall through to the clipboard.
      }
    }
    await navigator.clipboard?.writeText(url).catch(() => {});
    toast("Live ETA link copied. It stops when you do.");
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function stopEta(how) {
  if (!eta) return;
  const finishing = how === "arrived" ? { ended: true } : { stopped: true };
  // One last update while navProgress still knows the route.
  await pushEta(finishing);
  eta = null;
  $("#navShareLabel").textContent = "Share ETA";
}

setEtaHooks({
  update() {
    if (eta && isNavigating() && Date.now() - eta.last >= ETA_EVERY_MS) {
      eta.last = Date.now();
      pushEta();
    }
  },
  stop(arrived) {
    stopEta(arrived ? "arrived" : "stopped");
  },
});

/* ---- following somebody's ETA ---- */

let watching = null;

function drawEta(id, data, updatedAt) {
  const who = data.name || "Someone";
  $("#etaTitle").textContent = data.stopped
    ? `${who} stopped sharing`
    : data.ended ? `${who} has arrived at ${data.to.label}` : `${who} is heading to ${data.to.label}`;
  const ago = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
  $("#etaDetail").textContent = data.ended || data.stopped
    ? ""
    : `Arriving around ${formatClock(data.arriveAt)}. Updated ${ago ? `${ago} min ago` : "just now"}.`;
  $("#etaView").classList.remove("hidden");
  if (data.path?.length >= 2) showRoute(data.path.map(([la, lo]) => [lo, la]));
  if (data.me) setYouMarker(data.me.lat, data.me.lng);
}

async function watchEta(id, first) {
  stopWatching();
  closeDirections();
  watching = { id };
  drawEta(id, first.data, first.updatedAt);
  if (first.data.path?.length >= 2) fitCoords(first.data.path.map(([la, lo]) => [lo, la]));
  const poll = async () => {
    if (watching?.id !== id) return;
    try {
      const res = await fetch(`/api/share?id=${encodeURIComponent(id)}`);
      if (res.status === 404) {
        $("#etaTitle").textContent = "This trip has ended";
        $("#etaDetail").textContent = "";
        return;
      }
      if (res.ok) {
        const body = await res.json();
        if (watching?.id === id) drawEta(id, body.data, body.updatedAt);
        if (body.data.ended || body.data.stopped) return;
      }
    } catch {
      // Offline for now: the next try may work.
    }
    if (watching?.id === id) watching.timer = setTimeout(poll, ETA_POLL_MS);
  };
  watching.timer = setTimeout(poll, ETA_POLL_MS);
}

function stopWatching() {
  if (watching?.timer) clearTimeout(watching.timer);
  watching = null;
}

/* ---- opening a link ---- */

function openList(data) {
  const modal = $("#listModal");
  modal.list = data;
  $("#listTitle").textContent = data.name;
  $("#listPlaces").innerHTML = data.places.map((p, i) => `
    <div class="saved-item"><button class="saved-open" type="button" data-list-open="${i}">${escapeHtml(p.label)}</button></div>`).join("");
  hydrateIcons(modal);
  openModal("listModal");
  fitPlaces(data.places.map(fromLink));
}

function applyLink(kind, data, extra) {
  if (kind === "place") {
    showPlace(fromLink(data));
  } else if (kind === "directions") {
    const end = (e) => (e === "here" ? "here" : fromLink(e));
    openDirections({ from: end(data.from), to: end(data.to), mode: data.mode });
  } else if (kind === "list") {
    openList(data);
  } else if (kind === "eta") {
    watchEta(extra.id, { data, updatedAt: extra.updatedAt });
  }
}

const SHARE_PATH = /^\/(go|trip|eta|list)\/([a-z0-9]{10})$/;

async function openShortLink(id) {
  if (!isOnline()) {
    toast("Opening this link needs a connection", { error: true });
    return;
  }
  try {
    const res = await fetch(`/api/share?id=${encodeURIComponent(id)}`);
    if (res.status === 404) {
      toast("That link has expired or doesn't exist", { error: true });
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    applyLink(body.kind, body.data, { id, updatedAt: body.updatedAt });
  } catch {
    toast("Couldn't open that link. Try again in a moment.", { error: true });
  }
}

function decodeSelfLink(hash) {
  try {
    if (!hash.startsWith("#s=")) return null;
    const b64 = hash.slice(3).replace(/-/g, "+").replace(/_/g, "/");
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Opens an address of ours. Answers whether it was one.
function openAddress(pathname, hash) {
  const path = SHARE_PATH.exec(pathname);
  if (path) {
    openShortLink(path[2]);
    return true;
  }
  const short = /^#share\/([a-z0-9]{10})$/.exec(hash);
  if (short) {
    history.replaceState(null, "", "/");
    openShortLink(short[1]);
    return true;
  }
  const self = decodeSelfLink(hash);
  if (self?.kind && self.data && validSelfLink(self)) {
    history.replaceState(null, "", "/");
    applyLink(self.kind, self.data, {});
    return true;
  }
  const join = /^#join=([A-Za-z0-9]+)$/.exec(hash);
  if (join) {
    history.replaceState(null, "", "/");
    openNearby(null, { join: join[1] });
    return true;
  }
  return false;
}

// Opens whatever address the page was opened at.
export function openIncoming() {
  openAddress(location.pathname, location.hash);
}

// Opens a scanned link, ours whichever way it came: this site, maps.uwuapps.org or uwu://maps/. Answers whether it was.
export function openScanned(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const ours = url.origin === location.origin || url.hostname === "maps.uwuapps.org" || (url.protocol === "uwu:" && url.hostname === "maps");
  return ours && openAddress(url.pathname, url.hash);
}

const validPoint = (p) => p && typeof p.label === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

// A link's contents came from outside the app, so they're checked rather than trusted.
export function validSelfLink({ kind, data }) {
  if (kind === "place") return validPoint(data);
  if (kind === "directions") {
    const end = (e) => e === "here" || validPoint(e);
    return end(data.from) && end(data.to) && ["foot", "bike", "car"].includes(data.mode);
  }
  if (kind === "list") return typeof data.name === "string" && Array.isArray(data.places) && data.places.length <= 200 && data.places.every(validPoint);
  return false;
}

export function receiveShared(payload) {
  if (validSelfLink(payload)) applyLink(payload.kind, payload.data, {});
}

export function wireShare() {
  wireShareSheet();
  $("#navShareEta").addEventListener("click", toggleEta);
  $("#etaClose").addEventListener("click", () => {
    stopWatching();
    $("#etaView").classList.add("hidden");
    clearRoute();
  });
  $("#listPlaces").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-list-open]");
    if (!btn) return;
    const p = $("#listModal").list?.places[Number(btn.dataset.listOpen)];
    if (p) {
      closeModal("listModal");
      showPlace(fromLink(p));
    }
  });
}

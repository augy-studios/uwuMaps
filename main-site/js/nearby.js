// Sending a place, a route or a list to a device nearby. Two ways, each saying what it needs:
//
//   QR code      The whole thing fits in the link, so it needs no connection on either device. The
//                other device needs only a camera, and uwuMaps opened once before to open it offline.
//   Code         Direct between two browsers (docs/STUN-p2p-spec.md), for what's too big for a QR
//                code. A public broker introduces them, so both need a connection to start, and a
//                network that lets them reach each other: the same wifi, or a hotspot from one.
//
// A one-off send has no changing state, so unlike the spec's 20-a-second snapshots the host sends the
// snapshot when asked, and the channel closing is what ends it.

import qrcode from "/vendor/qrcode/qrcode.mjs";
import { CODE_LENGTH, Guest, Host, generateCode, isValidCode, normaliseCode } from "./p2p.js";
import { savedPlaces } from "./places.js";
import { canScan, scanCode } from "./scanner.js";
import { $, closeModal, escapeHtml, hydrateIcons, isOnline, openModal, roundCoord } from "./ui.js";

// Past about this long a link makes a QR code too dense for a phone's camera to read reliably.
const QR_MAX = 1200;

let host = null;
let guest = null;
let retried = false;
let receiveHandler = () => {};
export const onNearbyReceive = (fn) => {
  receiveHandler = fn;
};
let scanHandler = () => false;
export const onNearbyScan = (fn) => {
  scanHandler = fn;
};

/* ---- links that hold everything ---- */

export function selfLink(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${location.origin}/#s=${b64}`;
}

function qrSvg(text) {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

/* ---- the status lines ---- */

const STATUS_TEXT = {
  connecting: "Connecting...",
  waiting: "Waiting for the other device. Enter this code there, or scan this.",
  connected: "Connected. Sending...",
  dropped: "The connection dropped.",
  unreachable: "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.",
};

function setStatus(text, tone = "") {
  const el = $("#nearbyStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `status-line ${tone}`;
}

/* ---- sending by code ---- */

function stopHosting() {
  host?.close();
  host = null;
}

async function startHosting(payload) {
  stopHosting();
  if (!isOnline()) {
    setStatus("Sending by code needs a connection to start. The QR code above works without one.", "error");
    return;
  }
  const code = generateCode();
  const link = `${location.origin}/#join=${code}`;
  $("#nearbyHost").innerHTML = `
    <p class="code-big">${escapeHtml(code)}</p>
    <div class="qr-wrap">${qrSvg(link)}</div>`;
  host = new Host();
  host.addEventListener("status", ({ detail }) => {
    if (detail.taken && !retried) {
      // Something else holds the code: a fresh one, once, silently.
      retried = true;
      startHosting(payload);
      return;
    }
    if (detail.status === "waiting") retried = false;
    if (detail.status === "error") setStatus(detail.message, "error");
    else if (STATUS_TEXT[detail.status]) setStatus(STATUS_TEXT[detail.status]);
  });
  host.addEventListener("message", ({ detail: { message, from } }) => {
    if (message.type === "hello") host.send({ type: "state", payload }, from);
    else if (message.type === "got") {
      setStatus("Sent.", "ok");
    }
  });
  try {
    await host.start(code);
  } catch {
    host = null;
    setStatus("Could not load pairing. Check your connection.", "error");
  }
}

/* ---- receiving by code ---- */

function stopGuest() {
  guest?.close();
  guest = null;
}

async function join(input) {
  const code = normaliseCode(input);
  if (!isValidCode(code)) {
    setStatus(`A code is ${CODE_LENGTH} letters and numbers.`, "error");
    return;
  }
  if (!isOnline()) {
    setStatus("Receiving by code needs a connection to start. Ask them to show the QR code instead.", "error");
    return;
  }
  stopGuest();
  guest = new Guest();
  guest.addEventListener("status", ({ detail }) => {
    if (detail.status === "error") setStatus(detail.message, "error");
    else if (detail.status === "connecting") setStatus("Connecting...");
    else if (detail.status === "connected") setStatus("Connected. Receiving...");
    else if (detail.status === "unreachable") setStatus(STATUS_TEXT.unreachable, "error");
    else if (detail.status === "dropped") setStatus("The other device has closed the connection.");
  });
  guest.addEventListener("message", ({ detail: { message } }) => {
    if (message.type !== "state" || !message.payload) return;
    guest.send({ type: "got" });
    setStatus("Received.", "ok");
    const payload = message.payload;
    closeModal("nearbyModal");
    stopGuest();
    receiveHandler(payload);
  });
  try {
    await guest.connect(code);
  } catch {
    setStatus("Could not load pairing. Check your connection.", "error");
  }
}

/* ---- the sheet ---- */

function savedAsPayload() {
  const places = savedPlaces().slice(0, 200).map((p) => ({ label: p.name, lat: roundCoord(p.lat), lng: roundCoord(p.lon) }));
  return places.length ? { kind: "list", data: { name: "From a nearby device", places } } : null;
}

function sendSection(payload) {
  const link = selfLink(payload);
  const fits = link.length <= QR_MAX;
  return `
    <p class="modal-section-label">Send with a QR code, no connection needed</p>
    ${fits ? `<div class="qr-wrap">${qrSvg(link)}</div><p class="muted">Scan this with the other device's camera, or with Scan a code in uwuMaps. It opens with no connection if uwuMaps has been opened there before.</p>`
    : `<p class="muted">This is too big for a QR code. Send it by code instead.</p>`}
    <p class="modal-section-label">Or send by code</p>
    <p class="muted">Both devices need a connection to start, and to be on the same wifi or a hotspot from one of them.</p>
    <button class="btn" type="button" id="nearbyStart"><span data-icon="nearby"></span>Show a code</button>
    <div id="nearbyHost"></div>`;
}

function receiveSection(prefill = "") {
  return `
    <p class="modal-section-label">Receive by code</p>
    <div class="row">
      <input class="field grow" id="nearbyCode" type="text" value="${escapeHtml(prefill)}" placeholder="Code from the other device" aria-label="Code" autocomplete="off" autocapitalize="characters" maxlength="8">
      <button class="btn btn-primary" type="button" id="nearbyJoin">Receive</button>
    </div>`;
}

export function openNearby(payload, { join: joinCode } = {}) {
  const body = $("#nearbyBody");
  const sending = payload || savedAsPayload();
  body.innerHTML = `
    ${joinCode ? receiveSection(normaliseCode(joinCode)) : ""}
    ${sending ? sendSection(sending) : ""}
    ${joinCode ? "" : receiveSection()}
    ${canScan() ? `<button class="btn" type="button" id="nearbyScan"><span data-icon="qr"></span>Scan a code</button>` : ""}
    <p id="nearbyStatus" class="status-line" role="status"></p>`;
  hydrateIcons(body);
  $("#nearbyTitle").textContent = sending && !joinCode ? "Send to a device nearby" : "Receive from a device nearby";
  $("#nearbyStart")?.addEventListener("click", () => startHosting(sending));
  $("#nearbyJoin").addEventListener("click", () => join($("#nearbyCode").value));
  $("#nearbyScan")?.addEventListener("click", async () => {
    const scanned = await scanCode();
    if (scanned == null) return;
    // Closed first, as what the link opens can be this very sheet.
    closeModal("nearbyModal");
    if (!scanHandler(scanned)) {
      openModal("nearbyModal");
      setStatus("That code isn't a uwuMaps link.", "error");
    }
  });
  openModal("nearbyModal");
  if (joinCode) join(joinCode);
}

export function wireNearby() {
  // Closing the sheet ends the session, so a code shown to a room doesn't keep working.
  const modal = $("#nearbyModal");
  new MutationObserver(() => {
    if (modal.classList.contains("hidden")) {
      stopHosting();
      stopGuest();
    }
  }).observe(modal, { attributes: true, attributeFilter: ["class"] });
}

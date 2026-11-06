// Scanning another device's QR code with the camera, which is asked for here, at the moment it's wanted. The
// decoder only loads now too. It's vendored because Safari has no QR reader of its own to ask.

import { $, closeModal, openModal } from "./ui.js";

const JSQR_URL = "/vendor/jsqr/jsQR.js";
// A code on a phone's screen reads fine at this size, and bigger only slows it down.
const WIDEST_PX = 640;
const EVERY_MS = 120;

let decoder = null;

function loadDecoder() {
  decoder ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSQR_URL;
    script.async = true;
    script.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error("jsQR did not load")));
    script.onerror = () => reject(new Error("Could not load the QR reader"));
    document.head.appendChild(script);
  }).catch((err) => {
    decoder = null;
    throw err;
  });
  return decoder;
}

export const canScan = () => Boolean(navigator.mediaDevices?.getUserMedia);

// Answers what the code says, or null if the sheet's closed first.
export function scanCode() {
  const modal = $("#scanModal");
  const video = $("#scanVideo");
  const status = $("#scanStatus");
  status.textContent = "Starting the camera...";
  openModal("scanModal");

  return new Promise((resolve) => {
    let stream = null;
    let timer = null;
    let done = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      closeModal("scanModal");
      resolve(value);
    };
    // However the sheet is closed, the camera goes off.
    const watcher = new MutationObserver(() => {
      if (modal.classList.contains("hidden")) finish(null);
    });
    watcher.observe(modal, { attributes: true, attributeFilter: ["class"] });

    const look = (read) => {
      if (done) return;
      if (video.videoWidth) {
        const scale = Math.min(1, WIDEST_PX / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = read(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          finish(code.data);
          return;
        }
      }
      timer = setTimeout(() => look(read), EVERY_MS);
    };

    (async () => {
      try {
        const read = await loadDecoder();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (done) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        status.textContent = "Point at a uwuMaps code";
        look(read);
      } catch (err) {
        if (done) return;
        status.textContent = err.name === "NotAllowedError" ? "Allow the camera to scan a code. You can do that in your browser's settings for this site." : "The camera couldn't start.";
      }
    })();
  });
}

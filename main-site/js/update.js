// The bar at the very top of the page (docs/update-bar-spec.md). It says one of two things, and only
// the more urgent one draws: being offline outranks a new version being ready.
//
// A new service worker never activates on its own. It downloads, it installs and it waits, and the
// only thing that promotes it is somebody pressing Reload.

import { escapeHtml, isOnline, toast } from "./ui.js";
import { publishBannerHeight } from "./tray.js";

const SW_URL = "/sw.js";
const SITE_NAME = "uwuMaps";

let registration = null;
let waitingWorker = null;
let reloading = false;
let dismissed = false; // For this page view only, and never stored: "not now" means not now.

function render() {
  const offline = navigator.onLine === false;
  const showUpdate = Boolean(waitingWorker) && !dismissed;
  const existing = document.querySelector(".update-notice");

  if (!offline && !showUpdate) {
    existing?.remove();
    publishBannerHeight(null);
    return;
  }

  const bar = existing ?? document.createElement("div");
  bar.className = "update-notice";
  bar.setAttribute("role", "status");
  if (offline) {
    bar.setAttribute("aria-label", "Connection");
    bar.innerHTML = `
      <div class="update-notice-inner">
        <p>You're offline. Saved areas still work.</p>
      </div>`;
  } else {
    bar.setAttribute("aria-label", "Update");
    bar.innerHTML = `
      <div class="update-notice-inner">
        <p>${escapeHtml(`A new version of ${SITE_NAME} is ready.`)}</p>
        <button type="button" class="btn btn-primary" data-sw-update>Reload</button>
        <button type="button" class="btn btn-quiet" data-sw-later>Not now</button>
      </div>`;
    bar.querySelector("[data-sw-update]").addEventListener("click", () => {
      // The only place anything asks for skipWaiting. The reload happens on controllerchange.
      waitingWorker?.postMessage("skip-waiting");
    });
    bar.querySelector("[data-sw-later]").addEventListener("click", () => {
      dismissed = true;
      render();
    });
  }
  if (!existing) document.body.prepend(bar);
  publishBannerHeight(bar);
}

// The tray's Check for updates. The same bar says so if there's a new version, and otherwise this does.
export async function checkForUpdates() {
  if (!isOnline()) {
    toast("Checking for updates needs a connection", { error: true });
    return;
  }
  if (!registration) {
    toast(`Updates for ${SITE_NAME} aren't available in this browser`, { error: true });
    return;
  }
  try {
    await registration.update();
    const installing = registration.installing;
    if (installing) {
      await new Promise((resolve) => {
        const look = () => {
          if (installing.state === "installed" || installing.state === "redundant") resolve();
        };
        installing.addEventListener("statechange", look);
        look();
      });
    }
  } catch {
    toast("Couldn't check for updates. Try again in a moment.", { error: true });
    return;
  }
  waitingWorker = registration.waiting || waitingWorker;
  dismissed = false;
  if (waitingWorker) render();
  else toast(`You have the newest version of ${SITE_NAME}`);
}

function watchForUpdate() {
  if (!registration) return;

  // A worker already waiting when the page opened: the ordinary case, on the next visit after a
  // deploy. Without this the prompt only reaches somebody with the page open at that moment.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    render();
  }

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // `installed` with no controller is a first install, with no older version to protect.
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting ?? installing;
        render();
      }
    });
  });
}

function registerWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register(SW_URL)
    .then((reg) => {
      registration = reg;
      watchForUpdate();
      // Somebody who keeps the tab open meets the update by switching back to it.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch((cause) => {
      // A refused registration is not a reason to break the page.
      console.warn("service worker registration failed:", cause);
    });

  // Reloading here rather than on the click is what brings the page back on the new version: the
  // controller has changed by now. The flag guards against this firing twice.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

export function initUpdateBar() {
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
  render();
  // On `load`: installing fetches everything the worker precaches, and doing that while the page is
  // still fetching its own assets makes a first visit slower for no gain.
  if (document.readyState === "complete") registerWorker();
  else window.addEventListener("load", registerWorker, { once: true });
}

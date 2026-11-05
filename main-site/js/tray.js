// The Edge Tray (docs/edge-tray-spec.md): the app's global actions in a column at the top right,
// which slides off the edge when it isn't wanted, so the map gets the whole screen.

const TRAY_KEY = "uwumaps.trayOpen";

export function setTray(open, { save = true } = {}) {
  const tray = document.getElementById("tray");
  const tab = document.getElementById("trayTab");
  tray.classList.toggle("collapsed", !open);
  tab.setAttribute("aria-expanded", String(open));
  tab.setAttribute("aria-label", open ? "Hide menu" : "Show menu");
  tab.title = open ? "Hide menu" : "Show menu";
  // Off-screen buttons must not take focus or clicks.
  document.getElementById("trayButtons").inert = !open;
  document.body.classList.toggle("tray-open", open);
  if (save) {
    try {
      localStorage.setItem(TRAY_KEY, open ? "1" : "0");
    } catch {
      // Remembered for this page view only.
    }
  }
}

export function initTray() {
  let open = true;
  try {
    open = localStorage.getItem(TRAY_KEY) !== "0";
  } catch {
    // Open, the default.
  }
  setTray(open, { save: false });
  document.getElementById("trayTab").addEventListener("click", () => {
    setTray(document.getElementById("tray").classList.contains("collapsed"));
  });
  // Later toggles animate; the state on load didn't need to.
  requestAnimationFrame(() => document.documentElement.classList.remove("tray-start-collapsed"));
}

// A sticky bar at the top (the update bar, the offline bar) moves the tray and the map down.
export function publishBannerHeight(element) {
  const root = document.documentElement;
  if (publishBannerHeight.sizer) publishBannerHeight.sizer.disconnect();
  if (!element) {
    root.style.setProperty("--banner-h", "0px");
    return;
  }
  publishBannerHeight.sizer = new ResizeObserver(([entry]) => {
    root.style.setProperty("--banner-h", `${entry.target.offsetHeight}px`);
  });
  publishBannerHeight.sizer.observe(element);
}

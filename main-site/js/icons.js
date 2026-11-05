// Every icon in the app: inline SVG, inheriting its colour through currentColor.

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  directions: svg('<path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M9 14v-2a2 2 0 0 1 2-2h4"/><path d="m13 8 2 2-2 2"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-4-6 4z"/>'),
  download: svg('<path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 21h16"/>'),
  cube: svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
  locate: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>'),
  nearby: svg('<circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14"/>'),
  car: svg('<path d="M5 17H3v-5l2-5h14l2 5v5h-2"/><path d="M3 12h18"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/><path d="M9.5 17h5"/>'),
  bike: svg('<circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 9 9h6l3.5 8M9 9l3.5 8h-7M15 9l-1-3h-2"/>'),
  walk: svg('<circle cx="13" cy="4" r="2"/><path d="m8 21 3-6-1-4 3-3 2 3 3 2M10 11 7 9l-1 4"/><path d="m13 14 2 3v4"/>'),
  navigate: svg('<path d="M3 11 21 3l-8 18-2-8z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  swap: svg('<path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  sound: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 10v4h4l5 4V6L8 10z"/><path d="m17 10 4 4M21 10l-4 4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  sync: svg('<path d="M20 11a8 8 0 0 0-14-4.5L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14 4.5l2-2M20 20v-4.5h-4.5"/>'),
  pin: svg('<path d="M12 21s7-6.4 7-11.5A7 7 0 0 0 5 9.5C5 14.6 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  layers: svg('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12.5 9 5 9-5M3 17l9 5 9-5"/>'),
  train: svg('<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 10h12M9 21l1.5-4M15 21l-1.5-4"/><circle cx="9.5" cy="13.5" r=".6"/><circle cx="14.5" cy="13.5" r=".6"/>'),
  bus: svg('<rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16M8 17v3M16 17v3"/><circle cx="8" cy="14" r=".6"/><circle cx="16" cy="14" r=".6"/>'),
  turnLeft: svg('<path d="M9 7 4 12l5 5"/><path d="M4 12h9a6 6 0 0 1 6 6v3"/>'),
  turnRight: svg('<path d="m15 7 5 5-5 5"/><path d="M20 12h-9a6 6 0 0 0-6 6v3"/>'),
  straight: svg('<path d="M12 21V4M6 10l6-6 6 6"/>'),
  slightLeft: svg('<path d="M8 4h6M8 4v6M8 4l8 8v9"/>'),
  slightRight: svg('<path d="M16 4h-6M16 4v6M16 4l-8 8v9"/>'),
  uturn: svg('<path d="M8 21V9a5 5 0 0 1 10 0v5"/><path d="m14 11 4 4 4-4"/>'),
  roundabout: svg('<circle cx="12" cy="10" r="4"/><path d="M12 14v8M16 7l4-4M20 8V3h-5"/>'),
  arrive: svg('<path d="M6 21V4h12l-3 4 3 4H6"/>'),
  // A station's doors (js/mrt-doors.js), as SG Bus Timings draws them. An escalator: its handrail
  // round from the bottom landing to the top, and someone on it.
  escalator: svg('<path d="M4.5 20.5H9l10-10h.5a2.5 2.5 0 0 0 0-5H17L7 15.5H4.5a2.5 2.5 0 0 0 0 5z"/><rect x="4.4" y="10.6" width="3.2" height="4.9" rx="1.6" fill="currentColor" stroke="none"/><circle cx="6" cy="7.6" r="1.7" fill="currentColor" stroke="none"/>'),
  lift: svg('<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="m8.5 10 3.5-3.5 3.5 3.5M8.5 14l3.5 3.5 3.5-3.5"/>'),
  stairs: svg('<path d="M3 20h5v-5h5v-5h5V5h3"/>'),
  across: svg('<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  forward: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
};

export function icon(name) {
  return icons[name] || "";
}

// The arrow for a step of a route.
export function stepIcon(step) {
  if (step.type === "arrive") return "arrive";
  if (step.type === "roundabout") return "roundabout";
  if (step.type === "depart" || step.type === "continue" || step.type === "ferry") return "straight";
  const a = step.angle ?? 0;
  if (Math.abs(a) >= 165) return "uturn";
  if (Math.abs(a) < 25) return "straight";
  if (Math.abs(a) < 50) return a < 0 ? "slightLeft" : "slightRight";
  return a < 0 ? "turnLeft" : "turnRight";
}

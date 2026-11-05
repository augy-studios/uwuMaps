// A Singapore station's train doors on its card, drawn as SG Bus Timings' Explorer draws them
// (sgbus-timings: js/mrt-doors.js station(), js/map-card.js slideHtml(), js/nav.js doorNumberAt()):
// a page for each platform, a direction each, with arrows at the sides or a swipe. Each way off the
// platform is a row with its icon, where it leads, and its doors as little platform doors in the
// line's colour. Keep the two in step: the markup and the classes are the same on purpose.
//
// Doors are counted from the front of the train, all along it, and said as just the number on each
// platform screen door. A facility's `to` is where it leads, split by "/": "exit", the directions of
// the lines it's the way to ("DT-11"), and places ("Jewel", "T2").

import { icon } from "./icons.js";
import { $, escapeHtml as esc } from "./ui.js";

// Doors along each side of a train, for leaving out a number no train has: 6 cars of 4 on all but the
// Circle and Downtown lines' (3 of 4) and the Thomson-East Coast Line's (4 of 5).
const DOORS = { CC: 12, DT: 12, TE: 20 };
const ORDER = ["escalator", "lift", "stairs"];
const DOOR_TYPE = { escalator: "Escalator", lift: "Lift", stairs: "Stairs" };
const LINE_LABELS = { EWL: "EW Line", NSL: "NS Line", NEL: "NE Line", CCL: "CC Line", DTL: "DT Line", TEL: "TE Line", BPL: "BP LRT", STL: "SK LRT", PTL: "PG LRT" };
const LINE_COLOURS = { EW: "#009645", CG: "#009645", NS: "#d42e12", NE: "#9900aa", CC: "#fa9e0d", CE: "#fa9e0d", DT: "#005ec4", TE: "#9d5b25", JS: "#0099aa", JE: "#0099aa", JW: "#0099aa", CR: "#97c616", CP: "#97c616" };
const LRT = "#748477";

const lineName = (l) => LINE_LABELS[`${l}L`] || `${l}L`;
const colourOf = (code) => LINE_COLOURS[(String(code).toUpperCase().match(/^[A-Z]+/)?.[0] || "").slice(0, 2)] || LRT;
const ico = (name) => `<span class="ico" aria-hidden="true">${icon(name)}</span>`;
const listText = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const ways = (f) => String(f.to || "").split("/").map((s) => s.trim()).filter(Boolean);

// Where the number is on the platform door: on the panel above the doors at the North-South and
// East-West lines' underground stations, at the top right of each door on the other lines (all
// underground), and near the top of the post beside each door at an elevated station's half-height
// doors. Null where it isn't known which.
function numberAt(p) {
  if (p.e === 1) return "post";
  if (["NE", "CC", "DT", "TE"].includes(p.l)) return "corner";
  if (p.e === 0) return "above";
  return null;
}

// Each direction's platforms by how far into it they are.
function directions(platforms) {
  const byDir = new Map();
  for (const p of platforms) (byDir.get(p.d) || byDir.set(p.d, []).get(p.d)).push(p);
  for (const list of byDir.values()) list.sort((a, b) => a.o - b.o);
  return byDir;
}

// The way a direction goes, from station `here`: towards its far end, or on a loop, whose two ways
// both end at Promenade, towards its next station from here.
function towardsFrom(list, here) {
  const end = list[list.length - 1];
  if (list[0].n !== end.n) return end.n;
  const at = list.find((q) => q.n === here);
  return (at && list.find((q) => q.o > at.o)?.n) || end.n;
}

// Where a facility at station `here` leads, in words: "Exit", "NS Line towards Jurong East", "Jewel".
// To both ways on a line it's just the line, "NE Line".
function leadsOf(f, byDir, here) {
  const out = [];
  const lines = new Map(); // line -> the directions it leads to on it
  for (const w of ways(f)) {
    if (byDir.has(w)) {
      const l = byDir.get(w)[0].l;
      if (!lines.has(l)) out.push({ line: l });
      (lines.get(l) || lines.set(l, []).get(l)).push(w);
    } else {
      const text = w.toLowerCase() === "exit" ? "Exit" : w;
      if (!out.includes(text)) out.push(text);
    }
  }
  const words = out.map((x) => {
    if (typeof x === "string") return x;
    const dirs = lines.get(x.line);
    if (dirs.length > 1) return lineName(x.line);
    return `${lineName(x.line)} towards ${towardsFrom(byDir.get(dirs[0]), here)}`;
  });
  return words.length ? words : ["Exit"];
}

// Every platform at a station, by its codes: one for each way a train goes from it, line by line as
// the codes are given. Each row is { t, leads, doors }, and `cross` the lines across the platform.
export function stationPlatforms(codes, platforms) {
  const want = codes.map((c) => String(c).toUpperCase());
  const byDir = directions(platforms);
  const rank = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  return platforms
    .filter((p) => want.includes(p.c.toUpperCase()))
    .sort((a, b) => want.indexOf(a.c.toUpperCase()) - want.indexOf(b.c.toUpperCase()) || a.d.localeCompare(b.d) || a.o - b.o)
    .map((p) => {
      const list = byDir.get(p.d) || [p];
      const end = list[list.length - 1];
      const next = list.find((q) => q.o > p.o);
      const max = DOORS[p.l] || 24;
      const groups = new Map();
      for (const f of p.f) {
        const doors = [...new Set(f.doors)].filter((n) => Number.isInteger(n) && n >= 1 && n <= max);
        if (!doors.length) continue;
        const leads = leadsOf(f, byDir, p.n);
        const key = `${f.t}|${leads.join("/")}`;
        const g = groups.get(key) || { t: f.t, leads, doors: [] };
        g.doors = [...new Set([...g.doors, ...doors])].sort((a, b) => a - b);
        groups.set(key, g);
      }
      return {
        code: p.c,
        line: p.l,
        lineName: lineName(p.l),
        towards: end.n,
        next: next?.n || null,
        last: !next,
        rows: [...groups.values()].sort((a, b) => rank(a.t) - rank(b.t) || a.leads.join().localeCompare(b.leads.join())),
        numberAt: numberAt(p),
        cross: p.x.map((d) => byDir.get(d)).filter(Boolean).map((l) => `${lineName(l[0].l)} towards ${towardsFrom(l, p.n)}`),
      };
    });
}

// Where to look for the door's number on the platform: a little drawing of that kind of platform
// door, the spot ringed. Full-height doors have a panel over them, in the line's colour; half-height
// ones stand between posts.
function doorNumberAt(at) {
  const full = '<rect x="3" y="2" width="34" height="27" rx="1.5" class="dnFrame"/>' +
    '<rect x="3" y="2" width="34" height="6" class="dnBand"/>' +
    '<rect x="7" y="10" width="12.5" height="19" class="dnGlass"/><rect x="20.5" y="10" width="12.5" height="19" class="dnGlass"/>';
  const half = '<rect x="2" y="5" width="6" height="24" rx="1" class="dnFrame"/><rect x="32" y="5" width="6" height="24" rx="1" class="dnFrame"/>' +
    '<rect x="2" y="5" width="6" height="3" class="dnBand"/><rect x="32" y="5" width="6" height="3" class="dnBand"/>' +
    '<rect x="9" y="14" width="10.5" height="15" class="dnGlass"/><rect x="20.5" y="14" width="10.5" height="15" class="dnGlass"/>';
  const spot = { above: [20, 5], corner: [31, 11.5], post: [35, 11] }[at];
  return `<svg class="dnSvg" viewBox="0 0 40 32" aria-hidden="true">${at === "post" ? half : full}` +
    `<circle cx="${spot[0]}" cy="${spot[1]}" r="4.2" class="dnRing"/><circle cx="${spot[0]}" cy="${spot[1]}" r="1.6" class="dnDot"/></svg>`;
}

const NUMBER_AT_WORDS = {
  above: "<b>Door number:</b> on the panel above the doors",
  corner: "<b>Door number:</b> at the top right of each door",
  post: "<b>Door number:</b> near the top of the post beside each door",
};
const numberAtHtml = (at) => NUMBER_AT_WORDS[at] || "Look for the number on each platform door";

// A way off the platform, as leadsOf names it.
function leadText(x) {
  if (x === "Exit") return "the exit";
  const toward = /^(.*\b(?:Line|LRT)) towards (.+)$/.exec(x);
  if (toward) return `the ${toward[1]} towards ${toward[2]}`;
  return /\b(Line|LRT)$/.test(x) ? `the ${x}` : x;
}

function slideHtml(p) {
  const colour = colourOf(p.code);
  const rows = p.rows.map((r) => `<li class="doorRow">${ico(DOOR_TYPE[r.t] ? r.t : "train")}` +
    `<span class="doorChips">${r.doors.map((n) => `<span class="doorChip"><span class="doorTop">Door</span><b>${n}</b></span>`).join("")}</span>` +
    `<span class="doorWhere">${esc(`${DOOR_TYPE[r.t] || r.t} to ${listText(r.leads.map(leadText))}`)}</span></li>`).join("");
  return `<div class="mcDir" style="--line:${colour}">` +
    `<span class="lineCode" style="--line:${colour}">${esc(p.code)}</span>` +
    `<span class="mcDirText"><b>${esc(p.last ? "Trains end here" : `Towards ${p.towards}`)}</b>${p.next ? `<span>${esc(`Next: ${p.next}`)}</span>` : ""}</span></div>` +
    (rows
      ? `<div class="legDoors" style="--line:${colour}"><ul class="doorRows">${rows}</ul>` +
        `<div class="doorFoot">${p.numberAt ? doorNumberAt(p.numberAt) : ""}<span>${numberAtHtml(p.numberAt)}</span></div></div>`
      : `<p class="mcNote">No door details for this platform yet.</p>`) +
    (p.cross.length ? `<p class="mcNote">${ico("across")} ${esc(`Across the platform: ${listText(p.cross)}`)}</p>` : "");
}

// The card's doors, every platform's page there and all but the first hidden. Paged by wireDoors.
export function doorsHtml(codes, platforms) {
  const slides = stationPlatforms(codes, platforms);
  if (!slides.length) return `<p class="mcNote">No door details for this station yet.</p>`;
  const arrow = (step, name, label) => `<button class="mcArrow" type="button" data-mc-step="${step}" aria-label="${label}"${slides.length < 2 ? " hidden" : ""}>${ico(name)}</button>`;
  return `<div class="mcCarousel">${arrow(-1, "back", "Previous direction")}` +
    `<div class="mcSlides" aria-live="polite">${slides.map((p, i) => `<div class="mcSlide"${i ? " hidden" : ""}>${slideHtml(p)}</div>`).join("")}</div>` +
    `${arrow(1, "forward", "Next direction")}</div><p class="mcCount">1 of ${slides.length}</p>`;
}

function turnPage(root, step) {
  const slides = [...root.querySelectorAll(".mcSlide")];
  const from = slides.findIndex((s) => !s.hidden);
  if (from < 0 || slides.length < 2) return;
  const i = (from + step + slides.length) % slides.length;
  slides[from].hidden = true;
  slides[from].classList.remove("fromLeft", "fromRight");
  slides[i].hidden = false;
  slides[i].classList.remove("fromLeft", "fromRight");
  void slides[i].offsetWidth; // So the slide-in plays again on a page seen before.
  slides[i].classList.add(step > 0 ? "fromRight" : "fromLeft");
  root.querySelector(".mcCount").textContent = `${i + 1} of ${slides.length}`;
}

// The arrows and a swipe across the page, on the card's detail that doorsHtml is put in.
export function wireDoors() {
  const root = $("#placeDetail");
  let x0 = null;
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mc-step]");
    if (b) turnPage(root, Number(b.dataset.mcStep));
  });
  root.addEventListener("pointerdown", (e) => {
    x0 = e.target.closest(".mcSlide") ? e.clientX : null;
  });
  root.addEventListener("pointerup", (e) => {
    if (x0 != null && e.target.closest(".mcSlide") && Math.abs(e.clientX - x0) > 40) turnPage(root, e.clientX < x0 ? 1 : -1);
    x0 = null;
  });
}

// The coloured 3D buildings, from Overture Maps: its buildings and their separately mapped parts,
// each drawn as walls with a thin cap of its own colour on top, which is what lets a roof differ from
// the walls under it. tools/packs/extract-buildings.mjs keeps only the fields read here: keep in step.
//
// Where Overture states a colour it's used as it is. Most buildings don't have one, so those take a
// tint from what kind of building they are.

const SOURCE = "buildings";
const FLOOR_METRES = 3.2;
const DEFAULT_HEIGHT = 6;
const ROOF_CAP_METRES = 0.5;
const MIN_ZOOM = 14;

const TINTS = {
  light: {
    residential: "#f3e3cf", commercial: "#c9dcf2", industrial: "#d5d0e0", education: "#f6e6a8",
    medical: "#f6cfd4", civic: "#d3e8d0", religious: "#ecd5ee", transportation: "#cfe6e8",
    agricultural: "#e4e6bf", military: "#cfd4c2", entertainment: "#f6d3bb", service: "#dddad2", outbuilding: "#e6e1d6",
    other: "#e8e4dc",
  },
  dark: {
    residential: "#5c5246", commercial: "#46566b", industrial: "#4e4a5a", education: "#6b6238",
    medical: "#6a4a50", civic: "#46604a", religious: "#5e4a60", transportation: "#3f5a5e",
    agricultural: "#585a38", military: "#4a4f3f", entertainment: "#6b5140", service: "#504e48", outbuilding: "#55524a",
    other: "#55524c",
  },
};

function tintExpression(mode, darken) {
  const t = TINTS[mode];
  const cases = ["match", ["coalesce", ["get", "subtype"], "other"]];
  for (const [kind, colour] of Object.entries(t)) {
    if (kind !== "other") cases.push(kind, darken ? shade(colour) : colour);
  }
  cases.push(darken ? shade(t.other) : t.other);
  return cases;
}

// A roof with no colour of its own: the walls' tint, a step darker, so the shape still reads from above.
function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * 0.88).toString(16).padStart(2, "0");
  return `#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

// By "has", not "coalesce": to-number makes a missing value 0, which coalesce would stop at, laying
// flat everything without a stated height.
const metres = (key, floorsKey, otherwise) => ["case",
  ["has", key], ["to-number", ["get", key]],
  ["has", floorsKey], ["*", ["to-number", ["get", floorsKey]], FLOOR_METRES],
  otherwise];
const heightOf = metres("height", "num_floors", DEFAULT_HEIGHT);
const baseOf = metres("min_height", "min_floor", 0);

// A building split into parts is drawn by its parts alone. Overture's own tiles also carry underground
// buildings, which the pack's copies have already dropped.
const visible = ["all", ["!=", ["get", "has_parts"], true], ["!=", ["get", "is_underground"], true]];
const partVisible = ["!=", ["get", "is_underground"], true];

// The walls take the stated facade colour, then the roof's, then the tint: a building with only a
// roof colour still reads as that colour from the side.
const wallColour = (mode) => ["to-color", ["coalesce", ["get", "facade_color"], ["get", "roof_color"], tintExpression(mode, false)]];
const roofColour = (mode) => ["to-color", ["coalesce", ["get", "roof_color"], ["get", "facade_color"], tintExpression(mode, true)]];

const LAYER_IDS = ["buildings-walls", "buildings-roofs", "parts-walls", "parts-roofs"];

// Above everything flat, or the roads and building fills paint over the 3D, and below what's left of
// the labels. Not simply the first label: the dark style has one early on, under its roads.
function layerAboveTheFlatOnes(map) {
  const { layers } = map.getStyle();
  let lastFlat = -1;
  layers.forEach((l, i) => {
    if (l.type !== "symbol") lastFlat = i;
  });
  return layers[lastFlat + 1]?.id;
}

export function addBuildings(map, mode, visibleNow) {
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, {
      type: "vector",
      tiles: ["uwu://buildings/{z}/{x}/{y}"],
      minzoom: MIN_ZOOM,
      maxzoom: MIN_ZOOM,
      attribution: '&copy; <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a>',
    });
  }
  const before = layerAboveTheFlatOnes(map);
  const layer = (id, sourceLayer, filter, colour, base, height, gradient) => {
    if (map.getLayer(id)) return;
    map.addLayer({
      id,
      type: "fill-extrusion",
      source: SOURCE,
      "source-layer": sourceLayer,
      minzoom: MIN_ZOOM,
      filter,
      layout: { visibility: visibleNow ? "visible" : "none" },
      paint: {
        "fill-extrusion-color": colour,
        "fill-extrusion-base": base,
        "fill-extrusion-height": height,
        "fill-extrusion-vertical-gradient": gradient,
        // Solid, so all four layers share one depth buffer and draw each other in the right order.
        "fill-extrusion-opacity": 1,
      },
    }, before);
  };

  const capBase = ["max", ["-", heightOf, ROOF_CAP_METRES], baseOf];
  layer("buildings-walls", "building", visible, wallColour(mode), baseOf, heightOf, true);
  layer("buildings-roofs", "building", visible, roofColour(mode), capBase, heightOf, false);
  layer("parts-walls", "building_part", partVisible, wallColour(mode), baseOf, heightOf, true);
  layer("parts-roofs", "building_part", partVisible, roofColour(mode), capBase, heightOf, false);
}

export function setBuildingsVisible(map, on) {
  for (const id of LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }
}

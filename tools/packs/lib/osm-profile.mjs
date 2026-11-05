// How OpenStreetMap's tags become something a route can use: which ways each of walking, cycling
// and driving may take, in which direction, and how fast.
//
// The class numbers and bit positions are the routing file's format. They are read back by
// main-site/js/route-core.js: keep the two in step.

export const CLASS = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6,
  service: 7, track: 8, path: 9, footway: 10, cycleway: 11, steps: 12, ferry: 13,
};

// The classes in the long distance layer (see compile-route.mjs), plus any cycleway.
export const isMajor = (cls) => cls <= CLASS.tertiary || cls === CLASS.cycleway;

const HIGHWAY = {
  motorway: [CLASS.motorway, false], motorway_link: [CLASS.motorway, true],
  trunk: [CLASS.trunk, false], trunk_link: [CLASS.trunk, true],
  primary: [CLASS.primary, false], primary_link: [CLASS.primary, true],
  secondary: [CLASS.secondary, false], secondary_link: [CLASS.secondary, true],
  tertiary: [CLASS.tertiary, false], tertiary_link: [CLASS.tertiary, true],
  unclassified: [CLASS.unclassified, false], road: [CLASS.unclassified, false],
  residential: [CLASS.residential, false], living_street: [CLASS.residential, false],
  service: [CLASS.service, false], track: [CLASS.track, false],
  path: [CLASS.path, false], bridleway: [CLASS.path, false],
  footway: [CLASS.footway, false], pedestrian: [CLASS.footway, false], corridor: [CLASS.footway, false],
  cycleway: [CLASS.cycleway, false], steps: [CLASS.steps, false],
};

// km/h, used where a road states no limit of its own.
const CAR_KMH = [100, 80, 60, 50, 40, 30, 25, 15, 12, 0, 0, 0, 0, 20];

const NO = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery', 'customers', 'permit', 'military', 'emergency']);
const YES = new Set(['yes', 'designated', 'permissive', 'destination', 'official', 'public']);

// The most specific tag that says anything wins; otherwise the default for the class.
function allowed(tags, keys, byDefault) {
  for (const key of keys) {
    const v = tags[key];
    if (v == null) continue;
    if (NO.has(v) || v === 'use_sidepath') return false;
    if (YES.has(v)) return true;
  }
  return byDefault;
}

// "50", "30 mph", or null for "signals", "walk" and the rest.
export function parseSpeed(v) {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return Math.round(m[2]?.toLowerCase() === 'mph' ? n * 1.609 : n);
}

// A way's routing facts, or null when nothing can use it.
//   cls       one of CLASS
//   link      a slip road
//   roundabout
//   kmh       driving speed
//   fwd, back bit 0 driving, bit 1 cycling, bit 2 walking, in each direction along the way
export function classify(tags) {
  let cls;
  let link = false;
  if (tags.route === 'ferry') cls = CLASS.ferry;
  else {
    const h = HIGHWAY[tags.highway];
    if (!h) return null;
    [cls, link] = h;
  }
  if (tags.area === 'yes' && cls !== CLASS.footway) return null;
  if (tags.access === 'no' && tags.highway === 'construction') return null;

  const car = allowed(tags, ['motorcar', 'motor_vehicle', 'vehicle', 'access'], cls <= CLASS.track || cls === CLASS.ferry);
  const bike = allowed(
    tags,
    ['bicycle', 'vehicle', 'access'],
    cls !== CLASS.motorway && cls !== CLASS.steps,
  );
  // Busy trunk roads usually have a separate pavement, mapped as its own footway.
  const foot = allowed(tags, ['foot', 'access'], cls !== CLASS.motorway && !(cls === CLASS.trunk && tags.sidewalk === 'no'));
  if (!car && !bike && !foot) return null;

  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  let carFwd = true;
  let carBack = true;
  const oneway = tags.oneway;
  if (oneway === 'yes' || oneway === '1' || oneway === 'true' || roundabout || (cls === CLASS.motorway && oneway !== 'no' && oneway !== '-1')) carBack = false;
  else if (oneway === '-1' || oneway === 'reverse') carFwd = false;

  // Cycling follows the road's one-way, unless it says bikes may go both ways.
  let bikeFwd = carFwd;
  let bikeBack = carBack;
  const bikeOneway = tags['oneway:bicycle'];
  const contraflow = String(tags.cycleway || tags['cycleway:left'] || tags['cycleway:right'] || '').startsWith('opposite');
  if (bikeOneway === 'no' || contraflow) {
    bikeFwd = true;
    bikeBack = true;
  } else if (bikeOneway === 'yes') {
    bikeBack = false;
  }
  if (cls === CLASS.cycleway && oneway == null) {
    bikeFwd = true;
    bikeBack = true;
  }

  const fwd = (car && carFwd ? 1 : 0) | (bike && bikeFwd ? 2 : 0) | (foot ? 4 : 0);
  const back = (car && carBack ? 1 : 0) | (bike && bikeBack ? 2 : 0) | (foot ? 4 : 0);
  if (!fwd && !back) return null;

  const limit = parseSpeed(tags.maxspeed);
  // Traffic means few roads are driven at their limit, so a little under it.
  const kmh = Math.max(5, Math.min(130, limit ? Math.round(limit * 0.85) : CAR_KMH[cls] || 15));

  return { cls, link, roundabout, kmh, fwd, back };
}

// What a road is called in directions. English first, since the app's words are in English.
export const roadName = (tags) => tags['name:en'] || tags.name || tags.ref || '';

// What a place can be found by, offline. Lower numbers rank first in search.
export function placeKind(tags) {
  if (tags.place) {
    if (['country', 'state', 'region', 'province', 'city', 'town'].includes(tags.place)) return 0;
    if (['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet', 'island', 'islet', 'locality'].includes(tags.place)) return 1;
    return null;
  }
  if (tags.aeroway === 'aerodrome' || tags.railway === 'station' || tags.public_transport === 'station') return 1;
  if (tags.tourism || tags.amenity || tags.shop || tags.leisure || tags.historic || tags.office || tags.natural === 'peak') return 2;
  if (tags.railway === 'halt' || tags.railway === 'tram_stop' || tags.highway === 'bus_stop' || tags.public_transport === 'stop_position') return 3;
  if (tags.building) return 4;
  return null;
}

// The street kind, ranked after places, for streets found by name.
export const STREET_KIND = 3;

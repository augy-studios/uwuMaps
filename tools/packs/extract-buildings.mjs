#!/usr/bin/env node
// Cuts a region's 3D buildings out of Overture Maps' buildings archive into a pack's own:
//
//   node tools/packs/extract-buildings.mjs --bounds=w,s,e,n --out=out.pmtiles [--release=2026-10-21.0]
//
// Overture's tiles carry a good deal the map never draws (sources, names, versions), which makes
// up most of their size. Each tile is rewritten keeping only what the buildings layers read
// (main-site/js/buildings.js), its shapes untouched, so the pack stays a sensible download.
// Only zoom 14 is kept, since the 3D layers don't draw below it.
//
// Reads over plain HTTP range requests. Overture's bucket allows them.

import { gunzipSync, gzipSync } from 'node:zlib';
import { PMTiles, SharedPromiseCache } from 'pmtiles';
import { PMTilesWriter } from './lib/pmtiles-writer.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
if (!args.bounds || !args.out) {
  console.error('Usage: extract-buildings.mjs --bounds=w,s,e,n --out=out.pmtiles [--release=YYYY-MM-DD.N]');
  process.exit(2);
}
const bounds = args.bounds.split(',').map(Number);
const ZOOM = 14;
const PARALLEL = 32;

// What main-site/js/buildings.js reads. In step with it.
const KEEP = new Set([
  'height', 'min_height', 'num_floors', 'min_floor', 'facade_color', 'roof_color', 'subtype', 'class', 'has_parts',
]);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function latestRelease() {
  for (let tries = 0; ; tries++) {
    const res = await fetch('https://stac.overturemaps.org/catalog.json');
    if (res.ok) {
      const { latest } = await res.json();
      if (!latest) throw new Error("Overture's catalogue names no latest release");
      return latest;
    }
    // It rate limits, and several region builds start at once.
    if (tries >= 5) throw new Error(`Overture's catalogue answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 15000 * (tries + 1)));
  }
}

/* ---- rewriting a vector tile ---- */

function readVarint(buf, st) {
  let v = 0;
  let mul = 1;
  for (;;) {
    const b = buf[st.pos++];
    v += (b & 0x7f) * mul;
    if (b < 0x80) return v;
    mul *= 128;
  }
}

function pushVarint(out, v) {
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function field(num, wire) {
  const out = [];
  pushVarint(out, num * 8 + wire);
  return Buffer.from(out);
}

function lenPrefixed(num, payload) {
  const len = [];
  pushVarint(len, payload.length);
  return Buffer.concat([field(num, 2), Buffer.from(len), payload]);
}

function skipField(buf, st, wire) {
  if (wire === 0) readVarint(buf, st);
  else if (wire === 1) st.pos += 8;
  else if (wire === 2) {
    // Read first: `st.pos += readVarint(buf, st)` would use pos from before the length was read.
    const n = readVarint(buf, st);
    st.pos += n;
  }
  else if (wire === 5) st.pos += 4;
  else throw new Error(`Unknown wire type ${wire}`);
}

// A boolean true in a tile's value table: field 7, value 1.
const isTrueValue = (v) => v.length === 2 && v[0] === 0x38 && v[1] === 1;

function rewriteLayer(buf) {
  const st = { pos: 0 };
  let name = '';
  let extent = 4096;
  const keys = [];
  const values = [];
  const rawFeatures = [];
  while (st.pos < buf.length) {
    const tag = readVarint(buf, st);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    if (num === 1) {
      const n = readVarint(buf, st);
      name = buf.toString('utf8', st.pos, st.pos + n);
      st.pos += n;
    } else if (num === 2) {
      const n = readVarint(buf, st);
      rawFeatures.push(buf.subarray(st.pos, st.pos + n));
      st.pos += n;
    } else if (num === 3) {
      const n = readVarint(buf, st);
      keys.push(buf.toString('utf8', st.pos, st.pos + n));
      st.pos += n;
    } else if (num === 4) {
      const n = readVarint(buf, st);
      values.push(buf.subarray(st.pos, st.pos + n));
      st.pos += n;
    } else if (num === 5) extent = readVarint(buf, st);
    else skipField(buf, st, wire);
  }

  const undergroundKey = keys.indexOf('is_underground');
  const newKeys = new Map();
  const newValues = new Map();
  const features = [];
  for (const raw of rawFeatures) {
    const f = { pos: 0 };
    let type = 0;
    let geometry = null;
    let tags = [];
    while (f.pos < raw.length) {
      const tag = readVarint(raw, f);
      const num = Math.floor(tag / 8);
      const wire = tag & 7;
      if (num === 2) {
        const n = readVarint(raw, f);
        const end = f.pos + n;
        tags = [];
        while (f.pos < end) tags.push(readVarint(raw, f));
      } else if (num === 3) type = readVarint(raw, f);
      else if (num === 4) {
        const n = readVarint(raw, f);
        geometry = raw.subarray(f.pos, f.pos + n);
        f.pos += n;
      } else skipField(raw, f, wire);
    }
    if (!geometry) continue;

    let underground = false;
    const kept = [];
    for (let i = 0; i < tags.length; i += 2) {
      if (tags[i] === undergroundKey && isTrueValue(values[tags[i + 1]])) underground = true;
      const key = keys[tags[i]];
      if (!KEEP.has(key)) continue;
      const raw8 = values[tags[i + 1]];
      // A false has_parts says nothing the layers need, and is on nearly every building.
      if (key === 'has_parts' && !isTrueValue(raw8)) continue;
      if (!newKeys.has(key)) newKeys.set(key, newKeys.size);
      const valueKey = raw8.toString('latin1');
      if (!newValues.has(valueKey)) newValues.set(valueKey, newValues.size);
      kept.push(newKeys.get(key), newValues.get(valueKey));
    }
    if (underground) continue;

    const tagBytes = [];
    for (const t of kept) pushVarint(tagBytes, t);
    const typeBytes = [];
    pushVarint(typeBytes, type);
    features.push(lenPrefixed(2, Buffer.concat([
      lenPrefixed(2, Buffer.from(tagBytes)),
      field(3, 0), Buffer.from(typeBytes),
      lenPrefixed(4, geometry),
    ])));
  }
  if (!features.length) return null;

  const extentBytes = [];
  pushVarint(extentBytes, extent);
  return Buffer.concat([
    field(15, 0), Buffer.from([2]),
    lenPrefixed(1, Buffer.from(name, 'utf8')),
    ...features,
    ...[...newKeys.keys()].map((k) => lenPrefixed(3, Buffer.from(k, 'utf8'))),
    ...[...newValues.keys()].map((v) => lenPrefixed(4, Buffer.from(v, 'latin1'))),
    field(5, 0), Buffer.from(extentBytes),
  ]);
}

export function rewriteTile(tile) {
  const st = { pos: 0 };
  const layers = [];
  while (st.pos < tile.length) {
    const tag = readVarint(tile, st);
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    if (num === 3) {
      const n = readVarint(tile, st);
      const layer = rewriteLayer(tile.subarray(st.pos, st.pos + n));
      st.pos += n;
      if (layer) layers.push(lenPrefixed(3, layer));
    } else skipField(tile, st, wire);
  }
  return Buffer.concat(layers);
}

/* ---- the region ---- */

const tileX = (lon) => Math.floor(((lon + 180) / 360) * 2 ** ZOOM);
const tileY = (lat) => {
  const r = lat * (Math.PI / 180);
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** ZOOM);
};

const release = args.release || await latestRelease();
const url = `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`;
log(`Overture release ${release}`);

const archive = new PMTiles(url, new SharedPromiseCache(2000));
const header = await archive.getHeader();
if (header.maxZoom < ZOOM) throw new Error(`Overture's archive stops at zoom ${header.maxZoom}`);

const writer = new PMTilesWriter(args.out);
const x0 = tileX(bounds[0]);
const x1 = tileX(bounds[2]);
const y0 = tileY(bounds[3]);
const y1 = tileY(bounds[1]);
const total = (x1 - x0 + 1) * (y1 - y0 + 1);
log(`${total} tile positions to look at`);

let x = x0;
let y = y0;
let seen = 0;
let kept = 0;
let inBytes = 0;
let outBytes = 0;

function nextPosition() {
  if (x > x1) return null;
  const at = [x, y];
  y++;
  if (y > y1) {
    y = y0;
    x++;
  }
  return at;
}

async function fetchRetrying(tx, ty) {
  for (let tries = 0; ; tries++) {
    try {
      return await archive.getZxy(ZOOM, tx, ty);
    } catch (err) {
      if (tries >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** tries));
    }
  }
}

await Promise.all(Array.from({ length: PARALLEL }, async () => {
  for (let at = nextPosition(); at; at = nextPosition()) {
    const got = await fetchRetrying(at[0], at[1]);
    seen++;
    if (seen % 5000 === 0) log(`${seen} of ${total}, ${kept} tiles, ${(outBytes / 1e6).toFixed(0)} MB`);
    if (!got) continue;
    let raw = Buffer.from(got.data);
    // The library hands tiles over unzipped; this is here for an archive that changes that.
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
    inBytes += raw.length;
    const slim = rewriteTile(raw);
    if (!slim.length) continue;
    const gz = gzipSync(slim, { level: 9 });
    outBytes += gz.length;
    kept++;
    await writer.add(ZOOM, at[0], at[1], gz);
  }
}));

const result = await writer.finish({
  bounds,
  metadata: {
    name: 'uwuMaps buildings',
    attribution: '© Overture Maps Foundation, © OpenStreetMap contributors',
    overture_release: release,
    vector_layers: [
      { id: 'building', fields: {}, minzoom: ZOOM, maxzoom: ZOOM },
      { id: 'building_part', fields: {}, minzoom: ZOOM, maxzoom: ZOOM },
    ],
  },
});
log(`${result.tiles} tiles, ${(inBytes / 1e6).toFixed(1)} MB as Overture had them, ${(result.size / 1e6).toFixed(1)} MB written to ${args.out}`);

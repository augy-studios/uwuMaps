#!/usr/bin/env node
// Compiles an .osm.pbf extract into a pack's routing file and search file:
//
//   node tools/packs/compile-graph.mjs <extract.osm.pbf> --bounds=w,s,e,n --route=out.route --search=out.search
//
// The routing file is what main-site/js/route-core.js reads, so keep its format in step. It is a
// road graph cut into square chunks, each gzipped and fetched by byte range, so a phone only ever
// holds the chunks a route passes through:
//
//   8 bytes  "UWUROUTE"
//   4 bytes  header length, little endian
//   n bytes  gzipped JSON header: bounds, zooms and the two chunk directories
//   the rest the chunks
//
// Two layers of chunks share one numbering of the road junctions:
//
//   local  every road, in small chunks (LOCAL_ZOOM). Used near both ends of a route.
//   major  main roads only, in bigger chunks (MAJOR_ZOOM). Used for the middle of a long route,
//          which is what keeps a cross-country drive from reading every lane in the country.
//
// Two passes over the extract, because ways name their nodes before anything knows where those
// nodes are: first the ways, then only the nodes those ways use. Everything lives in typed arrays,
// since a country has tens of millions of nodes and that many JavaScript objects would not fit.

import { openSync, writeSync, closeSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readPbf } from './lib/osm-pbf.mjs';
import { classify, isMajor, placeKind, roadName, STREET_KIND } from './lib/osm-profile.mjs';

const LOCAL_ZOOM = 12;
const MAJOR_ZOOM = 8;
const MAGIC = 'UWUROUTE';
const SEARCH_MAGIC = 'UWUSRCH1';
// How far a road's shape may drift when dropping points from it, in metres.
const SIMPLIFY_M = 2.5;
const NO_VERTEX = 0xffffffff;

const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const input = process.argv[2];
if (!input || !args.route || !args.search) {
  console.error('Usage: compile-graph.mjs <extract.osm.pbf> --bounds=w,s,e,n --route=out --search=out');
  process.exit(2);
}
const bounds = args.bounds ? args.bounds.split(',').map(Number) : [-180, -90, 180, 90];
const inBounds = (lat, lon) => lon >= bounds[0] && lon <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---- growing typed arrays ---- */

class Grow {
  constructor(Type, size = 1 << 16) {
    this.Type = Type;
    this.a = new Type(size);
    this.n = 0;
  }

  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }

  done() {
    return this.a.subarray(0, this.n);
  }
}

/* ---- pass 1: the ways, the restrictions, and the places that are ways ---- */

const wayIds = new Grow(Float64Array);
const wayStart = new Grow(Float64Array);
const wayRefs = new Grow(Float64Array, 1 << 20);
const wayCls = new Grow(Uint8Array);
const wayBits = new Grow(Uint8Array); // bit 0 link, bit 1 roundabout
const wayKmh = new Grow(Uint8Array);
const wayFwd = new Grow(Uint8Array);
const wayBack = new Grow(Uint8Array);
const wayName = new Grow(Uint32Array);
const nameIds = new Map([['', 0]]);
const names = [''];

function nameId(name) {
  let id = nameIds.get(name);
  if (id == null) {
    id = names.length;
    names.push(name);
    nameIds.set(name, id);
  }
  return id;
}

const restrictions = []; // { from, via, to, only }, way and node ids
// Places that are areas or lines: found at the location of their first node.
const wayPlaces = []; // { ref, name, alias, kind }
const extraRefs = new Grow(Float64Array);

function aliasOf(tags) {
  const out = new Set();
  for (const key of ['name', 'name:en', 'alt_name', 'short_name', 'official_name', 'ref', 'addr:postcode']) {
    if (tags[key]) out.add(tags[key]);
  }
  out.delete(tags['name:en'] || tags.name);
  return [...out].join(';').slice(0, 120);
}

log('Reading ways');
readPbf(input, {
  way(id, tags, refs) {
    const placeName = tags['name:en'] || tags.name;
    if (placeName && refs.length) {
      const kind = placeKind(tags);
      if (kind != null) {
        wayPlaces.push({ ref: refs[0], name: placeName.slice(0, 80), alias: aliasOf(tags), kind });
        extraRefs.push(refs[0]);
      }
    }
    if (refs.length < 2) return;
    const c = classify(tags);
    if (!c) return;
    wayIds.push(id);
    wayStart.push(wayRefs.n);
    for (let i = 0; i < refs.length; i++) wayRefs.push(refs[i]);
    wayCls.push(c.cls);
    wayBits.push((c.link ? 1 : 0) | (c.roundabout ? 2 : 0));
    wayKmh.push(c.kmh);
    wayFwd.push(c.fwd);
    wayBack.push(c.back);
    wayName.push(nameId(roadName(tags).slice(0, 80)));
  },
  relation(id, tags, members) {
    if (tags.type !== 'restriction' || !tags.restriction) return;
    // Restrictions that bend for some vehicles are skipped rather than applied to all of them.
    if (tags.except) return;
    const kind = tags.restriction;
    if (!kind.startsWith('no_') && !kind.startsWith('only_')) return;
    const from = members.find((m) => m.role === 'from' && m.type === 'way');
    const to = members.find((m) => m.role === 'to' && m.type === 'way');
    const via = members.find((m) => m.role === 'via' && m.type === 'node');
    if (from && to && via) restrictions.push({ from: from.id, via: via.id, to: to.id, only: kind.startsWith('only_') });
  },
}, undefined);

const wayCount = wayIds.n;
wayStart.push(wayRefs.n);
log(`${wayCount} routable ways, ${wayRefs.n} node references, ${restrictions.length} turn restrictions`);

/* ---- which nodes are needed ---- */

function sortedUnique(...arrays) {
  const size = arrays.reduce((n, a) => n + a.length, 0);
  const all = new Float64Array(size);
  let o = 0;
  for (const a of arrays) {
    all.set(a, o);
    o += a.length;
  }
  all.sort();
  let w = 0;
  for (let i = 0; i < all.length; i++) {
    if (i === 0 || all[i] !== all[i - 1]) all[w++] = all[i];
  }
  return all.subarray(0, w);
}

const needed = sortedUnique(wayRefs.done(), extraRefs.done());
log(`${needed.length} nodes needed`);

function indexOf(sorted, id) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* ---- pass 2: where those nodes are, and the places that are nodes ---- */

const lat6 = new Int32Array(needed.length);
const lon6 = new Int32Array(needed.length);
const have = new Uint8Array(needed.length);
const places = []; // { lat, lon, name, alias, kind }

log('Reading nodes');
let cursor = 0;
readPbf(input, {
  node(id, lat, lon, tags) {
    // Both lists ascend, so this is a walk rather than a search.
    while (cursor < needed.length && needed[cursor] < id) cursor++;
    if (cursor < needed.length && needed[cursor] === id) {
      lat6[cursor] = Math.round(lat * 1e6);
      lon6[cursor] = Math.round(lon * 1e6);
      have[cursor] = 1;
    }
    if (tags && inBounds(lat, lon)) {
      const name = tags['name:en'] || tags.name;
      if (name) {
        const kind = placeKind(tags);
        if (kind != null) places.push({ lat, lon, name: name.slice(0, 80), alias: aliasOf(tags), kind });
      }
    }
  },
}, undefined);

for (const p of wayPlaces) {
  const i = indexOf(needed, p.ref);
  if (i >= 0 && have[i] && inBounds(lat6[i] / 1e6, lon6[i] / 1e6)) {
    places.push({ lat: lat6[i] / 1e6, lon: lon6[i] / 1e6, name: p.name, alias: p.alias, kind: p.kind });
  }
}
wayPlaces.length = 0;
log(`${places.length} named places`);

/* ---- the junctions: a node where ways meet, or a way ends ---- */

const uses = new Uint8Array(needed.length);
const refIdx = new Uint32Array(wayRefs.n);
{
  const refs = wayRefs.done();
  for (let i = 0; i < refs.length; i++) refIdx[i] = indexOf(needed, refs[i]);
}
for (let w = 0; w < wayCount; w++) {
  const s = wayStart.a[w];
  const e = wayStart.a[w + 1];
  for (let i = s; i < e; i++) {
    const n = refIdx[i];
    // A way's ends always count as junctions, however few ways touch them.
    const weight = i === s || i === e - 1 ? 2 : 1;
    if (uses[n] < 200) uses[n] += weight;
  }
}

const tileX = (lon, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon / 1e6 + 180) / 360) * 2 ** z)));
const tileY = (lat, z) => {
  const r = (lat / 1e6) * (Math.PI / 180);
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z)));
};

// Junctions in the same chunk get neighbouring numbers, which is what makes the chunks small.
const vertexOrder = [];
{
  const keys = new Float64Array(needed.length);
  let n = 0;
  for (let i = 0; i < needed.length; i++) {
    if (uses[i] < 2 || !have[i]) continue;
    const key = tileX(lon6[i], LOCAL_ZOOM) * 2 ** LOCAL_ZOOM + tileY(lat6[i], LOCAL_ZOOM);
    keys[n++] = key * 2 ** 28 + i;
  }
  const sorted = keys.subarray(0, n).sort();
  for (let i = 0; i < n; i++) vertexOrder.push(sorted[i] % 2 ** 28);
}
if (needed.length >= 2 ** 28) throw new Error('Too many nodes for one pack');

const vertexOf = new Uint32Array(needed.length).fill(NO_VERTEX);
vertexOrder.forEach((n, v) => { vertexOf[n] = v; });
const vertexCount = vertexOrder.length;
log(`${vertexCount} junctions`);

/* ---- the edges: the stretches of way between junctions ---- */

const RAD = Math.PI / 180;
function metres(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * 1e-6 * RAD;
  const dLon = (bLon - aLon) * 1e-6 * RAD * Math.cos(((aLat + bLat) / 2) * 1e-6 * RAD);
  return 6371000 * Math.sqrt(dLat * dLat + dLon * dLon);
}

// Douglas-Peucker over the node indexes in pts: which interior points to keep.
function simplify(pts) {
  if (pts.length <= 2) return [];
  const keep = new Uint8Array(pts.length);
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = lon6[pts[a]];
    const ay = lat6[pts[a]];
    const bx = lon6[pts[b]];
    const by = lat6[pts[b]];
    const cos = Math.cos(ay * 1e-6 * RAD);
    const dx = (bx - ax) * cos;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const px = (lon6[pts[i]] - ax) * cos;
      const py = lat6[pts[i]] - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    // 1e-6 of a degree is 0.111 m, so the distance here squared is in those units.
    if (worst >= 0 && Math.sqrt(worstD) * 0.111 > SIMPLIFY_M) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

const edgeFrom = new Grow(Uint32Array, 1 << 18);
const edgeTo = new Grow(Uint32Array, 1 << 18);
const edgeWay = new Grow(Uint32Array, 1 << 18);
const edgeLen = new Grow(Float32Array, 1 << 18);
const edgeShape = new Grow(Float64Array, 1 << 18); // where its interior points start
const shape = new Grow(Uint32Array, 1 << 20); // node indexes

{
  let pts = [];
  for (let w = 0; w < wayCount; w++) {
    const s = wayStart.a[w];
    const e = wayStart.a[w + 1];
    let startIdx = -1;
    pts = [];
    let len = 0;
    for (let i = s; i < e; i++) {
      const n = refIdx[i];
      if (!have[n]) {
        // A node the extract cut off: the way stops here and picks up after it.
        startIdx = -1;
        pts = [];
        len = 0;
        continue;
      }
      if (startIdx >= 0) {
        const prev = pts[pts.length - 1];
        len += metres(lat6[prev], lon6[prev], lat6[n], lon6[n]);
      }
      pts.push(n);
      if (vertexOf[n] === NO_VERTEX) continue;
      if (startIdx >= 0 && len > 0) {
        const aIn = inBounds(lat6[pts[0]] / 1e6, lon6[pts[0]] / 1e6);
        const bIn = inBounds(lat6[n] / 1e6, lon6[n] / 1e6);
        if (aIn || bIn) {
          edgeFrom.push(vertexOf[pts[0]]);
          edgeTo.push(vertexOf[n]);
          edgeWay.push(w);
          edgeLen.push(len);
          edgeShape.push(shape.n);
          for (const p of simplify(pts)) shape.push(p);
        }
      }
      startIdx = i;
      pts = [n];
      len = 0;
    }
  }
  edgeShape.push(shape.n);
}
const edgeCount = edgeFrom.n;
log(`${edgeCount} edges, ${shape.n} shape points`);

/* ---- each junction's edges, both directions ---- */

const adjStart = new Uint32Array(vertexCount + 1);
for (let i = 0; i < edgeCount; i++) {
  adjStart[edgeFrom.a[i] + 1]++;
  adjStart[edgeTo.a[i] + 1]++;
}
for (let v = 0; v < vertexCount; v++) adjStart[v + 1] += adjStart[v];
const adj = new Uint32Array(adjStart[vertexCount]); // edge * 2, + 1 when walked backwards
{
  const fill = adjStart.slice();
  for (let i = 0; i < edgeCount; i++) {
    adj[fill[edgeFrom.a[i]]++] = i * 2;
    adj[fill[edgeTo.a[i]]++] = i * 2 + 1;
  }
}

/* ---- turn restrictions, as junction numbers ---- */

function neighbourOnWay(wayId, viaVertex) {
  const w = indexOf(wayIds.done(), wayId);
  if (w < 0) return null;
  for (let k = adjStart[viaVertex]; k < adjStart[viaVertex + 1]; k++) {
    const e = adj[k] >>> 1;
    if (edgeWay.a[e] === w) return adj[k] & 1 ? edgeFrom.a[e] : edgeTo.a[e];
  }
  return null;
}

const restrictionsAt = new Map(); // vertex -> [fromVertex, toVertex, only]
let restrictionCount = 0;
for (const r of restrictions) {
  const i = indexOf(needed, r.via);
  if (i < 0 || vertexOf[i] === NO_VERTEX) continue;
  const via = vertexOf[i];
  const from = neighbourOnWay(r.from, via);
  const to = neighbourOnWay(r.to, via);
  if (from == null || to == null) continue;
  if (!restrictionsAt.has(via)) restrictionsAt.set(via, []);
  restrictionsAt.get(via).push([from, to, r.only ? 1 : 0]);
  restrictionCount++;
}
log(`${restrictionCount} restrictions kept`);

/* ---- writing a chunk ---- */

class Writer {
  constructor() {
    this.parts = [];
    this.buf = Buffer.allocUnsafe(1 << 16);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n > this.buf.length) {
      this.parts.push(this.buf.subarray(0, this.pos));
      this.buf = Buffer.allocUnsafe(Math.max(1 << 16, n));
      this.pos = 0;
    }
  }

  varint(v) {
    this.ensure(5);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }

  zigzag(v) {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  byte(v) {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  bytes(b) {
    this.ensure(b.length);
    b.copy(this.buf, this.pos);
    this.pos += b.length;
  }

  done() {
    this.parts.push(this.buf.subarray(0, this.pos));
    return Buffer.concat(this.parts);
  }
}

// One chunk of junctions and their edges, columnar since like beside like compresses well.
// `allow(way)` picks which edges belong to this layer.
function encodeChunk(vertices, allow) {
  const w = new Writer();
  const localNames = new Map();
  const nameList = [];
  const nameIdx = (name) => {
    if (!name) return 0;
    let i = localNames.get(name);
    if (i == null) {
      nameList.push(name);
      i = nameList.length;
      localNames.set(name, i);
    }
    return i;
  };

  const edgesOf = (v) => {
    const out = [];
    for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
      const e = adj[k] >>> 1;
      if (!allow(edgeWay.a[e])) continue;
      const back = adj[k] & 1;
      const way = edgeWay.a[e];
      const bits = back ? wayBack.a[way] : wayFwd.a[way];
      if (!bits) continue; // nothing can leave this way in this direction
      out.push({ e, back, way, bits });
    }
    return out;
  };

  const perVertex = vertices.map(edgesOf);
  const body = new Writer();

  for (const list of perVertex) body.varint(list.length);
  // Targets
  vertices.forEach((v, i) => {
    for (const { e, back } of perVertex[i]) body.zigzag((back ? edgeFrom.a[e] : edgeTo.a[e]) - v);
  });
  // Lengths, metres
  for (const list of perVertex) for (const { e } of list) body.varint(Math.max(1, Math.round(edgeLen.a[e])));
  // Class in the low bits, then link and roundabout
  for (const list of perVertex) for (const { way } of list) body.byte(wayCls.a[way] | (wayBits.a[way] << 4));
  // Who may go this way
  for (const list of perVertex) for (const { bits } of list) body.byte(bits);
  for (const list of perVertex) for (const { way } of list) body.byte(wayKmh.a[way]);
  for (const list of perVertex) for (const { way } of list) body.varint(nameIdx(names[wayName.a[way]]));
  // Shapes: interior points counted, then every point as a step from the one before, ending at the
  // target, so a target's location is known without reading the chunk it's in.
  vertices.forEach((v, i) => {
    const n0 = vertexOrder[v];
    for (const { e, back } of perVertex[i]) {
      const s = edgeShape.a[e];
      const t = edgeShape.a[e + 1];
      body.varint(t - s);
      let la = lat6[n0];
      let lo = lon6[n0];
      const emit = (n) => {
        body.zigzag(lat6[n] - la);
        body.zigzag(lon6[n] - lo);
        la = lat6[n];
        lo = lon6[n];
      };
      if (back) for (let k = t - 1; k >= s; k--) emit(shape.a[k]);
      else for (let k = s; k < t; k++) emit(shape.a[k]);
      emit(vertexOrder[back ? edgeFrom.a[e] : edgeTo.a[e]]);
    }
  });
  // Restrictions at these junctions
  const here = [];
  for (const v of vertices) if (restrictionsAt.has(v)) for (const r of restrictionsAt.get(v)) here.push([v, ...r]);
  body.varint(here.length);
  for (const [v, from, to, only] of here) {
    body.varint(v);
    body.varint(from);
    body.varint(to);
    body.byte(only);
  }

  // The head: names, junction numbers and locations.
  w.varint(nameList.length);
  for (const n of nameList) {
    const b = Buffer.from(n, 'utf8');
    w.varint(b.length);
    w.bytes(b);
  }
  w.varint(vertices.length);
  let prevV = 0;
  for (const v of vertices) {
    w.varint(v - prevV);
    prevV = v;
  }
  let la = 0;
  let lo = 0;
  for (const v of vertices) {
    const n = vertexOrder[v];
    w.zigzag(lat6[n] - la);
    w.zigzag(lon6[n] - lo);
    la = lat6[n];
    lo = lon6[n];
  }
  w.bytes(body.done());
  return gzipSync(w.done(), { level: 9 });
}

/* ---- the routing file ---- */

function buildRoute() {
  mkdirSync(dirname(args.route), { recursive: true });
  const groupVertices = (z, pick) => {
    const groups = new Map();
    for (let v = 0; v < vertexCount; v++) {
      if (!pick(v)) continue;
      const n = vertexOrder[v];
      const key = `${tileX(lon6[n], z)}/${tileY(lat6[n], z)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    return groups;
  };

  const chunks = [];
  const dirFor = (groups, allow) => {
    const dir = [];
    for (const [key, vertices] of groups) {
      const gz = encodeChunk(vertices, allow);
      const [x, y] = key.split('/').map(Number);
      dir.push(x, y, chunksBytes, gz.length);
      chunks.push(gz);
      chunksBytes += gz.length;
    }
    return dir;
  };
  let chunksBytes = 0;

  const anyEdge = () => true;
  const majorWay = (way) => isMajor(wayCls.a[way]);
  const hasMajorEdge = (v) => {
    for (let k = adjStart[v]; k < adjStart[v + 1]; k++) if (majorWay(edgeWay.a[adj[k] >>> 1])) return true;
    return false;
  };

  const local = dirFor(groupVertices(LOCAL_ZOOM, () => true), anyEdge);
  const localBytes = chunksBytes;
  const major = dirFor(groupVertices(MAJOR_ZOOM, hasMajorEdge), majorWay);
  log(`Routing chunks: ${local.length / 4} local (${(localBytes / 1e6).toFixed(1)} MB), ${major.length / 4} major (${((chunksBytes - localBytes) / 1e6).toFixed(1)} MB)`);

  const header = gzipSync(Buffer.from(JSON.stringify({
    v: 1, bounds, zLocal: LOCAL_ZOOM, zMajor: MAJOR_ZOOM, vertices: vertexCount, local, major,
  })), { level: 9 });
  const fd = openSync(args.route, 'w');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length, 0);
  writeSync(fd, Buffer.from(MAGIC));
  writeSync(fd, len);
  writeSync(fd, header);
  for (const c of chunks) writeSync(fd, c);
  closeSync(fd);
  log(`Wrote ${args.route}: ${(statSync(args.route).size / 1e6).toFixed(1)} MB`);
}

/* ---- the search file ---- */

// In step with normalise() in main-site/js/search.js.
const normalise = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

// The buckets a name is found under. A word goes under its first two letters. Chinese, Japanese and
// Korean names have no spaces, so they go under every character, to find a word inside one.
function bucketsOf(text) {
  const out = new Set();
  for (const word of normalise(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8)) {
    if (CJK.test(word)) for (const ch of [...word].slice(0, 12)) out.add(ch);
    else out.add([...word].slice(0, 2).join(''));
  }
  return out;
}

function buildSearch() {
  // Streets: one per name per small area, located at the middle of one of their stretches.
  const seen = new Set();
  for (let e = 0; e < edgeCount; e++) {
    const name = names[wayName.a[edgeWay.a[e]]];
    if (!name) continue;
    const n = vertexOrder[edgeFrom.a[e]];
    const key = `${name}|${Math.round(lat6[n] / 20000)}|${Math.round(lon6[n] / 20000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!inBounds(lat6[n] / 1e6, lon6[n] / 1e6)) continue;
    places.push({ lat: lat6[n] / 1e6, lon: lon6[n] / 1e6, name, alias: '', kind: STREET_KIND + 1 });
  }

  const buckets = new Map();
  for (const p of places) {
    const clean = p.name.replace(/[\t\n]/g, ' ');
    const alias = p.alias.replace(/[\t\n]/g, ' ');
    const line = `${clean}\t${p.lat.toFixed(5)}\t${p.lon.toFixed(5)}\t${p.kind}\t${alias}\n`;
    for (const b of bucketsOf(`${clean} ${alias}`)) {
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(line);
    }
  }

  const dir = {};
  const parts = [];
  let offset = 0;
  for (const [b, lines] of buckets) {
    const gz = gzipSync(Buffer.from(lines.join(''), 'utf8'), { level: 9 });
    dir[b] = [offset, gz.length];
    parts.push(gz);
    offset += gz.length;
  }
  const header = gzipSync(Buffer.from(JSON.stringify({ v: 1, bounds, count: places.length, dir })), { level: 9 });
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length, 0);
  mkdirSync(dirname(args.search), { recursive: true });
  writeFileSync(args.search, Buffer.concat([Buffer.from(SEARCH_MAGIC), len, header, ...parts]));
  log(`Wrote ${args.search}: ${places.length} places in ${buckets.size} buckets, ${(statSync(args.search).size / 1e6).toFixed(1)} MB`);
}

buildRoute();
buildSearch();
log('Done');

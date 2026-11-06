// The offline router: reads a pack's routing file and finds the way between two points. No DOM and
// no knowledge of where the file lives, so it runs in the worker (js/route-worker.js) and in tests.
//
// The file's format is written by tools/packs/compile-graph.mjs, with the class numbers and bits in
// tools/packs/lib/osm-profile.mjs. Keep them in step.
//
// It is A*, over junctions, reading chunks of the graph only as the search reaches them. Far from
// both ends of a route it looks at main roads only, from the coarser "major" chunks, which is what
// makes a long drive possible on a phone. If that finds nothing, it tries again on every road.

export const MODES = {
  // bit: who may use an edge. maxMps: the fastest anything goes, for the search's estimate.
  // near: how far from either end, in metres, every road is considered.
  car: { bit: 1, maxMps: 33, near: 15000 },
  bike: { bit: 2, maxMps: 6.5, near: 8000 },
  foot: { bit: 4, maxMps: 1.75, near: 5000 },
};

export const CLASS = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6,
  service: 7, track: 8, path: 9, footway: 10, cycleway: 11, steps: 12, ferry: 13,
};

// km/h by class. Driving reads the speed in the data instead.
const BIKE_KMH = [0, 18, 18, 18, 18, 17, 16, 14, 11, 12, 6, 18, 3, 12];
const FOOT_KMH = [0, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.5, 4.5, 4.8, 4.8, 2.5, 8];
// How much less pleasant than its time a road is: what route quality trades against time.
const BIKE_COST = [99, 2.2, 1.7, 1.4, 1.15, 1, 1, 1.05, 1.1, 1, 1.1, 0.8, 3, 1];
const FOOT_COST = [99, 1.8, 1.4, 1.2, 1.05, 1, 1, 1, 1, 0.95, 0.9, 1.05, 1.2, 1];
// Out of the sun and the rain is worth a small detour. On an edge, this bit says it's under cover.
const SHELTER_COST = 0.85;
const SHELTER_BIT = 8;

// Search harder than exact, for speed: the route found is within a few percent of the best.
const GREED = 1.2;
const CHUNK_CACHE = 160;
const RAD = Math.PI / 180;

export function metres(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD * Math.cos(((aLat + bLat) / 2) * RAD);
  return 6371000 * Math.sqrt(dLat * dLat + dLon * dLon);
}

function bearing(aLat, aLon, bLat, bLon) {
  const dLon = (bLon - aLon) * RAD;
  const y = Math.sin(dLon) * Math.cos(bLat * RAD);
  const x = Math.cos(aLat * RAD) * Math.sin(bLat * RAD) - Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const tileX = (lon, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor(((lon + 180) / 360) * 2 ** z)));
const tileY = (lat, z) => {
  const r = lat * RAD;
  return Math.min(2 ** z - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z)));
};

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---- reading a chunk ---- */

function decodeChunk(buf) {
  let pos = 0;
  const varint = () => {
    let b = buf[pos++];
    let v = b & 0x7f;
    let mul = 128;
    while (b >= 0x80) {
      b = buf[pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    }
    return v;
  };
  const zigzag = () => {
    const v = varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  };

  const text = new TextDecoder();
  const nameCount = varint();
  const names = new Array(nameCount + 1);
  names[0] = '';
  for (let i = 1; i <= nameCount; i++) {
    const n = varint();
    names[i] = text.decode(buf.subarray(pos, pos + n));
    pos += n;
  }

  const n = varint();
  const ids = new Uint32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v += varint();
    ids[i] = v;
  }
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  let la = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    la += zigzag();
    lo += zigzag();
    lat[i] = la;
    lon[i] = lo;
  }

  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + varint();
  const m = start[n];
  const to = new Uint32Array(m);
  for (let i = 0; i < n; i++) for (let e = start[i]; e < start[i + 1]; e++) to[e] = ids[i] + zigzag();
  const len = new Uint32Array(m);
  for (let e = 0; e < m; e++) len[e] = varint();
  const cls = new Uint8Array(m);
  for (let e = 0; e < m; e++) cls[e] = buf[pos++];
  const bits = new Uint8Array(m);
  for (let e = 0; e < m; e++) bits[e] = buf[pos++];
  const kmh = new Uint8Array(m);
  for (let e = 0; e < m; e++) kmh[e] = buf[pos++];
  const name = new Uint32Array(m);
  for (let e = 0; e < m; e++) name[e] = varint();

  // Shapes: each edge's points after its start, the last being its target.
  const shapeStart = new Uint32Array(m + 1);
  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let e = start[i]; e < start[i + 1]; e++) {
      let count = varint() + 1;
      let sLa = lat[i];
      let sLo = lon[i];
      while (count--) {
        sLa += zigzag();
        sLo += zigzag();
        pts.push(sLa, sLo);
      }
      shapeStart[e + 1] = pts.length;
    }
  }

  const restrictions = new Map();
  const rCount = varint();
  for (let i = 0; i < rCount; i++) {
    const via = varint();
    const from = varint();
    const toV = varint();
    const only = buf[pos++];
    if (!restrictions.has(via)) restrictions.set(via, []);
    restrictions.get(via).push({ from, to: toV, only: only === 1 });
  }

  return { names, ids, lat, lon, start, to, len, cls, bits, kmh, name, shapeStart, shape: Int32Array.from(pts), restrictions };
}

function vertexIndex(chunk, id) {
  const { ids } = chunk;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* ---- the file ---- */

export class RouteGraph {
  // read(offset, length) answers those bytes of the file.
  constructor(read) {
    this.read = read;
    this.chunks = new Map();
    this.pending = new Map();
  }

  static async open(read) {
    const g = new RouteGraph(read);
    const head = await read(0, 12);
    if (new TextDecoder().decode(head.subarray(0, 8)) !== 'UWUROUTE') throw new Error('Not a routing file');
    const headerLen = new DataView(head.buffer, head.byteOffset, 12).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(await gunzip(await read(12, headerLen))));
    g.dataStart = 12 + headerLen;
    g.bounds = header.bounds;
    g.zLocal = header.zLocal;
    g.zMajor = header.zMajor;
    g.local = new Map();
    g.major = new Map();
    const fill = (flat, into, tag) => {
      for (let i = 0; i < flat.length; i += 4) into.set(flat[i] * 2 ** 24 + flat[i + 1], { tag: `${tag}${i}`, offset: flat[i + 2], length: flat[i + 3] });
    };
    fill(header.local, g.local, 'l');
    fill(header.major, g.major, 'm');
    return g;
  }

  async load(entry) {
    const hit = this.chunks.get(entry.tag);
    if (hit) {
      // Newest last, so the oldest is first when one has to go.
      this.chunks.delete(entry.tag);
      this.chunks.set(entry.tag, hit);
      return hit;
    }
    let wait = this.pending.get(entry.tag);
    if (!wait) {
      wait = this.read(this.dataStart + entry.offset, entry.length).then(gunzip).then(decodeChunk);
      this.pending.set(entry.tag, wait);
    }
    const chunk = await wait;
    this.pending.delete(entry.tag);
    this.chunks.set(entry.tag, chunk);
    if (this.chunks.size > CHUNK_CACHE) this.chunks.delete(this.chunks.keys().next().value);
    return chunk;
  }

  localEntry(lat, lon) {
    return this.local.get(tileX(lon, this.zLocal) * 2 ** 24 + tileY(lat, this.zLocal));
  }

  majorEntry(lat, lon) {
    return this.major.get(tileX(lon, this.zMajor) * 2 ** 24 + tileY(lat, this.zMajor));
  }

  /* The nearest road a mode may use. Answers the point on it and how to get on and off there:
     every directed edge through that point, with how far along the edge it is. */
  async snap(lat, lon, modeName) {
    const mode = MODES[modeName];
    const cx = tileX(lon, this.zLocal);
    const cy = tileY(lat, this.zLocal);
    const cos = Math.cos(lat * RAD);
    let best = Infinity;
    const found = [];

    for (let ring = 0; ring <= 3; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const entry = this.local.get((cx + dx) * 2 ** 24 + (cy + dy));
          if (!entry) continue;
          const chunk = await this.load(entry);
          const { start, bits, shape, shapeStart, lat: vLat, lon: vLon, ids } = chunk;
          for (let i = 0; i < ids.length; i++) {
            for (let e = start[i]; e < start[i + 1]; e++) {
              if (!(bits[e] & mode.bit)) continue;
              let ax = vLon[i] * 1e-6;
              let ay = vLat[i] * 1e-6;
              for (let p = shapeStart[e]; p < shapeStart[e + 1]; p += 2) {
                const bx = shape[p + 1] * 1e-6;
                const by = shape[p] * 1e-6;
                const dxS = (bx - ax) * cos;
                const dyS = by - ay;
                const px = (lon - ax) * cos;
                const py = lat - ay;
                const l2 = dxS * dxS + dyS * dyS;
                const t = l2 ? Math.max(0, Math.min(1, (px * dxS + py * dyS) / l2)) : 0;
                const ex = px - t * dxS;
                const ey = py - t * dyS;
                const d = Math.sqrt(ex * ex + ey * ey) * 111195;
                if (d < best + 1) {
                  if (d < best) best = d;
                  found.push({ chunk, vi: i, e, seg: p, t, d, lat: ay + t * (by - ay), lon: ax + t * (bx - ax) });
                }
                ax = bx;
                ay = by;
              }
            }
          }
        }
      }
      // A closer road can't be in a further ring once one is nearer than a ring's width.
      if (best < 1500 * ring + 500) break;
    }
    const edges = found.filter((f) => f.d < best + 1);
    if (!edges.length) return null;
    const { lat: sLat, lon: sLon } = edges[0];
    return { lat: sLat, lon: sLon, distance: best, edges };
  }
}

/* ---- a small binary heap of [cost, label] ---- */

class Heap {
  constructor() {
    this.cost = [];
    this.label = [];
  }

  get size() {
    return this.cost.length;
  }

  push(cost, label) {
    const { cost: c, label: l } = this;
    let i = c.length;
    c.push(cost);
    l.push(label);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= cost) break;
      c[i] = c[p];
      l[i] = l[p];
      i = p;
    }
    c[i] = cost;
    l[i] = label;
  }

  pop() {
    const { cost: c, label: l } = this;
    const top = l[0];
    const lastC = c.pop();
    const lastL = l.pop();
    const n = c.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && c[k + 1] < c[k]) k++;
        if (c[k] >= lastC) break;
        c[i] = c[k];
        l[i] = l[k];
        i = k;
      }
      c[i] = lastC;
      l[i] = lastL;
    }
    return top;
  }
}

/* ---- the search ---- */

const edgeSeconds = (chunk, e, modeName, fraction = 1) => {
  const m = chunk.len[e] * fraction;
  const cls = chunk.cls[e] & 15;
  if (modeName === 'car') return m / (Math.max(5, chunk.kmh[e]) / 3.6);
  const kmh = (modeName === 'bike' ? BIKE_KMH : FOOT_KMH)[cls] || 4;
  return m / (kmh / 3.6);
};

const edgeCost = (chunk, e, modeName, fraction = 1) => {
  const secs = edgeSeconds(chunk, e, modeName, fraction);
  const cls = chunk.cls[e] & 15;
  if (modeName === 'bike') return secs * BIKE_COST[cls];
  if (modeName === 'foot') return secs * FOOT_COST[cls] * (chunk.bits[e] & SHELTER_BIT ? SHELTER_COST : 1);
  return secs;
};

// How far along a directed edge a snapped point is, as a fraction of its length.
function alongEdge(f) {
  const { chunk, vi, e, seg, t } = f;
  let ax = chunk.lat[vi];
  let ay = chunk.lon[vi];
  let total = 0;
  let upTo = 0;
  for (let p = chunk.shapeStart[e]; p < chunk.shapeStart[e + 1]; p += 2) {
    const d = Math.hypot(chunk.shape[p] - ax, (chunk.shape[p + 1] - ay) * Math.cos(ax * 1e-6 * RAD));
    if (p < seg) upTo += d;
    else if (p === seg) upTo += d * t;
    total += d;
    ax = chunk.shape[p];
    ay = chunk.shape[p + 1];
  }
  return total ? upTo / total : 0;
}

async function search(graph, from, to, modeName, { hierarchy, timeLimitMs, shouldStop }) {
  const mode = MODES[modeName];
  const heur = (lat, lon) => (metres(lat, lon, to.lat, to.lon) / mode.maxMps) * GREED;
  const started = Date.now();

  // Each label: where it is and how it got there.
  const labels = [];
  const bestAt = new Map();
  const heap = new Heap();

  // A restricted junction has to remember which way it was entered, since that decides where it
  // can go next. Everywhere else, one best way in is enough.
  const stateKey = (vertex, prev, restricted) => (restricted ? vertex + (prev + 1) * 2 ** 26 : vertex);

  const seed = (vertex, lat, lon, cost, edge) => {
    const label = { vertex, lat, lon, g: cost, prev: -1, edge, from: -1 };
    labels.push(label);
    bestAt.set(vertex, cost);
    heap.push(cost + heur(lat, lon), labels.length - 1);
  };

  // Getting on: from the snapped point, along an edge to its far junction.
  for (const f of from.edges) {
    const frac = alongEdge(f);
    const { chunk, e } = f;
    const end = chunk.shapeStart[e + 1];
    seed(chunk.to[e], chunk.shape[end - 2] * 1e-6, chunk.shape[end - 1] * 1e-6, edgeCost(chunk, e, modeName, 1 - frac), { startPart: f, frac });
  }

  // Getting off: at the near junction of an edge, then along it to the snapped point.
  const goals = new Map();
  for (const f of to.edges) {
    const frac = alongEdge(f);
    const vertex = f.chunk.ids[f.vi];
    const cost = edgeCost(f.chunk, f.e, modeName, frac);
    const had = goals.get(vertex);
    if (!had || had.cost > cost) goals.set(vertex, { cost, part: f, frac });
  }

  // Both points on the same stretch of road, in travel order.
  let bestFinish = null;
  let bestTotal = Infinity;
  for (const a of from.edges) {
    for (const b of to.edges) {
      if (a.chunk === b.chunk && a.e === b.e) {
        const fa = alongEdge(a);
        const fb = alongEdge(b);
        if (fb >= fa) {
          const c = edgeCost(a.chunk, a.e, modeName, fb - fa);
          if (c < bestTotal) {
            bestTotal = c;
            bestFinish = { direct: true, part: a, fa, fb };
          }
        }
      }
    }
  }

  let steps = 0;
  while (heap.size) {
    const labelIndex = heap.pop();
    const label = labels[labelIndex];
    const { vertex, lat, lon, g } = label;
    if (g + heur(lat, lon) / GREED >= bestTotal) break;
    if (label.closed) continue;
    label.closed = true;

    const goal = goals.get(vertex);
    if (goal && g + goal.cost < bestTotal) {
      bestTotal = g + goal.cost;
      bestFinish = { label: labelIndex, part: goal.part, frac: goal.frac };
    }

    if (++steps % 512 === 0) {
      if (Date.now() - started > timeLimitMs) return { timedOut: true, finish: bestFinish, labels };
      if (shouldStop?.()) return { stopped: true };
      // Lets a newer request or a cancel get a word in.
      await new Promise((r) => setTimeout(r));
    }

    const far = hierarchy
      && metres(lat, lon, from.lat, from.lon) > mode.near
      && metres(lat, lon, to.lat, to.lon) > mode.near;

    let chunk = null;
    let vi = -1;
    if (far) {
      const entry = graph.majorEntry(lat, lon);
      if (entry) {
        chunk = await graph.load(entry);
        vi = vertexIndex(chunk, vertex);
      }
      // Off the main roads while far from both ends: nothing to follow from here.
      if (vi < 0) continue;
    } else {
      const entry = graph.localEntry(lat, lon);
      if (!entry) continue;
      chunk = await graph.load(entry);
      vi = vertexIndex(chunk, vertex);
      if (vi < 0) continue;
    }

    const rules = modeName === 'car' ? chunk.restrictions.get(vertex) : null;
    let onlyTo = null;
    if (rules) {
      for (const r of rules) if (r.only && r.from === label.from) onlyTo = r.to;
    }

    for (let e = chunk.start[vi]; e < chunk.start[vi + 1]; e++) {
      if (!(chunk.bits[e] & mode.bit)) continue;
      const target = chunk.to[e];
      if (rules) {
        if (onlyTo != null && target !== onlyTo) continue;
        if (rules.some((r) => !r.only && r.from === label.from && r.to === target)) continue;
      }
      const cost = g + edgeCost(chunk, e, modeName);
      const end = chunk.shapeStart[e + 1];
      const tLat = chunk.shape[end - 2] * 1e-6;
      const tLon = chunk.shape[end - 1] * 1e-6;
      // A junction with rules is kept once per way in, since the rules depend on it. That is only
      // known here for junctions in this chunk; one just over a chunk's edge still obeys its rules
      // when reached, but keeps only its best way in.
      const key = stateKey(target, vertex, Boolean(chunk.restrictions.get(target)));
      const had = bestAt.get(key);
      if (had != null && had <= cost) continue;
      bestAt.set(key, cost);
      labels.push({ vertex: target, lat: tLat, lon: tLon, g: cost, prev: labelIndex, from: vertex, edge: { chunk, e } });
      heap.push(cost + heur(tLat, tLon), labels.length - 1);
    }
  }
  return { finish: bestFinish, labels };
}

/* ---- from the search to something to follow ---- */

function pushPoint(coords, lon, lat) {
  const last = coords[coords.length - 1];
  if (!last || last[0] !== lon || last[1] !== lat) coords.push([lon, lat]);
}

// One stretch of road along the route, in order.
function edgePoints(chunk, vi, e, fromFrac, toFrac) {
  const pts = [[chunk.lon[vi] * 1e-6, chunk.lat[vi] * 1e-6]];
  for (let p = chunk.shapeStart[e]; p < chunk.shapeStart[e + 1]; p += 2) pts.push([chunk.shape[p + 1] * 1e-6, chunk.shape[p] * 1e-6]);
  if (fromFrac <= 0 && toFrac >= 1) return pts;

  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + metres(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  const total = lengths[lengths.length - 1] || 1;
  const at = (frac) => {
    const d = frac * total;
    for (let i = 1; i < pts.length; i++) {
      if (lengths[i] >= d) {
        const t = (d - lengths[i - 1]) / ((lengths[i] - lengths[i - 1]) || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      }
    }
    return pts[pts.length - 1];
  };
  const out = [at(fromFrac)];
  for (let i = 1; i < pts.length - 1; i++) {
    if (lengths[i] > fromFrac * total && lengths[i] < toFrac * total) out.push(pts[i]);
  }
  out.push(at(toFrac));
  return out;
}

const TURN_WORDS = (angle) => {
  const a = Math.abs(angle);
  const side = angle < 0 ? 'left' : 'right';
  if (a < 25) return { modifier: 'straight', verb: 'Continue' };
  if (a < 50) return { modifier: `slight ${side}`, verb: `Keep ${side}` };
  if (a < 125) return { modifier: side, verb: `Turn ${side}` };
  if (a < 165) return { modifier: `sharp ${side}`, verb: `Turn sharp ${side}` };
  return { modifier: 'uturn', verb: 'Make a U-turn' };
};

export function stepText(step) {
  const onto = step.name ? ` onto ${step.name}` : '';
  switch (step.type) {
    case 'depart': return step.name ? `Head ${step.compass} on ${step.name}` : `Head ${step.compass}`;
    case 'arrive': return 'You have arrived';
    case 'roundabout': return `At the roundabout, take exit ${step.exit}${onto}`;
    case 'ramp': return `Take the ramp${onto}`;
    case 'ferry': return `Take the ferry${step.name ? `: ${step.name}` : ''}`;
    case 'continue': return step.name ? `Continue onto ${step.name}` : 'Continue';
    default: return `${TURN_WORDS(step.angle ?? 90).verb}${onto}`;
  }
}

const SHORTEST_STEP_M = 15;
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compassOf = (deg) => COMPASS[Math.round(deg / 45) % 8];

// The way a stretch leaves its start and arrives at its end, read a little in from each end.
function headings(pts) {
  const n = pts.length;
  return {
    out: bearing(pts[0][1], pts[0][0], pts[1][1], pts[1][0]),
    in: bearing(pts[n - 2][1], pts[n - 2][0], pts[n - 1][1], pts[n - 1][0]),
  };
}

function buildSteps(legs) {
  const steps = [];
  let current = null;
  const close = () => {
    if (current) steps.push(current);
    current = null;
  };

  legs.forEach((leg, i) => {
    const prev = legs[i - 1];
    if (!prev) {
      current = {
        type: 'depart', name: leg.name, distance: 0, duration: 0, at: leg.pts[0], index: leg.index,
        compass: compassOf(headings(leg.pts).out),
      };
    } else {
      const angle = ((headings(leg.pts).out - headings(prev.pts).in + 540) % 360) - 180;
      const renamed = leg.name !== prev.name;
      const entering = leg.roundabout && !prev.roundabout;
      const leaving = !leg.roundabout && prev.roundabout;
      const onRamp = leg.link && !prev.link;
      const ferry = leg.cls === CLASS.ferry && prev.cls !== CLASS.ferry;

      if (leg.roundabout && prev.roundabout) {
        // Going round: counted, not announced.
        if (current?.type === 'roundabout' && leg.branches > 1) current.exit++;
      } else if (entering) {
        close();
        current = { type: 'roundabout', exit: 1, name: '', distance: 0, duration: 0, at: leg.pts[0], index: leg.index };
      } else if (leaving) {
        if (current?.type === 'roundabout') current.name = leg.name;
      } else if (ferry) {
        close();
        current = { type: 'ferry', name: leg.name, distance: 0, duration: 0, at: leg.pts[0], index: leg.index };
      } else if (onRamp) {
        close();
        current = { type: 'ramp', name: leg.name, distance: 0, duration: 0, at: leg.pts[0], index: leg.index };
      } else if (Math.abs(angle) >= (renamed ? 35 : 60) && (leg.branches > 2 || renamed)) {
        // Along one street, only a real corner is worth a line. A path bending round a planter isn't.
        close();
        current = { type: 'turn', angle: Math.round(angle), name: leg.name, distance: 0, duration: 0, at: leg.pts[0], index: leg.index };
      } else if (renamed && leg.name) {
        close();
        current = { type: 'continue', angle: Math.round(angle), name: leg.name, distance: 0, duration: 0, at: leg.pts[0], index: leg.index };
      }
    }
    current.distance += leg.distance;
    current.duration += leg.duration;
  });
  close();

  // A step shorter than this can't be followed as its own instruction, and is usually a kerb or a
  // crossing: it goes into the one before.
  for (let i = steps.length - 1; i > 0; i--) {
    const s = steps[i];
    if (s.distance < SHORTEST_STEP_M && (s.type === 'turn' || s.type === 'continue')) {
      steps[i - 1].distance += s.distance;
      steps[i - 1].duration += s.duration;
      steps.splice(i, 1);
    }
  }
  // Two steps left next to each other saying the same thing become one.
  for (let i = steps.length - 1; i > 0; i--) {
    const s = steps[i];
    if (s.type === 'continue' && s.name === steps[i - 1].name) {
      steps[i - 1].distance += s.distance;
      steps[i - 1].duration += s.duration;
      steps.splice(i, 1);
    }
  }

  const last = legs[legs.length - 1];
  steps.push({ type: 'arrive', name: '', distance: 0, duration: 0, at: last.pts[last.pts.length - 1], index: last.index + last.pts.length - 1 });
  for (const s of steps) {
    s.distance = Math.round(s.distance);
    s.duration = Math.round(s.duration);
    s.text = stepText(s);
  }
  return steps;
}

/* Finds the way. Answers { distance, duration, coords, steps, source: 'offline', mode }, or null
   when there isn't one. Throws when a point is too far from any road. */
export async function findRoute(graph, from, to, modeName, { shouldStop, timeLimitMs = 25000 } = {}) {
  const a = await graph.snap(from.lat, from.lon, modeName);
  const b = await graph.snap(to.lat, to.lon, modeName);
  if (!a || !b) return null;

  let run = await search(graph, a, b, modeName, { hierarchy: true, timeLimitMs, shouldStop });
  if (run.stopped) return null;
  // The main roads alone didn't connect them: every road, this once.
  if (!run.finish) {
    run = await search(graph, a, b, modeName, { hierarchy: false, timeLimitMs, shouldStop });
    if (run.stopped || !run.finish) return null;
  }
  const { finish, labels } = run;

  const legs = [];
  const coords = [];

  const addLeg = (chunk, vi, e, fromFrac, toFrac) => {
    const pts = edgePoints(chunk, vi, e, fromFrac, toFrac);
    const span = toFrac - fromFrac;
    const index = Math.max(0, coords.length - 1);
    for (const p of pts) pushPoint(coords, p[0], p[1]);
    let branches = 0;
    for (let k = chunk.start[vi]; k < chunk.start[vi + 1]; k++) if (chunk.bits[k] & MODES[modeName].bit) branches++;
    legs.push({
      pts,
      index,
      name: chunk.names[chunk.name[e]],
      cls: chunk.cls[e] & 15,
      link: Boolean(chunk.cls[e] & 16),
      roundabout: Boolean(chunk.cls[e] & 32),
      distance: chunk.len[e] * span,
      duration: edgeSeconds(chunk, e, modeName, span),
      branches,
    });
  };

  if (finish.direct) {
    addLeg(finish.part.chunk, finish.part.vi, finish.part.e, finish.fa, finish.fb);
  } else {
    // Walk the labels back from the end.
    const chain = [];
    for (let i = finish.label; i !== -1; i = labels[i].prev) chain.unshift(labels[i]);
    const first = chain[0].edge.startPart;
    addLeg(first.chunk, first.vi, first.e, chain[0].edge.frac, 1);
    for (let i = 1; i < chain.length; i++) {
      const { chunk, e } = chain[i].edge;
      const vi = vertexIndex(chunk, chain[i - 1].vertex);
      addLeg(chunk, vi, e, 0, 1);
    }
    addLeg(finish.part.chunk, finish.part.vi, finish.part.e, 0, finish.frac);
  }

  const usable = legs.filter((l) => l.pts.length >= 2 && l.distance >= 0);
  if (!usable.length) return null;
  return {
    source: 'offline',
    mode: modeName,
    distance: Math.round(usable.reduce((n, l) => n + l.distance, 0)),
    duration: Math.round(usable.reduce((n, l) => n + l.duration, 0)),
    coords,
    steps: buildSteps(usable),
    snapped: { from: [a.lon, a.lat], to: [b.lon, b.lat] },
  };
}

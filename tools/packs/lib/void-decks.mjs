// Walk-only links that OpenStreetMap doesn't have: through the void decks of Singapore's HDB blocks, and
// along covered walkways drawn only as a roof.
//
// A void deck is the open ground floor of an HDB block, and people cut through them all the time. Hardly any
// are mapped: a way passes through 1 to 4% of blocks in most towns. So a route has to go around a block that
// anyone would walk straight through. These links are inferred, not surveyed, so they're careful about where
// they go:
//
//   - Only blocks HDB's own list says hold flats with no shops on the ground floor. Condos never.
//   - A crossing needs a walkable way on both sides, reached without passing a fence, a wall, a drain, a
//     railway, a road nobody may walk on or another building. Other void deck blocks don't count as being in
//     the way, since rows of them are how estates are built, and people walk straight through.
//   - Never onto a bridge, a tunnel, a staircase or anything on another level, which only look close from above.
//
// Everything here is in metres on a flat plane, which is near enough across Singapore.

const RAD = Math.PI / 180;
// Singapore. No other country has void decks by that name, and the list below names only Singapore's blocks.
export const SINGAPORE = [103.59, 1.15, 104.1, 1.48];
const COS = Math.cos(1.35 * RAD);
const M_PER_DEG = 111195;

// How far apart crossings of a long block are.
const CROSSING_EVERY_M = 40;
// Further across than this, it's a big podium or a complex rather than a slab with a void deck under it.
const WIDEST_BLOCK_M = 40;
// How far a crossing looks straight ahead for a way to join, and how close one must be otherwise.
const REACH_M = 70;
const NEAREST_M = 25;
// Blocks shorter than this have no void deck to speak of.
const FEWEST_LEVELS = 3;
// A covered walkway's roof is long and thin. Wider or shorter, it's a car park, a pavilion or a bus stop.
const ROOF_WIDEST_M = 8;
const ROOF_SHORTEST_M = 15;
const ROOF_THINNESS = 3;
// A connection this close to an existing node uses that node, rather than adding another.
const SAME_NODE_M = 1.5;

export const toXY = (lat, lon) => [lon * COS * M_PER_DEG, lat * M_PER_DEG];
export const fromXY = ([x, y]) => [y / M_PER_DEG, x / COS / M_PER_DEG];

/* ---- HDB's list of blocks, against OpenStreetMap's addresses ---- */

// HDB shortens street words and OpenStreetMap spells them out, so both end up spelled out.
const STREET_WORDS = {
  AVE: 'AVENUE', ST: 'STREET', RD: 'ROAD', DR: 'DRIVE', CRES: 'CRESCENT', CL: 'CLOSE', PL: 'PLACE', PK: 'PARK', GDN: 'GARDEN', GDNS: 'GARDENS',
  LOR: 'LORONG', JLN: 'JALAN', BT: 'BUKIT', TG: 'TANJONG', KG: 'KAMPONG', UPP: 'UPPER', NTH: 'NORTH', STH: 'SOUTH', CTRL: 'CENTRAL', CTR: 'CENTRE',
  "C'WEALTH": 'COMMONWEALTH', TER: 'TERRACE', HTS: 'HEIGHTS', MKT: 'MARKET', SQ: 'SQUARE', BLVD: 'BOULEVARD',
};

export const normaliseStreet = (street) => String(street).toUpperCase().replace(/[.,]/g, '').split(/\s+/).filter(Boolean).map((w) => STREET_WORDS[w] || w).join(' ');

const blockKey = (number, street) => `${String(number).toUpperCase().trim()}|${normaliseStreet(street)}`;

export function readBlockList({ open, shops }) {
  const list = new Map();
  for (const [street, blocks] of Object.entries(open)) for (const b of blocks) list.set(blockKey(b, street), true);
  for (const [street, blocks] of Object.entries(shops)) for (const b of blocks) list.set(blockKey(b, street), false);
  return list;
}

// Whether a building is an HDB block somebody can walk through. HDB's list decides when it knows the address.
// Without one, OpenStreetMap saying it's HDB is good enough.
export function isVoidDeckBlock(tags, blockList) {
  if (tags.building !== 'apartments' && tags.building !== 'residential') return false;
  const levels = Number(tags['building:levels']);
  if (levels && levels < FEWEST_LEVELS) return false;
  if (tags['addr:housenumber'] && tags['addr:street']) {
    const known = blockList.get(blockKey(tags['addr:housenumber'], tags['addr:street']));
    if (known != null) return known;
  }
  return String(tags.residential).toLowerCase() === 'hdb';
}

export const isRoof = (tags) => tags.building === 'roof';

const BARRIERS = new Set(['fence', 'wall', 'hedge', 'retaining_wall', 'city_wall', 'guard_rail', 'jersey_barrier', 'ditch']);

// Lines nobody walks across, at ground level: the rest pass overhead or underneath.
export function isObstacle(tags) {
  if (tags.bridge || tags.tunnel || (tags.layer && tags.layer !== '0')) return false;
  return Boolean(tags.waterway || tags.railway || tags.natural === 'water' || BARRIERS.has(tags.barrier));
}

// A road nobody may walk on, which is as good as a wall.
export const isClosedRoad = (tags) => isObstacle({ ...tags, barrier: 'wall' });

// Whether a link may join this way: on the ground, and a way rather than a staircase or a bridge.
export function isGroundWay(tags) {
  if (tags.highway === 'steps' || tags.route === 'ferry' || tags.bridge || tags.indoor || tags.level) return false;
  if (tags.tunnel && tags.tunnel !== 'building_passage') return false;
  return !tags.layer || tags.layer === '0';
}

/* ---- finding things nearby ---- */

const CELL_M = 50;

class Grid {
  constructor() {
    this.cells = new Map();
  }

  // A segment goes in each cell it passes through, found by stepping along it rather than filling its box, which
  // for a long diagonal would be millions of cells.
  add(ax, ay, bx, by, item) {
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL_M / 4));
    let last = null;
    for (let i = 0; i <= steps; i++) {
      const key = Math.floor((ax + ((bx - ax) * i) / (steps || 1)) / CELL_M) * 1e7 + Math.floor((ay + ((by - ay) * i) / (steps || 1)) / CELL_M);
      if (key === last) continue;
      last = key;
      const cell = this.cells.get(key);
      if (cell) cell.push(item);
      else this.cells.set(key, [item]);
    }
  }

  // Everything whose cell touches this box. An item can come back more than once.
  near(minX, minY, maxX, maxY, visit) {
    const x0 = Math.floor(minX / CELL_M);
    const x1 = Math.floor(maxX / CELL_M);
    const y0 = Math.floor(minY / CELL_M);
    const y1 = Math.floor(maxY / CELL_M);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const cell = this.cells.get(x * 1e7 + y);
        if (cell) for (const item of cell) visit(item);
      }
    }
  }
}

// How far along a-b the segment c-d crosses it, 0 to 1, or -1 if it doesn't.
function crossAt(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (!denom) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/* ---- the shape of a block ---- */

// The rectangle that fits a closed outline best, which always lies along one of its edges. Answers its centre,
// long and short directions, and half its length and width.
export function fitRectangle(ring) {
  let best = null;
  for (let i = 0; i + 1 < ring.length; i++) {
    const dx = ring[i + 1][0] - ring[i][0];
    const dy = ring[i + 1][1] - ring[i][1];
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const ux = dx / len;
    const uy = dy / len;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, y] of ring) {
      const u = x * ux + y * uy;
      const v = x * -uy + y * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (best && area >= best.area) continue;
    const uMid = (u0 + u1) / 2;
    const vMid = (v0 + v1) / 2;
    const c = [uMid * ux - vMid * uy, uMid * uy + vMid * ux];
    const long = u1 - u0 >= v1 - v0;
    best = {
      area,
      centre: c,
      along: long ? [ux, uy] : [-uy, ux],
      across: long ? [-uy, ux] : [ux, uy],
      halfLength: Math.max(u1 - u0, v1 - v0) / 2,
      halfWidth: Math.min(u1 - u0, v1 - v0) / 2,
    };
  }
  return best;
}

// Where a line through a point meets an outline: the first and last, as distances along its direction.
function chord(ring, point, dir) {
  const far = 10000;
  const ax = point[0] - dir[0] * far;
  const ay = point[1] - dir[1] * far;
  const bx = point[0] + dir[0] * far;
  const by = point[1] + dir[1] * far;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const t = crossAt(ax, ay, bx, by, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
    if (t < 0) continue;
    const s = t * 2 * far - far;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return lo < hi ? [lo, hi] : null;
}

/* ---- the links ---- */

/* Answers the links to add, each { name, sheltered, points: [[x, y], ...], from, to }, with from and to saying
   where it joins: { way, seg, t } for that way's segment seg, t along it.

     blocks     [{ ring: [[x, y], ...], name }]   HDB blocks to cross, closed outlines
     roofs      [{ ring }]                        building=roof outlines
     buildings  [ring, ...]                       every building, blocks and roofs too
     obstacles  [line, ...]                       lines nobody crosses, closed roads too
     ways       [{ way, points: [[x, y], ...] }]  ways a link may join */
export function findLinks({ blocks, roofs, buildings, obstacles, ways }) {
  const paths = new Grid();
  for (const w of ways) {
    for (let i = 0; i + 1 < w.points.length; i++) {
      const [ax, ay] = w.points[i];
      const [bx, by] = w.points[i + 1];
      paths.add(ax, ay, bx, by, { w, i, ax, ay, bx, by });
    }
  }
  const walls = new Grid();
  const addLine = (line, owner) => {
    for (let i = 0; i + 1 < line.length; i++) walls.add(line[i][0], line[i][1], line[i + 1][0], line[i + 1][1], { ax: line[i][0], ay: line[i][1], bx: line[i + 1][0], by: line[i + 1][1], owner });
  };
  for (const line of obstacles) addLine(line, null);
  const open = new Set(blocks.map((b) => b.ring));
  // A void deck block is no wall, and so isn't added as one.
  for (const ring of buildings) if (!open.has(ring)) addLine(ring, ring);

  // The first wall a straight line from a to b meets, 0 to 1 along it, or 2 with none. Its own roof doesn't count.
  const wallAt = (ax, ay, bx, by, own) => {
    let hit = 2;
    walls.near(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (s) => {
      if (s.owner === own) return;
      const t = crossAt(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by);
      if (t >= 0 && t < hit) hit = t;
    });
    return hit;
  };

  // Joins a way from a point just outside a building, going in a direction: the first way straight ahead if
  // nothing's in the way, and otherwise the nearest.
  const join = (from, dir, own) => {
    const [ox, oy] = from;
    const ex = ox + dir[0] * REACH_M;
    const ey = oy + dir[1] * REACH_M;
    let bestT = 2;
    let ahead = null;
    paths.near(Math.min(ox, ex), Math.min(oy, ey), Math.max(ox, ex), Math.max(oy, ey), (s) => {
      const t = crossAt(ox, oy, ex, ey, s.ax, s.ay, s.bx, s.by);
      if (t >= 0 && t < bestT) {
        bestT = t;
        ahead = s;
      }
    });
    if (ahead && wallAt(ox, oy, ex, ey, own) > bestT) {
      const px = ox + (ex - ox) * bestT;
      const py = oy + (ey - oy) * bestT;
      const len = Math.hypot(ahead.bx - ahead.ax, ahead.by - ahead.ay) || 1;
      return { way: ahead.w.way, seg: ahead.i, t: Math.hypot(px - ahead.ax, py - ahead.ay) / len, at: [px, py] };
    }
    let nearest = null;
    let nearestD = NEAREST_M;
    paths.near(ox - NEAREST_M, oy - NEAREST_M, ox + NEAREST_M, oy + NEAREST_M, (s) => {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((ox - s.ax) * dx + (oy - s.ay) * dy) / l2)) : 0;
      const px = s.ax + t * dx;
      const py = s.ay + t * dy;
      const d = Math.hypot(ox - px, oy - py);
      if (d >= nearestD) return;
      // Forwards from the building, not back through it or along its wall.
      if ((px - ox) * dir[0] + (py - oy) * dir[1] <= 0) return;
      if (wallAt(ox, oy, px, py, own) <= 1) return;
      nearestD = d;
      nearest = { way: s.w.way, seg: s.i, t, at: [px, py] };
    });
    return nearest;
  };

  // A way that goes in one side and out the other needs nothing added beside it. One clipping a corner, as paths
  // drawn roughly round a block often do, still leaves the block to go around.
  const crossedAlready = (ring, box) => {
    const seen = new Set();
    const where = new Map();
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    let through = false;
    paths.near(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (s) => {
      if (through || seen.has(s)) return;
      seen.add(s);
      for (let i = 0; i + 1 < ring.length; i++) {
        const t = crossAt(s.ax, s.ay, s.bx, s.by, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
        if (t < 0) continue;
        const x = s.ax + (s.bx - s.ax) * t;
        const y = s.ay + (s.by - s.ay) * t;
        const had = where.get(s.w);
        if (had && Math.hypot(had[0] - x, had[1] - y) >= box.halfWidth * 1.2) through = true;
        if (!had) where.set(s.w, [x, y]);
      }
    });
    return through;
  };

  const links = [];

  // From one side of an outline to the other, through a point on the way.
  const cross = (ring, through, dir, widest, name, sheltered) => {
    const span = chord(ring, through, dir);
    if (!span || span[1] - span[0] > widest) return false;
    const point = (s) => [through[0] + dir[0] * s, through[1] + dir[1] * s];
    const a = point(span[0] - 0.5);
    const b = point(span[1] + 0.5);
    const from = join(a, [-dir[0], -dir[1]], ring);
    if (!from) return false;
    const to = join(b, dir, ring);
    if (!to) return false;
    links.push({ name, sheltered, points: [from.at, a, b, to.at], from, to });
    return true;
  };

  for (const { ring, name } of blocks) {
    const box = fitRectangle(ring);
    if (!box || crossedAlready(ring, box)) continue;
    const length = box.halfLength * 2;
    const count = Math.max(1, Math.round(length / CROSSING_EVERY_M));
    for (let i = 0; i < count; i++) {
      const along = (((i + 0.5) / count) * 2 - 1) * box.halfLength;
      cross(ring, [box.centre[0] + box.along[0] * along, box.centre[1] + box.along[1] * along], box.across, WIDEST_BLOCK_M, name, false);
    }
  }

  for (const { ring } of roofs) {
    const box = fitRectangle(ring);
    if (!box) continue;
    const length = box.halfLength * 2;
    const width = box.halfWidth * 2;
    if (width > ROOF_WIDEST_M || length < ROOF_SHORTEST_M || length < width * ROOF_THINNESS || crossedAlready(ring, box)) continue;
    cross(ring, box.centre, box.along, length + 2, 'Covered walkway', true);
  }

  return links;
}

// Which end of a segment a join uses instead of adding a node: 0, 1, or -1 for neither.
export function sameNode(t, segLength) {
  if (t * segLength < SAME_NODE_M) return 0;
  if ((1 - t) * segLength < SAME_NODE_M) return 1;
  return -1;
}

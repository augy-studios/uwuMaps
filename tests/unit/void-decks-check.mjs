// The walking links through void decks: node tests/unit/void-decks-check.mjs <file.route>
// First on made-up blocks, where the right answer is known, then on a real routing file.
import { openSync, readSync } from 'node:fs';
import assert from 'node:assert/strict';
import { classify } from '../../tools/packs/lib/osm-profile.mjs';
import { findLinks, fitRectangle, isClosedRoad, isGroundWay, isObstacle, isVoidDeckBlock, normaliseStreet, readBlockList } from '../../tools/packs/lib/void-decks.mjs';
import { RouteGraph, findRoute } from '../../main-site/js/route-core.js';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

/* ---- telling blocks apart ---- */

const list = readBlockList({ open: { 'ANG MO KIO AVE 6': ['728'] }, shops: { 'BT BATOK ST 21': ['200'] } });

check("HDB's street words match OpenStreetMap's", () => {
  assert.equal(normaliseStreet('ANG MO KIO AVE 6'), normaliseStreet('Ang Mo Kio Avenue 6'));
  assert.equal(normaliseStreet('BT BATOK ST 21'), normaliseStreet('Bukit Batok Street 21'));
  assert.equal(normaliseStreet("C'WEALTH CRES"), normaliseStreet('Commonwealth Crescent'));
});

check('a block on HDB\'s list has a void deck, unless it has shops', () => {
  assert.equal(isVoidDeckBlock({ building: 'residential', 'addr:housenumber': '728', 'addr:street': 'Ang Mo Kio Avenue 6' }, list), true);
  assert.equal(isVoidDeckBlock({ building: 'residential', residential: 'HDB', 'addr:housenumber': '200', 'addr:street': 'Bukit Batok Street 21' }, list), false);
});

check('a condo is never crossed, and OpenStreetMap saying HDB is enough without an address', () => {
  assert.equal(isVoidDeckBlock({ building: 'apartments', residential: 'condominium', 'addr:housenumber': '9', 'addr:street': 'Nowhere Road' }, list), false);
  assert.equal(isVoidDeckBlock({ building: 'apartments' }, list), false);
  assert.equal(isVoidDeckBlock({ building: 'residential', residential: 'hdb' }, list), true);
  assert.equal(isVoidDeckBlock({ building: 'residential', residential: 'hdb', 'building:levels': '2' }, list), false);
});

check('links keep to the ground', () => {
  assert.equal(isGroundWay({ highway: 'footway' }), true);
  assert.equal(isGroundWay({ highway: 'footway', tunnel: 'building_passage' }), true);
  for (const tags of [{ highway: 'footway', bridge: 'yes' }, { highway: 'steps' }, { highway: 'footway', layer: '1' }, { highway: 'footway', tunnel: 'yes' }, { highway: 'footway', level: '2' }, { route: 'ferry' }]) {
    assert.equal(isGroundWay(tags), false, JSON.stringify(tags));
  }
  assert.equal(isClosedRoad({ highway: 'motorway' }), true);
  assert.equal(isClosedRoad({ highway: 'motorway', bridge: 'yes' }), false);
  assert.equal(isObstacle({ barrier: 'fence' }), true);
  assert.equal(isObstacle({ barrier: 'kerb' }), false);
});

/* ---- the walking profile ---- */

check('a mall corridor is walkable, and closed to everything else', () => {
  const c = classify({ highway: 'corridor', access: 'customers' });
  assert.equal(c.fwd & 4, 4);
  assert.equal(c.fwd & 3, 0);
});

check('under cover is marked for walking, and only on walking ways', () => {
  assert.equal(classify({ highway: 'footway', covered: 'yes' }).fwd & 8, 8);
  assert.equal(classify({ highway: 'footway', tunnel: 'building_passage' }).fwd & 8, 8);
  assert.equal(classify({ highway: 'footway', covered: 'no' }).fwd & 8, 0);
  assert.equal(classify({ highway: 'footway' }).fwd & 8, 0);
  assert.equal(classify({ highway: 'service', covered: 'yes' }).fwd & 8, 0);
  assert.equal(classify({ highway: 'footway', covered: 'yes', foot: 'no', bicycle: 'no' }), null);
});

/* ---- the links, on made-up blocks ---- */

// A slab 60 m long and 15 m deep, lying east to west.
const slab = (x, y, length = 60, depth = 15) => [[x, y], [x + length, y], [x + length, y + depth], [x, y + depth], [x, y]];
// Paths along both long sides.
const paths = (x, y, length = 60, depth = 15) => [
  { way: 0, points: [[x - 10, y - 10], [x + length + 10, y - 10]] },
  { way: 1, points: [[x - 10, y + depth + 10], [x + length + 10, y + depth + 10]] },
];
const links = (input) => findLinks({ blocks: [], roofs: [], buildings: [], obstacles: [], ways: [], ...input });

check('the best rectangle lies along a block, however it turns', () => {
  const box = fitRectangle(slab(0, 0));
  assert.ok(Math.abs(box.halfLength - 30) < 0.01);
  assert.ok(Math.abs(box.halfWidth - 7.5) < 0.01);
  const turned = slab(0, 0).map(([x, y]) => [x * Math.cos(0.5) - y * Math.sin(0.5), x * Math.sin(0.5) + y * Math.cos(0.5)]);
  const box2 = fitRectangle(turned);
  assert.ok(Math.abs(box2.halfLength - 30) < 0.01);
});

check('a block between two paths gets crossings joining them', () => {
  const ring = slab(0, 0);
  const found = links({ blocks: [{ ring, name: 'Blk 1 void deck' }], buildings: [ring], ways: paths(0, 0) });
  assert.equal(found.length, 2, 'one every 40 m or so');
  for (const l of found) {
    assert.equal(l.name, 'Blk 1 void deck');
    assert.equal(l.sheltered, false);
    assert.deepEqual([l.from.way, l.to.way].sort(), [0, 1]);
    assert.ok(Math.abs(l.from.at[1] - l.to.at[1]) > 30);
  }
});

check('no way on one side, no crossing', () => {
  const ring = slab(0, 0);
  assert.equal(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], ways: [paths(0, 0)[0]] }).length, 0);
});

check('a fence in the way stops a crossing', () => {
  const ring = slab(0, 0);
  const fence = [[-20, 20], [80, 20]];
  assert.equal(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], obstacles: [fence], ways: paths(0, 0) }).length, 0);
});

check('another building in the way stops a crossing', () => {
  const ring = slab(0, 0);
  const shed = slab(-30, 16, 130, 6);
  assert.equal(links({ blocks: [{ ring, name: 'x' }], buildings: [ring, shed], ways: paths(0, 0, 60, 30) }).length, 0);
});

check('a crossing carries on through the next void deck block in a row', () => {
  const a = slab(0, 0);
  const b = slab(0, 20);
  const found = links({ blocks: [{ ring: a, name: 'A' }, { ring: b, name: 'B' }], buildings: [a, b], ways: [{ way: 0, points: [[-10, -10], [70, -10]] }, { way: 1, points: [[-10, 45], [70, 45]] }] });
  assert.ok(found.length >= 2);
  assert.ok(found.every((l) => l.from.way !== l.to.way));
});

check('a block too deep to be a slab is left alone', () => {
  const ring = slab(0, 0, 60, 60);
  assert.equal(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], ways: paths(0, 0, 60, 60) }).length, 0);
});

check('a way going right through means no link, but one clipping a corner does not', () => {
  const ring = slab(0, 0);
  const through = { way: 2, points: [[30, -10], [30, 25]] };
  assert.equal(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], ways: [...paths(0, 0), through] }).length, 0);
  const clip = { way: 2, points: [[-3, 3], [3, -3]] };
  assert.ok(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], ways: [...paths(0, 0), clip] }).length > 0);
});

check('a covered walkway drawn only as a roof gets a way along it, under cover', () => {
  const ring = slab(0, 0, 40, 3);
  const found = links({ roofs: [{ ring }], buildings: [ring], ways: [{ way: 0, points: [[-5, -20], [-5, 20]] }, { way: 1, points: [[45, -20], [45, 20]] }] });
  assert.equal(found.length, 1);
  assert.equal(found[0].sheltered, true);
  assert.equal(found[0].name, 'Covered walkway');
});

check('a wide roof is a car park, not a walkway', () => {
  const ring = slab(0, 0, 40, 20);
  assert.equal(links({ roofs: [{ ring }], buildings: [ring], ways: [{ way: 0, points: [[-5, -20], [-5, 40]] }, { way: 1, points: [[45, -20], [45, 40]] }] }).length, 0);
});

check('a very long way doesn\'t flood the index', () => {
  const ring = slab(0, 0);
  const ferry = { way: 2, points: [[-500000, -500000], [500000, 500000]] };
  assert.ok(links({ blocks: [{ ring, name: 'x' }], buildings: [ring], ways: [...paths(0, 0), ferry] }).length >= 0);
});

/* ---- on a real routing file ---- */

const file = process.argv[2];
if (file) {
  const fd = openSync(file, 'r');
  const graph = await RouteGraph.open(async (offset, length) => {
    const b = Buffer.alloc(length);
    readSync(fd, b, 0, length, offset);
    return new Uint8Array(b);
  });
  // Across an Ang Mo Kio estate, between blocks.
  const walk = await findRoute(graph, { lat: 1.3700, lon: 103.8485 }, { lat: 1.3725, lon: 103.8510 }, 'foot');
  const stops = [
    [{ lat: 1.3695, lon: 103.8450 }, { lat: 1.3725, lon: 103.8475 }],
    [{ lat: 1.3665, lon: 103.8460 }, { lat: 1.3720, lon: 103.8440 }],
    [{ lat: 1.3665, lon: 103.8500 }, { lat: 1.3690, lon: 103.8440 }],
    [{ lat: 1.3650, lon: 103.8440 }, { lat: 1.3710, lon: 103.8455 }],
    [{ lat: 1.3400, lon: 103.8480 }, { lat: 1.3370, lon: 103.8520 }],
  ];
  let through = 0;
  for (const [from, to] of stops) {
    const r = await findRoute(graph, from, to, 'foot');
    assert.ok(r, 'a route');
    if (r.steps.some((s) => /void deck/i.test(s.name))) through++;
  }
  check('real walks go through void decks, and say which block', () => {
    assert.ok(walk, 'a route');
    assert.ok(through >= 1, `${through} of ${stops.length} walks used one`);
  });
  const drive = await findRoute(graph, stops[0][0], stops[0][1], 'car');
  const ride = await findRoute(graph, stops[0][0], stops[0][1], 'bike');
  check('only on foot', () => {
    for (const r of [drive, ride]) {
      assert.ok(r, 'a route');
      assert.ok(!r.steps.some((s) => /void deck|covered walkway/i.test(s.name)));
    }
  });
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nAll passed');

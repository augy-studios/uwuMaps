// The live feed decoder and the sync merge, against messages built by hand so the expected answer is
// known: node tests/unit/decode-check.mjs

import assert from 'node:assert/strict';
import { decodeFeed } from '../../main-site/api/my-live.js';
import { merge } from '../../main-site/api/sync.js';

const varint = (v) => {
  const out = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
};
const tag = (num, wire) => varint(num * 8 + wire);
const message = (num, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([tag(num, 2), varint(body.length), body]);
};
const text = (num, s) => message(num, Buffer.from(s, 'utf8'));
const number = (num, v) => Buffer.concat([tag(num, 0), varint(v)]);
const float = (num, v) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(v, 0);
  return Buffer.concat([tag(num, 5), b]);
};

const vehicle = (id, route, lat, lon, bearing, speed, at) => message(2,
  text(1, `entity-${id}`),
  message(4,
    message(1, text(1, 'trip-1'), text(5, route)),
    message(2, float(1, lat), float(2, lon), float(3, bearing), float(5, speed)),
    number(5, at),
    message(8, text(1, id), text(2, `label-${id}`)),
  ));

const feed = Buffer.concat([
  message(1, text(1, '2.0'), number(3, 1762400000)),
  vehicle('A', 'U80', 3.1395, 101.6869, 90, 12.5, 1762399990),
  vehicle('B', '', 2.5, 102.25, 0, 0, 1762399900),
  // No position: skipped, not a crash.
  message(2, text(1, 'entity-none'), message(4, number(5, 1))),
  // A position at nothing, which some feeds send for a vehicle with no fix.
  vehicle('C', 'X', 0, 0, 0, 0, 1),
]);

const decoded = decodeFeed(feed);
assert.equal(decoded.at, 1762400000);
assert.equal(decoded.vehicles.length, 2);
assert.equal(decoded.vehicles[0].id, 'label-A');
assert.equal(decoded.vehicles[0].route, 'U80');
assert.equal(decoded.vehicles[0].lat, 3.1395);
assert.equal(decoded.vehicles[0].lon, 101.6869);
assert.equal(decoded.vehicles[0].bearing, 90);
assert.equal(decoded.vehicles[0].speed, undefined);
assert.equal(decoded.vehicles[0].at, 1762399990);
assert.deepEqual(decodeFeed(Buffer.alloc(0)), { at: 0, vehicles: [] });
assert.throws(() => decodeFeed(Buffer.from([0x0a, 0x7f, 0x01])), /past the end/);

// The real feeds, as they are right now, whatever they hold.
for (const path of ['ktmb', 'prasarana?category=rapid-bus-kl', 'mybas-johor']) {
  const res = await fetch(`https://api.data.gov.my/gtfs-realtime/vehicle-position/${path}`);
  const live = decodeFeed(Buffer.from(await res.arrayBuffer()));
  console.log(`${path}: ${live.vehicles.length} vehicles`, live.vehicles[0] || '');
  for (const v of live.vehicles) {
    assert.ok(v.lat > 0 && v.lat < 8, `${path} latitude ${v.lat}`);
    assert.ok(v.lon > 99 && v.lon < 120, `${path} longitude ${v.lon}`);
  }
}

const now = 1_800_000_000_000;
const day = 24 * 60 * 60 * 1000;
const p = (name, t, extra = {}) => ({ name, lat: 1, lon: 2, t, ...extra });
// The newer change wins, either way round.
assert.equal(merge({ a: p('old', now - 10) }, { a: p('new', now - 5) }, now).a.name, 'new');
assert.equal(merge({ a: p('new', now - 5) }, { a: p('old', now - 10) }, now).a.name, 'new');
// A deletion beats an older copy, and stays deleted.
assert.equal(merge({ a: p('x', now - 5, { deleted: true }) }, { a: p('x', now - 10) }, now).a.deleted, true);
// A clock far ahead can't win.
assert.equal(merge({ a: p('real', now - 5) }, { a: p('future', now + 2 * day) }, now).a.name, 'real');
// Junk is dropped, and a very old deletion is forgotten.
assert.deepEqual(merge({}, { b: { name: 'no coords', t: now } }, now), {});
assert.deepEqual(merge({ a: p('x', now - 100 * day, { deleted: true }) }, {}, now), {});
console.log('Decoder and merge ok');

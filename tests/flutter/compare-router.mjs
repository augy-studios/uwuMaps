#!/usr/bin/env node
// Checks the Android app's Dart ports against the website's JavaScript, on the same real pack: the same
// journeys must come out the same distance, time and steps, and the same tiles the same size. Run
// `flutter test test/route_core_test.dart` in android/ first, which writes the Dart side's answers.
//
//   node tests/flutter/compare-router.mjs

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RouteGraph, findRoute } from '../../main-site/js/route-core.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dart = JSON.parse(readFileSync(here('../../android/build/dart-routes.json'), 'utf8'));
const file = readFileSync(here('../.fixture/singapore.route'));
const graph = await RouteGraph.open(async (offset, length) => new Uint8Array(file.buffer, file.byteOffset + offset, length).slice());

const ENDS = {
  'orchard-marina': [{ lat: 1.3048, lon: 103.8318 }, { lat: 1.2835, lon: 103.8565 }],
  'tampines-jurong': [{ lat: 1.3521, lon: 103.9448 }, { lat: 1.3333, lon: 103.7423 }],
  'short-walk': [{ lat: 1.2905, lon: 103.8520 }, { lat: 1.2925, lon: 103.8540 }],
  'estate-walk': [{ lat: 1.3665, lon: 103.8500 }, { lat: 1.3690, lon: 103.8440 }],
};

let failed = 0;
for (const [key, want] of Object.entries(dart)) {
  const [name, mode] = key.split('/');
  const [from, to] = ENDS[name];
  const js = await findRoute(graph, from, to, mode);
  const steps = js.steps.map((s) => s.text);
  const same = js.distance === want.distance && js.duration === want.duration && js.coords.length === want.points && JSON.stringify(steps) === JSON.stringify(want.steps);
  console.log(`${same ? 'same' : 'DIFFERENT'}  ${key}: JS ${js.distance} m ${js.duration} s, ${js.coords.length} points, ${steps.length} steps; Dart ${want.distance} m ${want.duration} s, ${want.points} points, ${want.steps.length} steps, ${want.ms} ms`);
  if (!same) {
    failed++;
    steps.forEach((s, i) => {
      if (s !== want.steps[i]) console.log(`    step ${i}: JS "${s}" / Dart "${want.steps[i]}"`);
    });
  }
}

// The tiles, through the pmtiles library the website uses.
const require = createRequire(here('../../tools/package.json'));
const { PMTiles } = require('pmtiles');
const tiles = JSON.parse(readFileSync(here('../../android/build/dart-tiles.json'), 'utf8'));
for (const archive of ['base', 'buildings']) {
  const bytes = readFileSync(here(`../.fixture/singapore.${archive}`));
  const source = {
    getKey: () => archive,
    getBytes: async (offset, length) => ({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length) }),
  };
  const got = await new PMTiles(source, undefined, undefined).getZxy(14, 12918, 8132);
  const size = (() => {
    const raw = Buffer.from(got.data);
    return raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).length : raw.length;
  })();
  const same = size === tiles[archive];
  console.log(`${same ? 'same' : 'DIFFERENT'}  ${archive} tile 14/12918/8132: JS ${size} bytes, Dart ${tiles[archive]} bytes`);
  if (!same) failed++;
}

if (failed) {
  console.error(`${failed} differ`);
  process.exit(1);
}
console.log('The Dart ports match the website.');

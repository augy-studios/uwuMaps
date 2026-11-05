#!/usr/bin/env node
// Builds a real Singapore pack for the tests, the way the workflow lays one out, into tests/.fixture.
// Its road graph, search and buildings come from the same tools the workflow runs. Its basemap is
// copied from OpenFreeMap rather than built with Planetiler, which keeps this quick and needs no Java:
// under 3,000 tiles, four at a time, with a User-Agent, as OpenFreeMap's terms ask of offline copies.
//
//   node tests/build-fixture.mjs

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PACKS } from '../main-site/js/pack-list.js';
import { PMTilesWriter } from '../tools/packs/lib/pmtiles-writer.mjs';

const ID = 'singapore';
const BUILD = '1000';
const FIXTURE = fileURLToPath(new URL('./.fixture/', import.meta.url));
const RELEASE = `${FIXTURE}release/`;
const TOOLS = fileURLToPath(new URL('../tools/packs/', import.meta.url));
mkdirSync(RELEASE, { recursive: true });

const { bounds, sources } = PACKS.find((p) => p.id === ID);
const pbf = `${FIXTURE}${ID}.osm.pbf`;

if (!existsSync(pbf)) {
  console.log('Fetching the extract');
  const res = await fetch(sources[0], { headers: { 'User-Agent': 'uwuMaps-tests/1.0' } });
  if (!res.ok) throw new Error(`${sources[0]} answered ${res.status}`);
  writeFileSync(pbf, Buffer.from(await res.arrayBuffer()));
}

execFileSync(process.execPath, [`${TOOLS}compile-graph.mjs`, pbf, `--bounds=${bounds.join(',')}`, `--route=${FIXTURE}${ID}.route`, `--search=${FIXTURE}${ID}.search`], { stdio: 'inherit' });
execFileSync(process.execPath, [`${TOOLS}extract-buildings.mjs`, `--bounds=${bounds.join(',')}`, `--out=${FIXTURE}${ID}.buildings`], { stdio: 'inherit' });

/* ---- the basemap, from OpenFreeMap ---- */

const basePath = `${FIXTURE}${ID}.base`;
if (!existsSync(basePath)) {
  const UA = { 'User-Agent': 'uwuMaps-tests/1.0 (+https://maps.uwuapps.org)' };
  const tilejson = await (await fetch('https://tiles.openfreemap.org/planet', { headers: UA })).json();
  const template = tilejson.tiles[0];
  const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const tileY = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
  };
  const jobs = [];
  for (let z = 0; z <= 14; z++) {
    for (let x = tileX(bounds[0], z); x <= tileX(bounds[2], z); x++) {
      for (let y = tileY(bounds[3], z); y <= tileY(bounds[1], z); y++) jobs.push([z, x, y]);
    }
  }
  if (jobs.length > 3000) throw new Error(`${jobs.length} tiles is over OpenFreeMap's limit for offline copies`);
  console.log(`Copying ${jobs.length} basemap tiles`);
  const writer = new PMTilesWriter(basePath);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const [z, x, y] = jobs[next++];
      const res = await fetch(template.replace('{z}', z).replace('{x}', x).replace('{y}', y), { headers: UA });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`Tile ${z}/${x}/${y} answered ${res.status}`);
      await writer.add(z, x, y, gzipSync(Buffer.from(await res.arrayBuffer()), { level: 6 }));
    }
  }));
  await writer.finish({ bounds, metadata: { name: 'uwuMaps test basemap', vector_layers: [] } });
}

/* ---- laid out as the workflow publishes it ---- */

const archives = {};
for (const a of ['base', 'buildings', 'route', 'search']) {
  const src = `${FIXTURE}${ID}.${a}`;
  const name = `${ID}-${BUILD}.${a}.000`;
  copyFileSync(src, `${RELEASE}${name}`);
  const size = statSync(src).size;
  archives[a] = { size, files: [{ name, size }] };
  console.log(`${a}: ${(size / 1e6).toFixed(1)} MB`);
}
writeFileSync(`${RELEASE}${ID}.json`, JSON.stringify({ id: ID, build: BUILD, built: new Date().toISOString(), archives }));
console.log('Fixture ready');

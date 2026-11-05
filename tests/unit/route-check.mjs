// Real routes over a compiled routing file: node tests/unit/route-check.mjs <file.route>
// Prints each route, and fails when one is missing or implausible against the straight line.
import { openSync, readSync } from 'node:fs';
import { RouteGraph, findRoute, metres } from '../../main-site/js/route-core.js';

const fd = openSync(process.argv[2], 'r');
const read = async (offset, length) => {
  const b = Buffer.alloc(length);
  readSync(fd, b, 0, length, offset);
  return new Uint8Array(b);
};
const graph = await RouteGraph.open(read);

const P = {
  orchard: { lat: 1.3048, lon: 103.8318 }, marina: { lat: 1.2834, lon: 103.8607 },
  changi: { lat: 1.3644, lon: 103.9915 }, tuas: { lat: 1.3200, lon: 103.6400 },
  bishan: { lat: 1.3510, lon: 103.8480 }, sentosa: { lat: 1.2494, lon: 103.8303 },
  woodlands: { lat: 1.4360, lon: 103.7860 },
};
const CASES = [
  ['orchard', 'marina', 'foot'], ['orchard', 'marina', 'bike'], ['orchard', 'marina', 'car'],
  ['tuas', 'changi', 'car'], ['woodlands', 'marina', 'car'], ['bishan', 'orchard', 'bike'], ['bishan', 'orchard', 'foot'],
  ['marina', 'sentosa', 'car'],
];
let bad = 0;
for (const [a, b, mode] of CASES) {
  const t = Date.now();
  const r = await findRoute(graph, P[a], P[b], mode);
  const ms = Date.now() - t;
  if (!r) { console.log(`FAIL ${a} to ${b} by ${mode}: no route (${ms} ms)`); bad++; continue; }
  const line = metres(P[a].lat, P[a].lon, P[b].lat, P[b].lon);
  const ratio = r.distance / line;
  const kmh = (r.distance / r.duration) * 3.6;
  const ok = ratio >= 0.95 && ratio < 2.6;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${a} to ${b} by ${mode}: ${(r.distance / 1000).toFixed(1)} km (x${ratio.toFixed(2)} straight), ${Math.round(r.duration / 60)} min, ${kmh.toFixed(0)} km/h, ${r.steps.length} steps, ${r.coords.length} pts, ${ms} ms`);
  if (a === 'orchard') for (const s of r.steps.slice(0, 12)) console.log(`       ${s.text} (${s.distance} m)`);
  // No step that can't be followed, and the same street isn't announced twice running.
  r.steps.forEach((s, i) => {
    if ((s.type === 'turn' || s.type === 'continue') && s.distance < 15) { console.log(`FAIL too short: ${s.text} (${s.distance} m)`); bad++; }
    if (s.type === 'continue' && s.name && r.steps[i - 1]?.name === s.name) { console.log(`FAIL repeated: ${s.text}`); bad++; }
  });
}
process.exit(bad ? 1 : 0);

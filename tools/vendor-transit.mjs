#!/usr/bin/env node
// Refreshes the public transport snapshots in main-site/data/, which are shipped with the app so its
// transport layers work with no connection. Run by hand now and then: stations and stops rarely move.
//
//   node tools/vendor-transit.mjs [path to an sgbus-timings clone]
//
// Singapore: stations, exits, lines and tracks (cheeaun/sgraildata, as SG Bus Timings vendors them),
// LTA's bus stops and the MRT door tables, from SG Bus Timings' public API.
// Malaysia: stations, lines and bus stops, from data.gov.my's GTFS static feeds.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const OUT = new URL('../main-site/data/', import.meta.url);
const SGBUS = process.argv[2] || new URL('../../sgbus-timings/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const round = (v) => Math.round(v * 1e5) / 1e5;

mkdirSync(OUT, { recursive: true });
const save = (name, value) => {
  const text = JSON.stringify(value);
  writeFileSync(new URL(name, OUT), text);
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KB`);
};

/* ---- Singapore ---- */

const rail = JSON.parse(readFileSync(`${SGBUS}/main-site/data/rail.json`, 'utf8'));
const tracks = JSON.parse(readFileSync(`${SGBUS}/main-site/data/rail-tracks.json`, 'utf8'));
const stations = JSON.parse(readFileSync(`${SGBUS}/main-site/data/rail-stations.json`, 'utf8'));
save('sg-rail.json', {
  source: stations.source,
  lines: rail.lines.map((l) => ({ code: l.code, name: l.name, color: l.color })),
  tracks: tracks.lines,
  stations: stations.stations,
});

const stops = await (await fetch('https://sgbus.uwuapps.org/api/bus-stops')).json();
save('sg-bus-stops.json', stops.map((s) => ({ c: s.c, n: s.n, r: s.r, la: round(s.la), lo: round(s.lo) })));

const doors = await (await fetch('https://sgbus.uwuapps.org/api/mrt-doors')).json();
save('sg-mrt-doors.json', doors);

/* ---- Malaysia: reading a GTFS zip ---- */

function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip');
  const out = {};
  let pos = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const size = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen).split('/').pop();
    if (wanted.includes(name) && !buf.toString('utf8', pos + 46, pos + 46 + nameLen).includes('__MACOSX')) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function csv(text = '') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

async function gtfs(path, wanted) {
  const url = `https://api.data.gov.my/gtfs-static/${path}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'uwuMaps/1.0 (+https://maps.uwuapps.org)' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const files = unzip(Buffer.from(await res.arrayBuffer()), wanted);
  return Object.fromEntries(wanted.map((n) => [n.replace('.txt', ''), csv(files[n])]));
}

const point = (s) => [round(Number(s.stop_lat)), round(Number(s.stop_lon))];
const validStop = (s) => Number.isFinite(Number(s.stop_lat)) && Number(s.stop_lat) !== 0;

// The longest stop sequence each route has: its stations in order, drawn as a line where the feed
// gives no shape, and its stops when reading which stations a line serves.
function routeStops(trips, stopTimes) {
  const tripRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));
  const byTrip = new Map();
  for (const st of stopTimes) {
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push(st);
  }
  const best = new Map();
  for (const [trip, list] of byTrip) {
    const route = tripRoute.get(trip);
    if (!route) continue;
    if (!best.has(route) || best.get(route).length < list.length) best.set(route, list);
  }
  const out = new Map();
  for (const [route, list] of best) {
    out.set(route, list.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence)).map((s) => s.stop_id));
  }
  return out;
}

/* ---- Malaysia: trains ---- */

const lines = [];
const myStations = new Map();

function addRail(feed, agency, defaultColor, routes, stopRows, trips, stopTimes, shapes) {
  const stopById = new Map(stopRows.filter(validStop).map((s) => [s.stop_id, s]));
  const seq = routeStops(trips, stopTimes);
  const shapePoints = new Map();
  for (const p of shapes || []) {
    if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
    shapePoints.get(p.shape_id).push(p);
  }
  for (const route of routes) {
    const name = route.route_long_name || route.route_short_name || route.route_id;
    const color = route.route_color ? `#${route.route_color}` : defaultColor;
    const ids = seq.get(route.route_id) || [];
    // Only a real shape. KTMB's feed has none, and a straight line from station to station would cut
    // across a city where no track runs. Its stations still show, on the base map's own railway.
    const trip = trips.find((t) => t.route_id === route.route_id && t.shape_id && shapePoints.has(t.shape_id));
    if (trip) {
      const path = shapePoints.get(trip.shape_id)
        .sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence))
        .map((p) => [round(Number(p.shape_pt_lat)), round(Number(p.shape_pt_lon))]);
      if (path.length >= 2) lines.push({ name, agency, color, path });
    }
    for (const id of ids) {
      const s = stopById.get(id);
      if (!s) continue;
      const key = `${feed}:${s.stop_name}`;
      if (!myStations.has(key)) myStations.set(key, { name: s.stop_name, agency, feed, lat: point(s)[0], lng: point(s)[1], lines: [], color });
      const st = myStations.get(key);
      if (!st.lines.includes(name)) st.lines.push(name);
    }
  }
}

{
  const g = await gtfs('prasarana?category=rapid-rail-kl', ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt']);
  addRail('rapid-rail-kl', 'Rapid KL', '#2f6fbb', g.routes, g.stops, g.trips, g.stop_times, g.shapes);
  console.log(`Rapid KL: ${g.routes.length} routes, ${g.stops.length} stops`);
}
{
  const g = await gtfs('ktmb', ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt']);
  addRail('ktmb', 'KTMB', '#1b5e9f', g.routes, g.stops, g.trips, g.stop_times, g.shapes);
  console.log(`KTMB: ${g.routes.length} routes, ${g.stops.length} stops`);
}

/* ---- Malaysia: bus stops ---- */

const busStops = [];
for (const [path, agency] of [
  ['prasarana?category=rapid-bus-kl', 'Rapid KL'],
  ['prasarana?category=rapid-bus-penang', 'Rapid Penang'],
  ['prasarana?category=rapid-bus-mrtfeeder', 'MRT feeder'],
  ['mybas-johor', 'myBAS Johor'],
]) {
  const g = await gtfs(path, ['stops.txt']);
  let n = 0;
  for (const s of g.stops) {
    if (!validStop(s)) continue;
    const [la, lo] = point(s);
    busStops.push({ n: s.stop_name, a: agency, la, lo });
    n++;
  }
  console.log(`${agency}: ${n} stops`);
}

save('my-transit.json', {
  source: 'data.gov.my GTFS static (Prasarana, KTMB, myBAS Johor)',
  lines,
  stations: [...myStations.values()],
  busStops,
});

// Where Malaysia's trains and buses are right now, from data.gov.my's GTFS-realtime feeds:
//
//   GET /api/my-live?feed=ktmb   { feed, at, vehicles: [{ id, route, lat, lon, bearing, at }] }
//
// The feeds are serialised protobuf rather than JSON, and a page can't read them directly anyway, so
// this decodes the small part of the format that's needed. The answer is kept at the edge briefly, so
// however many people are watching, the feed is only asked a few times a minute.
//
// Only the feeds named below. Rapid KL's trains have no realtime feed, so live trains means KTMB.

const FEEDS = {
  ktmb: 'ktmb',
  'rapid-bus-kl': 'prasarana?category=rapid-bus-kl',
  'rapid-bus-penang': 'prasarana?category=rapid-bus-penang',
  'rapid-bus-mrtfeeder': 'prasarana?category=rapid-bus-mrtfeeder',
  'mybas-johor': 'mybas-johor',
};
const TIMEOUT_MS = 9000;
const USER_AGENT = 'uwuMaps/1.0 (+https://maps.uwuapps.org)';

/* ---- the protobuf wire format ---- */

function fields(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (pos >= end) throw new Error('A number ran past the end of the message');
      const b = buf[pos++];
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
  };
  while (pos < end) {
    const tag = varint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) out.push({ num, value: varint() });
    else if (wire === 1) {
      out.push({ num, start: pos, end: pos + 8 });
      pos += 8;
    } else if (wire === 2) {
      const len = varint();
      if (pos + len > end) throw new Error('A field ran past the end of the message');
      out.push({ num, start: pos, end: pos + len });
      pos += len;
    } else if (wire === 5) {
      out.push({ num, start: pos, end: pos + 4 });
      pos += 4;
    } else throw new Error(`Unknown wire type ${wire}`);
  }
  return out;
}

const first = (list, num) => list.find((f) => f.num === num);
const str = (buf, f) => (f ? buf.toString('utf8', f.start, f.end) : '');
const float = (buf, f) => (f && f.end - f.start === 4 ? buf.readFloatLE(f.start) : null);

// FeedMessage { header = 1, entity = 2 }, FeedEntity { id = 1, vehicle = 4 }
// VehiclePosition { trip = 1, position = 2, timestamp = 5, vehicle = 8 }
// TripDescriptor { trip_id = 1, route_id = 5 }, VehicleDescriptor { id = 1, label = 2 }
// Position { latitude = 1, longitude = 2, bearing = 3 }. Its speed is left out: KTMB's values run far
// past what a train does, so whatever unit they're in, they can't be shown as a speed.
export function decodeFeed(buf) {
  const top = fields(buf);
  const header = first(top, 1);
  const headerFields = header ? fields(buf, header.start, header.end) : [];
  const vehicles = [];
  for (const e of top) {
    if (e.num !== 2) continue;
    const entity = fields(buf, e.start, e.end);
    const v = first(entity, 4);
    if (!v) continue;
    const vehicle = fields(buf, v.start, v.end);
    const p = first(vehicle, 2);
    if (!p) continue;
    const position = fields(buf, p.start, p.end);
    const lat = float(buf, first(position, 1));
    const lon = float(buf, first(position, 2));
    if (lat == null || lon == null || (lat === 0 && lon === 0)) continue;
    const trip = first(vehicle, 1);
    const tripFields = trip ? fields(buf, trip.start, trip.end) : [];
    const desc = first(vehicle, 8);
    const descFields = desc ? fields(buf, desc.start, desc.end) : [];
    const bearing = float(buf, first(position, 3));
    vehicles.push({
      id: str(buf, first(descFields, 2)) || str(buf, first(descFields, 1)) || str(buf, first(entity, 1)),
      route: str(buf, first(tripFields, 5)),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      ...(bearing != null && { bearing: Math.round(bearing) }),
      at: first(vehicle, 5)?.value || 0,
    });
  }
  return { at: first(headerFields, 3)?.value || 0, vehicles };
}

export default async function handler(req, res) {
  const feed = String(req.query.feed || '');
  if (!Object.hasOwn(FEEDS, feed)) return res.status(404).json({ error: 'No such feed' });
  try {
    const upstream = await fetch(`https://api.data.gov.my/gtfs-realtime/vehicle-position/${FEEDS[feed]}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error(`The feed answered ${upstream.status}`);
    const decoded = decodeFeed(Buffer.from(await upstream.arrayBuffer()));
    res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=20, stale-while-revalidate=40');
    return res.status(200).json({ feed, ...decoded });
  } catch (err) {
    console.warn(`my-live ${feed}:`, err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The live feed is not answering right now' });
  }
}

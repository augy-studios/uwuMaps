// A share link's map picture, for chat apps' previews and the share sheet: OpenStreetMap's raster
// tiles put together, with the route and pins drawn over them. A place, route or list never changes,
// so its picture is kept for a week. An ETA's moves, so it's asked for with ?v= and kept only briefly.

import sharp from 'sharp';
import { supabaseConfigured } from './_lib/supabase.js';
import { getLink, isLinkId } from './_lib/share-links.js';

const WIDTH = 1024;
const HEIGHT = 512;
const TILE = 256;
const USER_AGENT = 'uwuMaps/1.0 (+https://maps.uwuapps.org)';

const worldX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const worldY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

function fitZoom(points) {
  if (points.length < 2) return 15;
  const xs = points.map((p) => worldX(p[1], 0));
  const ys = points.map((p) => worldY(p[0], 0));
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const zx = spanX ? Math.log2((WIDTH * 0.8) / spanX) : 17;
  const zy = spanY ? Math.log2((HEIGHT * 0.75) / spanY) : 17;
  return Math.max(2, Math.min(17, Math.floor(Math.min(zx, zy))));
}

// What a link draws: its pins, and its line.
function contents({ kind, data }) {
  const pins = [];
  let line = null;
  const pin = (p, colour) => p && p !== 'here' && pins.push({ lat: p.lat, lng: p.lng, colour });
  if (kind === 'place') pin(data, '#e8486f');
  else if (kind === 'directions') {
    pin(data.from, '#2e9e5b');
    pin(data.to, '#e8486f');
    line = data.path;
  } else if (kind === 'eta') {
    pin(data.to, '#e8486f');
    if (data.me && !data.ended && !data.stopped) pin(data.me, '#3b8bff');
    line = data.path;
  } else if (kind === 'list') {
    for (const p of data.places) pin(p, '#e8486f');
  }
  return { pins, line };
}

async function tile(z, x, y) {
  const wrapped = ((x % 2 ** z) + 2 ** z) % 2 ** z;
  if (y < 0 || y >= 2 ** z) return null;
  const res = await fetch(`https://tile.openstreetmap.org/${z}/${wrapped}/${y}.png`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function renderMap(link) {
  const { pins, line } = contents(link);
  const all = [...pins.map((p) => [p.lat, p.lng]), ...(line || [])];
  if (!all.length) throw new Error('Nothing to draw');
  const z = fitZoom(all);
  const xs = all.map((p) => worldX(p[1], z));
  const ys = all.map((p) => worldY(p[0], z));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const left = cx - WIDTH / 2;
  const top = cy - HEIGHT / 2;

  const jobs = [];
  for (let tx = Math.floor(left / TILE); tx * TILE < left + WIDTH; tx++) {
    for (let ty = Math.floor(top / TILE); ty * TILE < top + HEIGHT; ty++) {
      const at = { left: Math.round(tx * TILE - left), top: Math.round(ty * TILE - top) };
      jobs.push(tile(z, tx, ty).then((input) => input && { input, ...at }));
    }
  }
  const layers = (await Promise.all(jobs)).filter(Boolean);
  // Tiles reaching past the picture's edge are cut to fit, since compositing refuses them otherwise.
  const pieces = await Promise.all(layers.map(async ({ input, left: l, top: t }) => {
    const cropLeft = Math.max(0, -l);
    const cropTop = Math.max(0, -t);
    const width = Math.min(TILE - cropLeft, WIDTH - Math.max(0, l));
    const height = Math.min(TILE - cropTop, HEIGHT - Math.max(0, t));
    if (width <= 0 || height <= 0) return null;
    return {
      input: await sharp(input).extract({ left: cropLeft, top: cropTop, width, height }).toBuffer(),
      left: Math.max(0, l),
      top: Math.max(0, t),
    };
  }));

  const px = (p) => `${(worldX(p[1], z) - left).toFixed(1)},${(worldY(p[0], z) - top).toFixed(1)}`;
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    ${line?.length >= 2 ? `<polyline points="${line.map(px).join(' ')}" fill="none" stroke="#0b3d91" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line.map(px).join(' ')}" fill="none" stroke="#3b8bff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
    ${pins.map((p) => {
      const [x, y] = px([p.lat, p.lng]).split(',');
      return `<circle cx="${x}" cy="${y}" r="11" fill="${p.colour}" stroke="#ffffff" stroke-width="4"/>`;
    }).join('')}
    <rect x="${WIDTH - 196}" y="${HEIGHT - 24}" width="196" height="24" fill="#ffffff" fill-opacity="0.8"/>
    <text x="${WIDTH - 8}" y="${HEIGHT - 7}" font-family="sans-serif" font-size="14" text-anchor="end" fill="#333333">&#169; OpenStreetMap contributors</text>
  </svg>`;

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#e8ece9' } })
    .composite([...pieces.filter(Boolean), { input: Buffer.from(overlay), left: 0, top: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer();
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!supabaseConfigured()) return res.status(503).end();
  if (!isLinkId(id)) return res.status(400).end();
  try {
    const link = await getLink(id);
    if (!link) return res.status(404).end();
    const png = await renderMap(link);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', link.kind === 'eta' ? 'public, max-age=30, s-maxage=30' : 'public, max-age=86400, s-maxage=604800');
    return res.status(200).send(png);
  } catch (err) {
    console.error(err);
    return res.status(502).end();
  }
}

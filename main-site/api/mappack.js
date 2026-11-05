// The offline packs, built by .github/workflows/offline-packs.yml and kept on the repository's
// `offline-packs` release. Each is <id>.json, naming its build, and its four archives split into 1 GiB
// files, <id>-<build>.<archive>.000, .001 and so on.
//
//   GET /api/mappack                                        { packs: { id: { build, size, built, archives } } }
//   GET /api/mappack?id=japan&archive=route&part=N&v=build  bytes N*part to (N+1)*part-1 of that archive
//
// The page can't fetch the release itself: GitHub's downloads send no CORS headers. So it comes through
// here in pieces of 4 MiB, under Vercel's 4.5 MB response limit, which also lets a stopped download
// carry on where it was. A piece's address names its build, and a build's files never change, so the
// CDN keeps a piece for good and a download never mixes two builds. The workflow keeps the build before
// the newest, so a download under way can finish. Once its build is gone, its pieces answer 409, and
// the page starts that pack again.
//
// Not an open proxy: only the packs and archives js/pack-list.js names, on one release.

import { ARCHIVES, FILE_SIZE, PACKS, PART_SIZE } from '../js/pack-list.js';

const RELEASE = process.env.MAP_RELEASE_URL || 'https://github.com/augy-studios/uwuMaps/releases/download/offline-packs';
const USER_AGENT = 'uwuMaps/1.0 (+https://maps.uwuapps.org)';
const IDS = new Set(PACKS.map((p) => p.id));

async function manifest(id) {
  const res = await fetch(`${RELEASE}/${id}.json`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null; // Not built yet.
  if (!res.ok) throw new Error(`${id}.json answered ${res.status}`);
  const m = await res.json();
  if (!/^\d+$/.test(String(m.build)) || !m.archives) throw new Error(`${id}.json is not a manifest`);
  return m;
}

async function catalogue(res) {
  const results = await Promise.allSettled(PACKS.map((p) => manifest(p.id)));
  const packs = {};
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return;
    const m = r.value;
    const archives = Object.fromEntries(ARCHIVES.filter((a) => m.archives[a]).map((a) => [a, { size: m.archives[a].size }]));
    if (Object.keys(archives).length !== ARCHIVES.length) return;
    packs[PACKS[i].id] = {
      build: String(m.build),
      built: m.built || null,
      size: ARCHIVES.reduce((n, a) => n + archives[a].size, 0),
      archives,
    };
  });
  // A few minutes, so a rebuild reaches phones the same day.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  return res.status(200).json({ packs, part: PART_SIZE });
}

export default async function handler(req, res) {
  const { id, archive, part: partText, v } = req.query;
  try {
    if (id == null) return await catalogue(res);

    if (!IDS.has(String(id))) return res.status(404).json({ error: 'No such pack' });
    const part = Number(partText);
    if (!ARCHIVES.includes(archive) || !Number.isInteger(part) || part < 0 || part > 16384 || !/^\d{1,20}$/.test(String(v))) {
      return res.status(400).json({ error: 'archive and a whole part number are needed, with v the build' });
    }

    const start = part * PART_SIZE;
    const file = `${id}-${v}.${archive}.${String(Math.floor(start / FILE_SIZE)).padStart(3, '0')}`;
    const from = start % FILE_SIZE;
    const upstream = await fetch(`${RELEASE}/${file}`, {
      headers: { 'User-Agent': USER_AGENT, Range: `bytes=${from}-${from + PART_SIZE - 1}` },
      signal: AbortSignal.timeout(30000),
    });
    if (upstream.status === 416) return res.status(416).json({ error: 'That part is past the end of the file' });
    if (upstream.status === 404) {
      // That build has been taken down: start again.
      res.setHeader('Cache-Control', 'no-store');
      return res.status(409).json({ error: 'The map has been rebuilt since. Start again.' });
    }
    if (upstream.status !== 206 && upstream.status !== 200) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: `The map file answered ${upstream.status}` });
    }
    let body = Buffer.from(await upstream.arrayBuffer());
    // A server that ignores Range sends the lot: cut out the piece.
    if (upstream.status === 200) body = body.subarray(from, from + PART_SIZE);
    if (!body.length) return res.status(416).json({ error: 'That part is past the end of the file' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(body);
  } catch (err) {
    console.warn('mappack failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'The map file is not answering right now' });
  }
}

// Saved places sync: POST { code, places } merges them with what's kept under that code, and answers
// the result, which holds the newest of each place from every device. A place deleted on one device is
// a marker saying so, so it stays deleted rather than coming back from another.
//
// No accounts: having the code is what gets you in, so only its hash is kept.

import { createHash } from 'node:crypto';
import { rest, supabaseConfigured } from './_lib/supabase.js';
import { overLimit } from './_lib/rate.js';

const TABLE = 'uwumaps_sync';
const CODE_RE = /^[BCDFGHJKLMNPQRSTVWXYZ23456789]{12}$/;
const MAX_PLACES = 2000;
const MAX_BYTES = 512 * 1024;
const SYNCS_PER_MINUTE = 30;
const KEEP_DAYS = 365;
// Long enough for every device to hear about a deletion. After that it can go.
const TOMBSTONE_DAYS = 90;

const coord = (v, max) => Number.isFinite(v) && Math.abs(v) <= max;

function cleanPlace(id, p) {
  if (typeof id !== 'string' || id.length > 40 || !p || typeof p !== 'object') return null;
  if (!coord(p.lat, 90) || !coord(p.lon, 180) || !Number.isFinite(p.t)) return null;
  const base = { id, lat: p.lat, lon: p.lon, t: Math.round(p.t), name: String(p.name || '').slice(0, 120) };
  if (p.deleted) return { ...base, deleted: true };
  return { ...base, sub: String(p.sub || '').slice(0, 160), list: String(p.list || '').slice(0, 80) };
}

export function merge(stored, incoming, now = Date.now()) {
  const out = { ...stored };
  for (const [id, raw] of Object.entries(incoming)) {
    const p = cleanPlace(id, raw);
    // A clock can't claim the future to win every merge from here on.
    if (!p || p.t > now + 24 * 60 * 60 * 1000) continue;
    if (!out[id] || out[id].t < p.t) out[id] = p;
  }
  for (const [id, p] of Object.entries(out)) {
    if (p.deleted && now - p.t > TOMBSTONE_DAYS * 24 * 60 * 60 * 1000) delete out[id];
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!supabaseConfigured()) return res.status(503).json({ error: "Sync isn't set up on this site" });

  const { code, places } = req.body || {};
  if (typeof code !== 'string' || !CODE_RE.test(code)) return res.status(400).json({ error: "That isn't a sync code" });
  if (!places || typeof places !== 'object' || Array.isArray(places)) return res.status(400).json({ error: 'bad places' });
  if (Object.keys(places).length > MAX_PLACES * 2 || JSON.stringify(places).length > MAX_BYTES) {
    return res.status(413).json({ error: 'Too many saved places to sync' });
  }

  try {
    if (await overLimit(req, 'sync', SYNCS_PER_MINUTE)) return res.status(429).json({ error: 'Too many syncs. Try again in a minute.' });

    const hash = createHash('sha256').update(code).digest('hex');
    const rows = await rest(`${TABLE}?code_hash=eq.${hash}&select=places&limit=1`);
    const merged = merge(rows?.[0]?.places || {}, places);
    if (Object.values(merged).filter((p) => !p.deleted).length > MAX_PLACES) {
      return res.status(413).json({ error: 'Too many saved places to sync' });
    }
    const now = Date.now();
    await rest(`${TABLE}?on_conflict=code_hash`, {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        code_hash: hash,
        places: merged,
        updated_at: new Date(now).toISOString(),
        expires_at: new Date(now + KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    return res.status(200).json({ places: merged });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Couldn't sync just now" });
  }
}

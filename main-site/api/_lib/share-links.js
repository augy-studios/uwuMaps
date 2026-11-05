// Short share links, kept in Supabase's uwumaps_share_links table:
//
//   place       /go/<id>    One place.
//   directions  /trip/<id>  Both ends of a route and how to travel it.
//   eta         /eta/<id>   Live progress on a trip, updated by the sharer's device, then gone.
//   list        /list/<id>  A named list of places.
//
// A place, directions or list link is the same link every time the same thing is shared. An ETA link
// is new each time, and only the device that made it can update it, with the secret it was given,
// kept here only as a hash.

import { createHash, randomBytes } from 'node:crypto';
import { rest } from './supabase.js';

const TABLE = 'uwumaps_share_links';
export const PATHS = { place: 'go', directions: 'trip', eta: 'eta', list: 'list' };
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^[a-z0-9]{10}$/;
const MODES = ['foot', 'bike', 'car'];

// An ETA link lasts this long after its last update, and this long once the trip's over.
const ETA_TTL_MS = 3 * 60 * 60 * 1000;
const ETA_ENDED_TTL_MS = 60 * 60 * 1000;

export class ValidationError extends Error {}

export const isLinkId = (id) => typeof id === 'string' && ID_RE.test(id);

function newId() {
  return Array.from(randomBytes(10), (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/* ---- checking what's sent ---- */

function text(v, max, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw new ValidationError('missing text');
    return '';
  }
  if (typeof v !== 'string') throw new ValidationError('bad text');
  return v.trim().slice(0, max);
}

function point(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ValidationError('bad coordinates');
  }
  return [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
}

function place(p) {
  if (!p || typeof p !== 'object') throw new ValidationError('bad place');
  const [lat, lng] = point(p.lat, p.lng);
  return { label: text(p.label, 120, { required: true }), lat, lng };
}

const end = (p) => (p === 'here' ? 'here' : place(p));

function path(points, max) {
  if (points == null) return null;
  if (!Array.isArray(points)) throw new ValidationError('bad path');
  return points.slice(0, max).map((p) => {
    if (!Array.isArray(p)) throw new ValidationError('bad path');
    return point(p[0], p[1]);
  });
}

function mode(m) {
  if (!MODES.includes(m)) throw new ValidationError('bad travel mode');
  return m;
}

function me(m, now) {
  if (m == null) return null;
  if (typeof m !== 'object' || !Number.isFinite(m.t) || Math.abs(m.t - now) > 60 * 60 * 1000) throw new ValidationError('bad location');
  const [lat, lng] = point(m.lat, m.lng);
  return { lat, lng, accuracy: Number.isFinite(m.accuracy) ? Math.min(1000, Math.max(0, Math.round(m.accuracy))) : null, t: Math.round(m.t) };
}

function parseEta(data, now) {
  if (!Number.isFinite(data.arriveAt) || Math.abs(data.arriveAt - now) > 7 * 24 * 60 * 60 * 1000) throw new ValidationError('bad arrival time');
  return {
    name: text(data.name, 64),
    to: place(data.to),
    arriveAt: Math.round(data.arriveAt),
    mode: mode(data.mode),
    path: path(data.path, 400),
    // Where the sharer really is, from their last good fix.
    me: me(data.me, now),
    ended: Boolean(data.ended),
    stopped: Boolean(data.stopped),
  };
}

export function parseLink(kind, data, now = Date.now()) {
  if (!data || typeof data !== 'object') throw new ValidationError('missing data');
  if (kind === 'place') return place(data);
  if (kind === 'directions') {
    const out = {
      from: end(data.from),
      to: end(data.to),
      mode: mode(data.mode),
      summary: text(data.summary, 160),
      path: path(data.path, 400),
    };
    if (out.from === 'here' && out.to === 'here') throw new ValidationError('both ends are "here"');
    return out;
  }
  if (kind === 'eta') return parseEta(data, now);
  if (kind === 'list') {
    if (!Array.isArray(data.places) || !data.places.length) throw new ValidationError('an empty list');
    return { name: text(data.name, 80, { required: true }), places: data.places.slice(0, 200).map(place) };
  }
  throw new ValidationError('bad kind');
}

/* ---- the table ---- */

const etaExpiry = (data, now) => new Date(now + (data.ended || data.stopped ? ETA_ENDED_TTL_MS : ETA_TTL_MS)).toISOString();

async function findByKey(dedupeKey) {
  const rows = await rest(`${TABLE}?dedupe_key=eq.${dedupeKey}&select=id&limit=1`);
  return rows?.[0]?.id || null;
}

// Retried on the one-in-billions chance of an id already taken.
async function insert(row) {
  for (let tries = 0; ; tries++) {
    const id = newId();
    try {
      await rest(TABLE, { method: 'POST', body: { id, ...row }, prefer: 'return=minimal' });
      return id;
    } catch (err) {
      if (err.code !== '23505' || row.dedupe_key || tries >= 2) throw err;
    }
  }
}

// A link for this, made now or the one made before for the same thing.
export async function createLink(kind, data, now = Date.now()) {
  if (kind === 'eta') {
    // Tidied as new ones are made, so the table doesn't fill with trips long over.
    await rest(`${TABLE}?expires_at=lt.${new Date(now).toISOString()}`, { method: 'DELETE', prefer: 'return=minimal' }).catch((err) => console.warn(err.message));
    const secret = randomBytes(18).toString('base64url');
    const id = await insert({ kind, data, secret_hash: sha256(secret), expires_at: etaExpiry(data, now) });
    return { id, secret };
  }
  const dedupeKey = sha256(`${kind}\n${JSON.stringify(data)}`);
  const found = await findByKey(dedupeKey);
  if (found) return { id: found };
  try {
    return { id: await insert({ kind, data, dedupe_key: dedupeKey }) };
  } catch (err) {
    // Shared twice at once: the other made it first.
    if (err.code === '23505') {
      const again = await findByKey(dedupeKey);
      if (again) return { id: again };
    }
    throw err;
  }
}

// The link, or null when there's none or it has expired.
export async function getLink(id, now = Date.now()) {
  const rows = await rest(`${TABLE}?id=eq.${id}&select=kind,data,updated_at,expires_at&limit=1`);
  const row = rows?.[0];
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < now) return null;
  return { id, kind: row.kind, data: row.data, updatedAt: Date.parse(row.updated_at) };
}

// An ETA link's new progress. Says whether it was updated: false for a wrong secret or a link gone.
export async function updateEta(id, secret, data, now = Date.now()) {
  if (typeof secret !== 'string' || !secret) return false;
  const rows = await rest(
    `${TABLE}?id=eq.${id}&kind=eq.eta&secret_hash=eq.${sha256(secret)}&expires_at=gt.${new Date(now).toISOString()}&select=id`,
    {
      method: 'PATCH',
      body: { data, updated_at: new Date(now).toISOString(), expires_at: etaExpiry(data, now) },
      prefer: 'return=representation',
    },
  );
  return Array.isArray(rows) && rows.length > 0;
}

/* ---- how a link reads ---- */

const endLabel = (p) => (p === 'here' ? 'Your location' : p.label);
const HOW = { foot: 'on foot', bike: 'by bike', car: 'by car' };

export function describeLink({ kind, data }) {
  if (kind === 'place') return { title: data.label, description: 'See it on uwuMaps, and get directions there.' };
  if (kind === 'directions') {
    return {
      title: `${endLabel(data.from)} to ${endLabel(data.to)}`,
      description: `${data.summary ? `${data.summary} ` : ''}${HOW[data.mode]}, on uwuMaps.`.trim(),
    };
  }
  if (kind === 'list') return { title: data.name, description: `${data.places.length} places, on uwuMaps.` };
  const who = data.name || 'Someone';
  if (data.stopped) return { title: `${who} stopped sharing their trip to ${data.to.label}`, description: 'Live progress on uwuMaps.' };
  return {
    title: data.ended ? `${who} has arrived at ${data.to.label}` : `${who} is on the way to ${data.to.label}`,
    description: 'Follow along live on uwuMaps.',
  };
}

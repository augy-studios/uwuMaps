// Reading a saved pack back out of the Cache API, by byte range. No DOM, so the page and the routing
// worker share it. A pack's files are kept as 4 MiB pieces, so a read may cross a few of them.

import { PART_SIZE } from "./pack-list.js";

export const packCacheName = (id) => `uwumaps-pack-${id}`;
export const partUrl = (id, build, archive, n) => `/packs/${id}/${build}/${archive}/${n}`;

// Answers read(offset, length) over one archive of a pack.
export function archiveReader(id, build, archive) {
  let cachePromise = null;
  const blobs = new Map();

  const blobOf = async (n) => {
    const hit = blobs.get(n);
    if (hit) return hit;
    cachePromise ||= caches.open(packCacheName(id));
    const cache = await cachePromise;
    const res = await cache.match(partUrl(id, build, archive, n));
    if (!res) throw new Error(`A piece of the ${id} map is missing`);
    const blob = await res.blob();
    // A few held open: a blob is a handle on the disk rather than the bytes.
    if (blobs.size >= 16) blobs.delete(blobs.keys().next().value);
    blobs.set(n, blob);
    return blob;
  };

  return async function read(offset, length) {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const at = offset + done;
      const n = Math.floor(at / PART_SIZE);
      const from = at - n * PART_SIZE;
      const blob = await blobOf(n);
      const piece = new Uint8Array(await blob.slice(from, Math.min(blob.size, from + length - done)).arrayBuffer());
      if (!piece.length) throw new Error(`Read past the end of the ${id} map`);
      out.set(piece, done);
      done += piece.length;
    }
    return out;
  };
}

// The same over a pack's published file, for when it isn't saved: asks /api/mappack for the 4 MiB pieces a read
// falls in. A piece's address names its build and never changes, so the browser keeps them for next time.
export function publishedReader(id, build, archive) {
  const parts = new Map();

  const part = (n) => {
    if (!parts.has(n)) {
      parts.set(n, fetch(`/api/mappack?id=${encodeURIComponent(id)}&archive=${archive}&part=${n}&v=${build}`).then(async (res) => {
        if (!res.ok) throw new Error(`The ${id} map answered ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      }).catch((err) => {
        parts.delete(n);
        throw err;
      }));
    }
    return parts.get(n);
  };

  return async function read(offset, length) {
    const out = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const at = offset + done;
      const n = Math.floor(at / PART_SIZE);
      const from = at - n * PART_SIZE;
      const piece = (await part(n)).subarray(from, from + length - done);
      if (!piece.length) throw new Error(`Read past the end of the ${id} map`);
      out.set(piece, done);
      done += piece.length;
    }
    return out;
  };
}

export async function readPackMeta(id) {
  try {
    const cache = await caches.open(packCacheName(id));
    const res = await cache.match(`/packs/${id}.json`);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

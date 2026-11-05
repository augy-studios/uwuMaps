// Writes a PMTiles v3 archive from tiles handed over one by one, in any order. Tile bytes go
// straight to a temporary file, so a country's worth doesn't have to fit in memory.

import { closeSync, createReadStream, createWriteStream, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// A tile's position along the Hilbert curve that PMTiles orders archives by.
export function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 2 ** t * 2 ** t;
  const n = 2 ** z;
  let d = 0;
  let rx;
  let ry;
  for (let s = n / 2; s >= 1; s /= 2) {
    rx = Math.floor(x / s) & 1;
    ry = Math.floor(y / s) & 1;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}

function varint(out, v) {
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function serialiseDirectory(entries) {
  const out = [];
  varint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    varint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) varint(out, e.runLength);
  for (const e of entries) varint(out, e.length);
  entries.forEach((e, i) => {
    if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) varint(out, 0);
    else varint(out, e.offset + 1);
  });
  return gzipSync(Buffer.from(out), { level: 9 });
}

function setBigUint(buf, value, at) {
  buf.writeBigUInt64LE(BigInt(value), at);
}

const INITIAL = 16384; // The first bytes of an archive hold the header and root directory.
const TILE_MVT = 1;
const GZIP = 2;

export class PMTilesWriter {
  constructor(path) {
    this.path = path;
    this.tmp = `${path}.tiles.tmp`;
    this.out = createWriteStream(this.tmp);
    this.entries = [];
    this.bytes = 0;
    this.hashes = new Map();
    this.minZoom = 99;
    this.maxZoom = 0;
  }

  // `data` is the tile as it will be stored, already gzipped. Identical tiles share their bytes.
  async add(z, x, y, data) {
    const tileId = zxyToTileId(z, x, y);
    const hash = createHash('sha1').update(data).digest('base64');
    let at = this.hashes.get(hash);
    if (at == null) {
      at = this.bytes;
      this.hashes.set(hash, at);
      this.bytes += data.length;
      if (!this.out.write(data)) await once(this.out, 'drain');
    }
    this.entries.push({ tileId, offset: at, length: data.length, runLength: 1 });
    this.minZoom = Math.min(this.minZoom, z);
    this.maxZoom = Math.max(this.maxZoom, z);
  }

  async finish({ bounds, metadata }) {
    this.out.end();
    await once(this.out, 'finish');
    const entries = this.entries.sort((a, b) => a.tileId - b.tileId);

    // A root directory, with leaf directories when it wouldn't fit in the first 16 KiB.
    let root = serialiseDirectory(entries);
    let leaves = Buffer.alloc(0);
    if (root.length > INITIAL - 127) {
      for (let size = 4096; ; size *= 2) {
        const rootEntries = [];
        const parts = [];
        let at = 0;
        for (let i = 0; i < entries.length; i += size) {
          const leaf = serialiseDirectory(entries.slice(i, i + size));
          rootEntries.push({ tileId: entries[i].tileId, runLength: 0, offset: at, length: leaf.length });
          parts.push(leaf);
          at += leaf.length;
        }
        root = serialiseDirectory(rootEntries);
        if (root.length <= INITIAL - 127) {
          leaves = Buffer.concat(parts);
          break;
        }
      }
    }

    const metaBytes = gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 9 });
    const rootOffset = 127;
    const metaOffset = rootOffset + root.length;
    const leafOffset = metaOffset + metaBytes.length;
    const dataOffset = leafOffset + leaves.length;

    const h = Buffer.alloc(127);
    h.write('PMTiles', 0);
    h[7] = 3;
    setBigUint(h, rootOffset, 8);
    setBigUint(h, root.length, 16);
    setBigUint(h, metaOffset, 24);
    setBigUint(h, metaBytes.length, 32);
    setBigUint(h, leafOffset, 40);
    setBigUint(h, leaves.length, 48);
    setBigUint(h, dataOffset, 56);
    setBigUint(h, this.bytes, 64);
    setBigUint(h, entries.length, 72); // addressed tiles
    setBigUint(h, entries.length, 80); // tile entries
    setBigUint(h, this.hashes.size, 88); // tile contents
    h[96] = 0; // not clustered: tiles arrive in whatever order the requests finish
    h[97] = GZIP; // internal compression
    h[98] = GZIP; // tile compression
    h[99] = TILE_MVT;
    h[100] = this.minZoom;
    h[101] = this.maxZoom;
    h.writeInt32LE(Math.round(bounds[0] * 1e7), 102);
    h.writeInt32LE(Math.round(bounds[1] * 1e7), 106);
    h.writeInt32LE(Math.round(bounds[2] * 1e7), 110);
    h.writeInt32LE(Math.round(bounds[3] * 1e7), 114);
    h[118] = this.minZoom;
    h.writeInt32LE(Math.round(((bounds[0] + bounds[2]) / 2) * 1e7), 119);
    h.writeInt32LE(Math.round(((bounds[1] + bounds[3]) / 2) * 1e7), 123);

    const fd = openSync(`${this.path}.tmp`, 'w');
    writeSync(fd, h);
    writeSync(fd, root);
    writeSync(fd, metaBytes);
    writeSync(fd, leaves);
    closeSync(fd);
    const final = createWriteStream(`${this.path}.tmp`, { flags: 'a' });
    for await (const part of createReadStream(this.tmp)) {
      if (!final.write(part)) await once(final, 'drain');
    }
    final.end();
    await once(final, 'finish');
    renameSync(`${this.path}.tmp`, this.path);
    rmSync(this.tmp);
    return { tiles: entries.length, unique: this.hashes.size, size: dataOffset + this.bytes };
  }
}

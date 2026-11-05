// A small reader for OpenStreetMap's .osm.pbf format. No dependencies: the pack builds only need
// nodes, ways and relations in file order, and a general protobuf library is slower at this.
//
// A file is a run of blobs, each zlib compressed, each holding a block of up to 8,000 objects.
// Numbers fit a double: OSM ids are far below 2^53.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  more() {
    return this.pos < this.end;
  }

  // An unsigned varint. Multiplication rather than shifts past bit 31, which would wrap.
  varint() {
    const { buf } = this;
    let b = buf[this.pos++];
    let v = b & 0x7f;
    if (b < 0x80) return v;
    let mul = 128;
    for (;;) {
      b = buf[this.pos++];
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 128;
    }
  }

  // A zigzag varint, which can hold values past 2^32, so no bit operators.
  svarint() {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  // The next length-delimited field, as a reader over its bytes.
  sub() {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      // Read first: `this.pos += this.varint()` would use pos from before the length was read.
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unknown protobuf wire type ${wire}`);
  }
}

function packedUnsigned(r, out = []) {
  const s = r.sub();
  while (s.more()) out.push(s.varint());
  return out;
}

function packedSigned(r, out = []) {
  const s = r.sub();
  while (s.more()) out.push(s.svarint());
  return out;
}

function strings(r) {
  const out = [];
  while (r.more()) {
    const tag = r.varint();
    if (tag >> 3 === 1) {
      const len = r.varint();
      out.push(r.buf.toString('utf8', r.pos, r.pos + len));
      r.pos += len;
    } else r.skip(tag & 7);
  }
  return out;
}

function tagsOf(keys, vals, table) {
  const tags = {};
  for (let i = 0; i < keys.length; i++) tags[table[keys[i]]] = table[vals[i]];
  return tags;
}

function denseNodes(r, block, onNode) {
  let ids = [];
  let lats = [];
  let lons = [];
  let keysVals = null;
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) ids = packedSigned(r);
    else if (field === 8) lats = packedSigned(r);
    else if (field === 9) lons = packedSigned(r);
    else if (field === 10) keysVals = packedUnsigned(r);
    else r.skip(tag & 7);
  }
  const { granularity, latOffset, lonOffset, table } = block;
  let id = 0;
  let lat = 0;
  let lon = 0;
  let k = 0;
  for (let i = 0; i < ids.length; i++) {
    id += ids[i];
    lat += lats[i];
    lon += lons[i];
    let tags = null;
    if (keysVals) {
      while (k < keysVals.length && keysVals[k] !== 0) {
        (tags ||= {})[table[keysVals[k]]] = table[keysVals[k + 1]];
        k += 2;
      }
      k++;
    }
    onNode(id, (latOffset + lat * granularity) * 1e-9, (lonOffset + lon * granularity) * 1e-9, tags);
  }
}

function plainNode(r, block, onNode) {
  let id = 0;
  let lat = 0;
  let lon = 0;
  let keys = [];
  let vals = [];
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) id = r.svarint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) lat = r.svarint();
    else if (field === 9) lon = r.svarint();
    else r.skip(tag & 7);
  }
  const { granularity, latOffset, lonOffset, table } = block;
  onNode(id, (latOffset + lat * granularity) * 1e-9, (lonOffset + lon * granularity) * 1e-9, keys.length ? tagsOf(keys, vals, table) : null);
}

function way(r, block, onWay) {
  let id = 0;
  let keys = [];
  let vals = [];
  let deltas = [];
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) deltas = packedSigned(r);
    else r.skip(tag & 7);
  }
  let ref = 0;
  for (let i = 0; i < deltas.length; i++) {
    ref += deltas[i];
    deltas[i] = ref;
  }
  onWay(id, tagsOf(keys, vals, block.table), deltas);
}

const MEMBER_TYPES = ['node', 'way', 'relation'];

function relation(r, block, onRelation) {
  let id = 0;
  let keys = [];
  let vals = [];
  let roles = [];
  let memids = [];
  let types = [];
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) id = r.varint();
    else if (field === 2) keys = packedUnsigned(r);
    else if (field === 3) vals = packedUnsigned(r);
    else if (field === 8) roles = packedUnsigned(r);
    else if (field === 9) memids = packedSigned(r);
    else if (field === 10) types = packedUnsigned(r);
    else r.skip(tag & 7);
  }
  let ref = 0;
  const members = memids.map((d, i) => {
    ref += d;
    return { id: ref, type: MEMBER_TYPES[types[i]], role: block.table[roles[i]] };
  });
  onRelation(id, tagsOf(keys, vals, block.table), members);
}

function group(r, block, handlers) {
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1 && handlers.node) plainNode(r.sub(), block, handlers.node);
    else if (field === 2 && handlers.node) denseNodes(r.sub(), block, handlers.node);
    else if (field === 3 && handlers.way) way(r.sub(), block, handlers.way);
    else if (field === 4 && handlers.relation) relation(r.sub(), block, handlers.relation);
    else r.skip(tag & 7);
  }
}

function primitiveBlock(buf, handlers) {
  const r = new Reader(buf);
  const block = { table: [], granularity: 100, latOffset: 0, lonOffset: 0 };
  const groups = [];
  while (r.more()) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) block.table = strings(r.sub());
    else if (field === 2) groups.push(r.sub());
    else if (field === 17) block.granularity = r.varint();
    else if (field === 19) block.latOffset = r.varint();
    else if (field === 20) block.lonOffset = r.varint();
    else r.skip(tag & 7);
  }
  for (const g of groups) group(g, block, handlers);
}

// Reads the whole file in order, calling any of node(id, lat, lon, tags), way(id, tags, refs) and
// relation(id, tags, members). Leave one out and its objects aren't decoded.
export function readPbf(path, handlers, onProgress) {
  const fd = openSync(path, 'r');
  const { size } = fstatSync(fd);
  const lenBuf = Buffer.alloc(4);
  let pos = 0;
  try {
    while (pos < size) {
      readSync(fd, lenBuf, 0, 4, pos);
      pos += 4;
      const headerLen = lenBuf.readUInt32BE(0);
      const header = Buffer.alloc(headerLen);
      readSync(fd, header, 0, headerLen, pos);
      pos += headerLen;

      let type = '';
      let dataSize = 0;
      const h = new Reader(header);
      while (h.more()) {
        const tag = h.varint();
        const field = tag >> 3;
        if (field === 1) {
          const s = h.sub();
          type = header.toString('utf8', s.pos, s.end);
        } else if (field === 3) dataSize = h.varint();
        else h.skip(tag & 7);
      }

      const blobBuf = Buffer.alloc(dataSize);
      readSync(fd, blobBuf, 0, dataSize, pos);
      pos += dataSize;
      if (type !== 'OSMData') continue;

      let data = null;
      const b = new Reader(blobBuf);
      while (b.more()) {
        const tag = b.varint();
        const field = tag >> 3;
        if (field === 1) {
          const s = b.sub();
          data = blobBuf.subarray(s.pos, s.end);
        } else if (field === 3) {
          const s = b.sub();
          data = inflateSync(blobBuf.subarray(s.pos, s.end));
        } else b.skip(tag & 7);
      }
      if (data) primitiveBlock(data, handlers);
      onProgress?.(pos / size);
    }
  } finally {
    closeSync(fd);
  }
}

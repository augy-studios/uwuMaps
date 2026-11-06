// Reading a PMTiles v3 archive by byte range: the same file whether it's on the phone (an offline pack)
// or online (Overture's buildings). Tiles come back decompressed, ready for the map.

import 'dart:convert';
import 'dart:typed_data';

import '../core/gz.dart';

typedef RangeRead = Future<Uint8List> Function(int offset, int length);

const int _gzipCompression = 2;
const int _noCompression = 1;
const int _unknownCompression = 0;

class _Entry {
  _Entry(this.tileId, this.offset, this.length, this.runLength);
  final int tileId;
  int offset;
  int length;
  final int runLength;
}

class PmTiles {
  PmTiles(this._read);

  final RangeRead _read;
  Future<_Header>? _header;
  // The directories read, newest last, so the oldest is first when one has to go.
  final Map<int, Future<List<_Entry>>> _dirs = {};
  static const int _dirCache = 64;

  Future<_Header> _openHeader() async {
    // The first 16 KiB always holds the header and the root directory.
    final head = await _read(0, 16384);
    if (head.length < 127 || ascii.decode(head.sublist(0, 7), allowInvalid: true) != 'PMTiles') {
      throw const FormatException('Not a PMTiles file');
    }
    if (head[7] != 3) throw FormatException('PMTiles version ${head[7]} is not supported');
    final view = ByteData.sublistView(head);
    int u64(int at) => view.getUint32(at, Endian.little) + view.getUint32(at + 4, Endian.little) * 4294967296;
    final header = _Header(
      rootOffset: u64(8),
      rootLength: u64(16),
      leafOffset: u64(40),
      tileDataOffset: u64(56),
      internalCompression: head[97],
      tileCompression: head[98],
      minZoom: head[100],
      maxZoom: head[101],
    );
    final rootBytes = header.rootOffset + header.rootLength <= head.length ? Uint8List.sublistView(head, header.rootOffset, header.rootOffset + header.rootLength) : await _read(header.rootOffset, header.rootLength);
    _dirs[header.rootOffset] = Future.value(_parseDirectory(await _decompress(rootBytes, header.internalCompression)));
    return header;
  }

  Future<Uint8List> _decompress(Uint8List bytes, int kind) async {
    if (kind == _gzipCompression) return gunzip(bytes);
    if (kind == _noCompression || kind == _unknownCompression) return bytes;
    throw FormatException('PMTiles compression $kind is not supported');
  }

  Future<List<_Entry>> _directory(_Header h, int offset, int length) {
    final hit = _dirs.remove(offset);
    if (hit != null) {
      _dirs[offset] = hit;
      return hit;
    }
    final made = _read(offset, length).then((b) => _decompress(b, h.internalCompression)).then(_parseDirectory);
    _dirs[offset] = made;
    if (_dirs.length > _dirCache) _dirs.remove(_dirs.keys.first);
    return made;
  }

  /// The tile's bytes, decompressed, or null when the archive has none there.
  Future<Uint8List?> tile(int z, int x, int y) async {
    final h = await (_header ??= _openHeader());
    if (z < h.minZoom || z > h.maxZoom) return null;
    final id = zxyToTileId(z, x, y);
    var offset = h.rootOffset;
    var length = h.rootLength;
    for (var depth = 0; depth <= 3; depth++) {
      final dir = await _directory(h, offset, length);
      final entry = _find(dir, id);
      if (entry == null) return null;
      if (entry.runLength > 0) {
        final bytes = await _read(h.tileDataOffset + entry.offset, entry.length);
        return _decompress(bytes, h.tileCompression);
      }
      offset = h.leafOffset + entry.offset;
      length = entry.length;
    }
    throw const FormatException('PMTiles directories go too deep');
  }
}

class _Header {
  _Header({required this.rootOffset, required this.rootLength, required this.leafOffset, required this.tileDataOffset, required this.internalCompression, required this.tileCompression, required this.minZoom, required this.maxZoom});
  final int rootOffset;
  final int rootLength;
  final int leafOffset;
  final int tileDataOffset;
  final int internalCompression;
  final int tileCompression;
  final int minZoom;
  final int maxZoom;
}

List<_Entry> _parseDirectory(Uint8List b) {
  var pos = 0;
  int varint() {
    var value = 0;
    var mul = 1;
    for (;;) {
      final byte = b[pos++];
      value += (byte & 0x7f) * mul;
      if (byte < 0x80) return value;
      mul *= 128;
    }
  }

  final n = varint();
  final ids = List<int>.filled(n, 0);
  var last = 0;
  for (var i = 0; i < n; i++) {
    last += varint();
    ids[i] = last;
  }
  final runs = List<int>.generate(n, (_) => varint());
  final lengths = List<int>.generate(n, (_) => varint());
  final entries = <_Entry>[];
  for (var i = 0; i < n; i++) {
    final v = varint();
    final offset = v == 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
    entries.add(_Entry(ids[i], offset, lengths[i], runs[i]));
  }
  return entries;
}

_Entry? _find(List<_Entry> entries, int id) {
  var lo = 0;
  var hi = entries.length - 1;
  while (lo <= hi) {
    final mid = (lo + hi) ~/ 2;
    final at = entries[mid].tileId;
    if (at == id) return entries[mid];
    if (at < id) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // A run of the same tile, or a leaf directory, can start before the id.
  if (hi >= 0) {
    final e = entries[hi];
    if (e.runLength == 0) return e;
    if (id - e.tileId < e.runLength) return e;
  }
  return null;
}

/// The Hilbert curve position of a tile, counted across every zoom before it.
int zxyToTileId(int z, int x, int y) {
  var base = 0;
  for (var t = 0; t < z; t++) {
    base += (1 << t) * (1 << t);
  }
  final n = 1 << z;
  var rx = 0;
  var ry = 0;
  var d = 0;
  var tx = x;
  var ty = y;
  for (var s = n ~/ 2; s > 0; s = s ~/ 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry == 0) {
      if (rx == 1) {
        tx = n - 1 - tx;
        ty = n - 1 - ty;
      }
      final swap = tx;
      tx = ty;
      ty = swap;
    }
  }
  return base + d;
}

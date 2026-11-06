// BinaryPack, PeerJS's message format, so the app can talk to the website over a data channel. As in
// peerjs-js-binarypack: like MessagePack, except that 0xb0 to 0xbf and 0xd8, 0xd9 are strings, and
// 0xa0 to 0xaf and 0xda, 0xdb are raw bytes.

import 'dart:convert';
import 'dart:typed_data';

Uint8List packMessage(Object? value) {
  final out = BytesBuilder(copy: false);
  _pack(value, out);
  return out.toBytes();
}

void _u16(BytesBuilder o, int v) => o
  ..addByte((v >> 8) & 0xff)
  ..addByte(v & 0xff);

void _u32(BytesBuilder o, int v) => o
  ..addByte((v >> 24) & 0xff)
  ..addByte((v >> 16) & 0xff)
  ..addByte((v >> 8) & 0xff)
  ..addByte(v & 0xff);

void _pack(Object? v, BytesBuilder o) {
  if (v == null) {
    o.addByte(0xc0);
  } else if (v is bool) {
    o.addByte(v ? 0xc3 : 0xc2);
  } else if (v is Uint8List) {
    if (v.length <= 0x0f) {
      o.addByte(0xa0 + v.length);
    } else if (v.length <= 0xffff) {
      o.addByte(0xda);
      _u16(o, v.length);
    } else {
      o.addByte(0xdb);
      _u32(o, v.length);
    }
    o.add(v);
  } else if (v is String) {
    final bytes = utf8.encode(v);
    if (bytes.length <= 0x0f) {
      o.addByte(0xb0 + bytes.length);
    } else if (bytes.length <= 0xffff) {
      o.addByte(0xd8);
      _u16(o, bytes.length);
    } else {
      o.addByte(0xd9);
      _u32(o, bytes.length);
    }
    o.add(bytes);
  } else if (v is num) {
    final i = v.toInt();
    if (i == v && i.abs() <= 0x7fffffff) {
      _packInt(i, o);
    } else {
      o.addByte(0xcb);
      final b = ByteData(8)..setFloat64(0, v.toDouble());
      o.add(b.buffer.asUint8List());
    }
  } else if (v is List) {
    if (v.length <= 0x0f) {
      o.addByte(0x90 + v.length);
    } else if (v.length <= 0xffff) {
      o.addByte(0xdc);
      _u16(o, v.length);
    } else {
      o.addByte(0xdd);
      _u32(o, v.length);
    }
    for (final item in v) {
      _pack(item, o);
    }
  } else if (v is Map) {
    if (v.length <= 0x0f) {
      o.addByte(0x80 + v.length);
    } else if (v.length <= 0xffff) {
      o.addByte(0xde);
      _u16(o, v.length);
    } else {
      o.addByte(0xdf);
      _u32(o, v.length);
    }
    v.forEach((key, value) {
      _pack(key, o);
      _pack(value, o);
    });
  } else {
    throw ArgumentError('Cannot pack ${v.runtimeType}');
  }
}

void _packInt(int n, BytesBuilder o) {
  if (n >= -0x20 && n <= 0x7f) {
    o.addByte(n & 0xff);
  } else if (n >= 0 && n <= 0xff) {
    o
      ..addByte(0xcc)
      ..addByte(n);
  } else if (n >= -0x80 && n <= 0x7f) {
    o
      ..addByte(0xd0)
      ..addByte(n & 0xff);
  } else if (n >= 0 && n <= 0xffff) {
    o.addByte(0xcd);
    _u16(o, n);
  } else if (n >= -0x8000 && n <= 0x7fff) {
    o.addByte(0xd1);
    _u16(o, n & 0xffff);
  } else if (n >= 0) {
    o.addByte(0xce);
    _u32(o, n);
  } else {
    o.addByte(0xd2);
    _u32(o, n & 0xffffffff);
  }
}

Object? unpackMessage(Uint8List bytes) => _Unpacker(bytes).unpack();

class _Unpacker {
  _Unpacker(this.b) : d = ByteData.sublistView(b);
  final Uint8List b;
  final ByteData d;
  int p = 0;

  int _u8() => b[p++];
  int _u16() {
    final v = d.getUint16(p);
    p += 2;
    return v;
  }

  int _u32() {
    final v = d.getUint32(p);
    p += 4;
    return v;
  }

  Uint8List _raw(int n) {
    final v = Uint8List.sublistView(b, p, p + n);
    p += n;
    return Uint8List.fromList(v);
  }

  String _str(int n) => utf8.decode(_raw(n), allowMalformed: true);

  List<Object?> _arr(int n) => List<Object?>.generate(n, (_) => unpack());

  Map<String, Object?> _map(int n) {
    final out = <String, Object?>{};
    for (var i = 0; i < n; i++) {
      final key = unpack();
      out['$key'] = unpack();
    }
    return out;
  }

  Object? unpack() {
    final t = _u8();
    if (t < 0x80) return t;
    if ((t ^ 0xe0) < 0x20) return (t ^ 0xe0) - 0x20;
    final raw = t ^ 0xa0;
    if (raw <= 0x0f) return _raw(raw);
    final str = t ^ 0xb0;
    if (str <= 0x0f) return _str(str);
    final arr = t ^ 0x90;
    if (arr <= 0x0f) return _arr(arr);
    final map = t ^ 0x80;
    if (map <= 0x0f) return _map(map);
    switch (t) {
      case 0xc0:
      case 0xc1:
      case 0xd4:
      case 0xd5:
      case 0xd6:
      case 0xd7:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xca:
        final v = d.getFloat32(p);
        p += 4;
        return v;
      case 0xcb:
        final v = d.getFloat64(p);
        p += 8;
        return v;
      case 0xcc:
        return _u8();
      case 0xcd:
        return _u16();
      case 0xce:
        return _u32();
      case 0xcf:
        final hi = _u32();
        final lo = _u32();
        return hi * 4294967296 + lo;
      case 0xd0:
        final v = d.getInt8(p);
        p += 1;
        return v;
      case 0xd1:
        final v = d.getInt16(p);
        p += 2;
        return v;
      case 0xd2:
        final v = d.getInt32(p);
        p += 4;
        return v;
      case 0xd3:
        final hi = d.getInt32(p);
        final lo = d.getUint32(p + 4);
        p += 8;
        return hi * 4294967296 + lo;
      case 0xd8:
        return _str(_u16());
      case 0xd9:
        return _str(_u32());
      case 0xda:
        return _raw(_u16());
      case 0xdb:
        return _raw(_u32());
      case 0xdc:
        return _arr(_u16());
      case 0xdd:
        return _arr(_u32());
      case 0xde:
        return _map(_u16());
      case 0xdf:
        return _map(_u32());
    }
    throw FormatException('Unknown BinaryPack type $t');
  }
}

/// Puts back a message PeerJS split over several frames.
class Chunks {
  final Map<int, _Parts> _open = {};

  /// Answers the whole message once its last part has arrived, else null.
  Uint8List? add(Map<String, Object?> part) {
    final id = (part['__peerData'] as num).toInt();
    final total = (part['total'] as num).toInt();
    final got = _open[id] ??= _Parts(total);
    got.data[(part['n'] as num).toInt()] = part['data'] as Uint8List;
    got.count++;
    if (got.count < total) return null;
    _open.remove(id);
    final out = BytesBuilder(copy: false);
    for (final piece in got.data) {
      out.add(piece!);
    }
    return out.toBytes();
  }
}

class _Parts {
  _Parts(int total) : data = List<Uint8List?>.filled(total, null);
  final List<Uint8List?> data;
  int count = 0;
}

const int chunkedMtu = 16300;
int _chunkIds = 1;

/// One message as the frames to send, split the way PeerJS does when it's over [chunkedMtu].
List<Uint8List> framesFor(Object? message) {
  final whole = packMessage(message);
  if (whole.length <= chunkedMtu) return [whole];
  final id = _chunkIds++;
  final total = (whole.length / chunkedMtu).ceil();
  return List.generate(total, (n) {
    final from = n * chunkedMtu;
    final to = from + chunkedMtu > whole.length ? whole.length : from + chunkedMtu;
    return packMessage({'__peerData': id, 'n': n, 'data': Uint8List.sublistView(whole, from, to), 'total': total});
  });
}

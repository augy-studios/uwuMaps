// The offline router: reads a pack's routing file and finds the way between two points. A port of
// main-site/js/route-core.js with no Flutter in it, so it runs in the routing isolate and in tests.
//
// The file's format is written by tools/packs/compile-graph.mjs, with the class numbers and bits in
// tools/packs/lib/osm-profile.mjs. Keep them in step.
//
// It is A*, over junctions, reading chunks of the graph only as the search reaches them. Far from
// both ends of a route it looks at main roads only, from the coarser "major" chunks, which is what
// makes a long drive possible on a phone. If that finds nothing, it tries again on every road.

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import '../core/gz.dart';
import '../core/models.dart';

class TravelMode {
  const TravelMode(this.bit, this.maxMps, this.near);

  /// Who may use an edge.
  final int bit;

  /// The fastest anything goes, for the search's estimate.
  final double maxMps;

  /// How far from either end, in metres, every road is considered.
  final double near;
}

const Map<String, TravelMode> travelModes = {
  'car': TravelMode(1, 33, 15000),
  'bike': TravelMode(2, 6.5, 8000),
  'foot': TravelMode(4, 1.5, 5000),
};

const int _classFerry = 13;

// km/h by class. Driving reads the speed in the data instead.
const List<double> _bikeKmh = [0, 18, 18, 18, 18, 17, 16, 14, 11, 12, 6, 18, 3, 12];
const List<double> _footKmh = [0, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.5, 4.5, 4.8, 4.8, 2.5, 8];
// How much less pleasant than its time a road is: what route quality trades against time.
const List<double> _bikeCost = [99, 2.2, 1.7, 1.4, 1.15, 1, 1, 1.05, 1.1, 1, 1.1, 0.8, 3, 1];
const List<double> _footCost = [99, 1.8, 1.4, 1.2, 1.05, 1, 1, 1, 1, 0.95, 0.9, 1.05, 1.2, 1];

// Search harder than exact, for speed: the route found is within a few percent of the best.
const double _greed = 1.2;
const int _chunkCache = 160;
const double _rad = math.pi / 180;
const int _key24 = 16777216; // 2^24
const int _key26 = 67108864; // 2^26

double metres(double aLat, double aLon, double bLat, double bLon) {
  final dLat = (bLat - aLat) * _rad;
  final dLon = (bLon - aLon) * _rad * math.cos(((aLat + bLat) / 2) * _rad);
  return 6371000 * math.sqrt(dLat * dLat + dLon * dLon);
}

double _bearing(double aLat, double aLon, double bLat, double bLon) {
  final dLon = (bLon - aLon) * _rad;
  final y = math.sin(dLon) * math.cos(bLat * _rad);
  final x = math.cos(aLat * _rad) * math.sin(bLat * _rad) - math.sin(aLat * _rad) * math.cos(bLat * _rad) * math.cos(dLon);
  return (math.atan2(y, x) / _rad + 360) % 360;
}

double _asinh(double x) => math.log(x + math.sqrt(x * x + 1));

int _tileX(double lon, int z) {
  final n = math.pow(2, z).toInt();
  return math.min(n - 1, math.max(0, (((lon + 180) / 360) * n).floor()));
}

int _tileY(double lat, int z) {
  final n = math.pow(2, z).toInt();
  final r = lat * _rad;
  return math.min(n - 1, math.max(0, (((1 - _asinh(math.tan(r)) / math.pi) / 2) * n).floor()));
}

/* ---- reading a chunk ---- */

class _Rule {
  const _Rule(this.from, this.to, this.only);
  final int from;
  final int to;
  final bool only;
}

class Chunk {
  Chunk(this.names, this.ids, this.lat, this.lon, this.start, this.to, this.len, this.cls, this.bits, this.kmh, this.name, this.shapeStart, this.shape, this.restrictions);

  final List<String> names;
  final Uint32List ids;
  final Int32List lat;
  final Int32List lon;
  final Uint32List start;
  final Uint32List to;
  final Uint32List len;
  final Uint8List cls;
  final Uint8List bits;
  final Uint8List kmh;
  final Uint32List name;
  final Uint32List shapeStart;
  final Int32List shape;
  final Map<int, List<_Rule>> restrictions;
}

Chunk _decodeChunk(Uint8List buf) {
  var pos = 0;
  int varint() {
    var b = buf[pos++];
    var v = b & 0x7f;
    var mul = 128;
    while (b >= 0x80) {
      b = buf[pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    }
    return v;
  }

  int zigzag() {
    final v = varint();
    return v.isEven ? v ~/ 2 : -(v + 1) ~/ 2;
  }

  final nameCount = varint();
  final names = List<String>.filled(nameCount + 1, '');
  for (var i = 1; i <= nameCount; i++) {
    final n = varint();
    names[i] = utf8.decode(Uint8List.sublistView(buf, pos, pos + n), allowMalformed: true);
    pos += n;
  }

  final n = varint();
  final ids = Uint32List(n);
  var v = 0;
  for (var i = 0; i < n; i++) {
    v += varint();
    ids[i] = v;
  }
  final lat = Int32List(n);
  final lon = Int32List(n);
  var la = 0;
  var lo = 0;
  for (var i = 0; i < n; i++) {
    la += zigzag();
    lo += zigzag();
    lat[i] = la;
    lon[i] = lo;
  }

  final start = Uint32List(n + 1);
  for (var i = 0; i < n; i++) {
    start[i + 1] = start[i] + varint();
  }
  final m = start[n];
  final to = Uint32List(m);
  for (var i = 0; i < n; i++) {
    for (var e = start[i]; e < start[i + 1]; e++) {
      to[e] = ids[i] + zigzag();
    }
  }
  final len = Uint32List(m);
  for (var e = 0; e < m; e++) {
    len[e] = varint();
  }
  final cls = Uint8List(m);
  for (var e = 0; e < m; e++) {
    cls[e] = buf[pos++];
  }
  final bits = Uint8List(m);
  for (var e = 0; e < m; e++) {
    bits[e] = buf[pos++];
  }
  final kmh = Uint8List(m);
  for (var e = 0; e < m; e++) {
    kmh[e] = buf[pos++];
  }
  final name = Uint32List(m);
  for (var e = 0; e < m; e++) {
    name[e] = varint();
  }

  // Shapes: each edge's points after its start, the last being its target.
  final shapeStart = Uint32List(m + 1);
  final pts = <int>[];
  for (var i = 0; i < n; i++) {
    for (var e = start[i]; e < start[i + 1]; e++) {
      var count = varint() + 1;
      var sLa = lat[i];
      var sLo = lon[i];
      while (count-- > 0) {
        sLa += zigzag();
        sLo += zigzag();
        pts
          ..add(sLa)
          ..add(sLo);
      }
      shapeStart[e + 1] = pts.length;
    }
  }

  final restrictions = <int, List<_Rule>>{};
  final rCount = varint();
  for (var i = 0; i < rCount; i++) {
    final via = varint();
    final from = varint();
    final toV = varint();
    final only = buf[pos++];
    restrictions.putIfAbsent(via, () => []).add(_Rule(from, toV, only == 1));
  }

  return Chunk(names, ids, lat, lon, start, to, len, cls, bits, kmh, name, shapeStart, Int32List.fromList(pts), restrictions);
}

int _vertexIndex(Chunk chunk, int id) {
  final ids = chunk.ids;
  var lo = 0;
  var hi = ids.length - 1;
  while (lo <= hi) {
    final mid = (lo + hi) ~/ 2;
    final v = ids[mid];
    if (v == id) return mid;
    if (v < id) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

/* ---- the file ---- */

class _Entry {
  const _Entry(this.tag, this.offset, this.length);
  final String tag;
  final int offset;
  final int length;
}

/// One place a snapped point meets the road: a directed edge, and how far along it.
class SnapEdge {
  SnapEdge(this.chunk, this.vi, this.e, this.seg, this.t, this.d, this.lat, this.lon);
  final Chunk chunk;
  final int vi;
  final int e;
  final int seg;
  final double t;
  final double d;
  final double lat;
  final double lon;
}

class Snap {
  Snap(this.lat, this.lon, this.distance, this.edges);
  final double lat;
  final double lon;
  final double distance;
  final List<SnapEdge> edges;
}

typedef ByteRead = Future<Uint8List> Function(int offset, int length);

class RouteGraph {
  RouteGraph._(this.read);

  final ByteRead read;
  // A map keeps insertion order, so the oldest is first when one has to go.
  final Map<String, Chunk> _chunks = {};
  final Map<String, Future<Chunk>> _pending = {};
  late int _dataStart;
  late int _zLocal;
  late int _zMajor;
  final Map<int, _Entry> _local = {};
  final Map<int, _Entry> _major = {};

  static Future<RouteGraph> open(ByteRead read) async {
    final g = RouteGraph._(read);
    final head = await read(0, 12);
    if (ascii.decode(head.sublist(0, 8), allowInvalid: true) != 'UWUROUTE') {
      throw const FormatException('Not a routing file');
    }
    final headerLen = ByteData.sublistView(head).getUint32(8, Endian.little);
    final header = jsonDecode(utf8.decode(await gunzip(await read(12, headerLen)))) as Map<String, dynamic>;
    g._dataStart = 12 + headerLen;
    g._zLocal = (header['zLocal'] as num).toInt();
    g._zMajor = (header['zMajor'] as num).toInt();
    void fill(List<dynamic> flat, Map<int, _Entry> into, String tag) {
      for (var i = 0; i < flat.length; i += 4) {
        into[(flat[i] as num).toInt() * _key24 + (flat[i + 1] as num).toInt()] = _Entry('$tag$i', (flat[i + 2] as num).toInt(), (flat[i + 3] as num).toInt());
      }
    }

    fill(header['local'] as List<dynamic>, g._local, 'l');
    fill(header['major'] as List<dynamic>, g._major, 'm');
    return g;
  }

  Future<Chunk> _load(_Entry entry) async {
    final hit = _chunks.remove(entry.tag);
    if (hit != null) {
      // Newest last.
      _chunks[entry.tag] = hit;
      return hit;
    }
    final wait = _pending[entry.tag] ??= read(_dataStart + entry.offset, entry.length).then(gunzip).then(_decodeChunk);
    final chunk = await wait;
    _pending.remove(entry.tag);
    _chunks[entry.tag] = chunk;
    if (_chunks.length > _chunkCache) _chunks.remove(_chunks.keys.first);
    return chunk;
  }

  _Entry? _localEntry(double lat, double lon) => _local[_tileX(lon, _zLocal) * _key24 + _tileY(lat, _zLocal)];
  _Entry? _majorEntry(double lat, double lon) => _major[_tileX(lon, _zMajor) * _key24 + _tileY(lat, _zMajor)];

  /// The nearest road a mode may use. Answers the point on it and how to get on and off there:
  /// every directed edge through that point, with how far along the edge it is.
  Future<Snap?> snap(double lat, double lon, String modeName) async {
    final mode = travelModes[modeName]!;
    final cx = _tileX(lon, _zLocal);
    final cy = _tileY(lat, _zLocal);
    final cos = math.cos(lat * _rad);
    var best = double.infinity;
    final found = <SnapEdge>[];

    for (var ring = 0; ring <= 3; ring++) {
      for (var dx = -ring; dx <= ring; dx++) {
        for (var dy = -ring; dy <= ring; dy++) {
          if (math.max(dx.abs(), dy.abs()) != ring) continue;
          final entry = _local[(cx + dx) * _key24 + (cy + dy)];
          if (entry == null) continue;
          final chunk = await _load(entry);
          final start = chunk.start;
          final bits = chunk.bits;
          final shape = chunk.shape;
          final shapeStart = chunk.shapeStart;
          for (var i = 0; i < chunk.ids.length; i++) {
            for (var e = start[i]; e < start[i + 1]; e++) {
              if (bits[e] & mode.bit == 0) continue;
              var ax = chunk.lon[i] * 1e-6;
              var ay = chunk.lat[i] * 1e-6;
              for (var p = shapeStart[e]; p < shapeStart[e + 1]; p += 2) {
                final bx = shape[p + 1] * 1e-6;
                final by = shape[p] * 1e-6;
                final dxS = (bx - ax) * cos;
                final dyS = by - ay;
                final px = (lon - ax) * cos;
                final py = lat - ay;
                final l2 = dxS * dxS + dyS * dyS;
                final t = l2 != 0 ? ((px * dxS + py * dyS) / l2).clamp(0.0, 1.0) : 0.0;
                final ex = px - t * dxS;
                final ey = py - t * dyS;
                final d = math.sqrt(ex * ex + ey * ey) * 111195;
                if (d < best + 1) {
                  if (d < best) best = d;
                  found.add(SnapEdge(chunk, i, e, p, t, d, ay + t * (by - ay), ax + t * (bx - ax)));
                }
                ax = bx;
                ay = by;
              }
            }
          }
        }
      }
      // A closer road can't be in a further ring once one is nearer than a ring's width.
      if (best < 1500 * ring + 500) break;
    }
    final edges = found.where((f) => f.d < best + 1).toList();
    if (edges.isEmpty) return null;
    return Snap(edges.first.lat, edges.first.lon, best, edges);
  }
}

/* ---- a small binary heap of [cost, label] ---- */

class _Heap {
  final List<double> _c = [];
  final List<int> _l = [];

  bool get isNotEmpty => _c.isNotEmpty;

  void push(double cost, int label) {
    var i = _c.length;
    _c.add(cost);
    _l.add(label);
    while (i > 0) {
      final p = (i - 1) >> 1;
      if (_c[p] <= cost) break;
      _c[i] = _c[p];
      _l[i] = _l[p];
      i = p;
    }
    _c[i] = cost;
    _l[i] = label;
  }

  int pop() {
    final top = _l[0];
    final lastC = _c.removeLast();
    final lastL = _l.removeLast();
    final n = _c.length;
    if (n > 0) {
      var i = 0;
      for (;;) {
        var k = 2 * i + 1;
        if (k >= n) break;
        if (k + 1 < n && _c[k + 1] < _c[k]) k++;
        if (_c[k] >= lastC) break;
        _c[i] = _c[k];
        _l[i] = _l[k];
        i = k;
      }
      _c[i] = lastC;
      _l[i] = lastL;
    }
    return top;
  }
}

/* ---- the search ---- */

double _edgeSeconds(Chunk chunk, int e, String modeName, [double fraction = 1]) {
  final m = chunk.len[e] * fraction;
  final cls = chunk.cls[e] & 15;
  if (modeName == 'car') return m / (math.max(5, chunk.kmh[e]) / 3.6);
  final table = modeName == 'bike' ? _bikeKmh : _footKmh;
  final kmh = cls < table.length && table[cls] != 0 ? table[cls] : 4.0;
  return m / (kmh / 3.6);
}

double _edgeCost(Chunk chunk, int e, String modeName, [double fraction = 1]) {
  final secs = _edgeSeconds(chunk, e, modeName, fraction);
  final cls = chunk.cls[e] & 15;
  if (modeName == 'bike') return secs * _bikeCost[cls];
  if (modeName == 'foot') return secs * _footCost[cls];
  return secs;
}

// How far along a directed edge a snapped point is, as a fraction of its length.
double _alongEdge(SnapEdge f) {
  final chunk = f.chunk;
  double ax = chunk.lat[f.vi].toDouble();
  double ay = chunk.lon[f.vi].toDouble();
  var total = 0.0;
  var upTo = 0.0;
  for (var p = chunk.shapeStart[f.e]; p < chunk.shapeStart[f.e + 1]; p += 2) {
    final dLat = chunk.shape[p] - ax;
    final dLon = (chunk.shape[p + 1] - ay) * math.cos(ax * 1e-6 * _rad);
    final d = math.sqrt(dLat * dLat + dLon * dLon);
    if (p < f.seg) {
      upTo += d;
    } else if (p == f.seg) {
      upTo += d * f.t;
    }
    total += d;
    ax = chunk.shape[p].toDouble();
    ay = chunk.shape[p + 1].toDouble();
  }
  return total != 0 ? upTo / total : 0;
}

class _Label {
  _Label({required this.vertex, required this.lat, required this.lon, required this.g, required this.prev, required this.from, this.chunk, this.e = -1, this.startPart, this.frac = 0});
  final int vertex;
  final double lat;
  final double lon;
  final double g;
  final int prev;
  final int from;
  final Chunk? chunk;
  final int e;
  final SnapEdge? startPart;
  final double frac;
  bool closed = false;
}

class _Finish {
  _Finish.direct(this.part, this.fa, this.fb)
      : direct = true,
        label = -1,
        frac = 0;
  _Finish.at(this.label, this.part, this.frac)
      : direct = false,
        fa = 0,
        fb = 0;
  final bool direct;
  final int label;
  final SnapEdge part;
  final double frac;
  final double fa;
  final double fb;
}

class _Run {
  _Run(this.finish, this.labels, {this.stopped = false});
  final _Finish? finish;
  final List<_Label> labels;
  final bool stopped;
}

class _Goal {
  _Goal(this.cost, this.part, this.frac);
  final double cost;
  final SnapEdge part;
  final double frac;
}

Future<_Run> _search(RouteGraph graph, Snap from, Snap to, String modeName, {required bool hierarchy, required int timeLimitMs, bool Function()? shouldStop}) async {
  final mode = travelModes[modeName]!;
  double heur(double lat, double lon) => (metres(lat, lon, to.lat, to.lon) / mode.maxMps) * _greed;
  final watch = Stopwatch()..start();

  // Each label: where it is and how it got there.
  final labels = <_Label>[];
  final bestAt = <int, double>{};
  final heap = _Heap();

  // A restricted junction has to remember which way it was entered, since that decides where it
  // can go next. Everywhere else, one best way in is enough.
  int stateKey(int vertex, int prev, bool restricted) => restricted ? vertex + (prev + 1) * _key26 : vertex;

  // Getting on: from the snapped point, along an edge to its far junction.
  for (final f in from.edges) {
    final frac = _alongEdge(f);
    final chunk = f.chunk;
    final end = chunk.shapeStart[f.e + 1];
    final lat = chunk.shape[end - 2] * 1e-6;
    final lon = chunk.shape[end - 1] * 1e-6;
    final cost = _edgeCost(chunk, f.e, modeName, 1 - frac);
    labels.add(_Label(vertex: chunk.to[f.e], lat: lat, lon: lon, g: cost, prev: -1, from: -1, startPart: f, frac: frac));
    bestAt[chunk.to[f.e]] = cost;
    heap.push(cost + heur(lat, lon), labels.length - 1);
  }

  // Getting off: at the near junction of an edge, then along it to the snapped point.
  final goals = <int, _Goal>{};
  for (final f in to.edges) {
    final frac = _alongEdge(f);
    final vertex = f.chunk.ids[f.vi];
    final cost = _edgeCost(f.chunk, f.e, modeName, frac);
    final had = goals[vertex];
    if (had == null || had.cost > cost) goals[vertex] = _Goal(cost, f, frac);
  }

  // Both points on the same stretch of road, in travel order.
  _Finish? bestFinish;
  var bestTotal = double.infinity;
  for (final a in from.edges) {
    for (final b in to.edges) {
      if (identical(a.chunk, b.chunk) && a.e == b.e) {
        final fa = _alongEdge(a);
        final fb = _alongEdge(b);
        if (fb >= fa) {
          final c = _edgeCost(a.chunk, a.e, modeName, fb - fa);
          if (c < bestTotal) {
            bestTotal = c;
            bestFinish = _Finish.direct(a, fa, fb);
          }
        }
      }
    }
  }

  var steps = 0;
  while (heap.isNotEmpty) {
    final labelIndex = heap.pop();
    final label = labels[labelIndex];
    final vertex = label.vertex;
    final g = label.g;
    if (g + heur(label.lat, label.lon) / _greed >= bestTotal) break;
    if (label.closed) continue;
    label.closed = true;

    final goal = goals[vertex];
    if (goal != null && g + goal.cost < bestTotal) {
      bestTotal = g + goal.cost;
      bestFinish = _Finish.at(labelIndex, goal.part, goal.frac);
    }

    if (++steps % 512 == 0) {
      if (watch.elapsedMilliseconds > timeLimitMs) return _Run(bestFinish, labels);
      if (shouldStop?.call() ?? false) return _Run(null, labels, stopped: true);
      // Lets a newer request or a cancel get a word in.
      await Future<void>.delayed(Duration.zero);
    }

    final far = hierarchy && metres(label.lat, label.lon, from.lat, from.lon) > mode.near && metres(label.lat, label.lon, to.lat, to.lon) > mode.near;

    final entry = far ? graph._majorEntry(label.lat, label.lon) : graph._localEntry(label.lat, label.lon);
    // Off the main roads while far from both ends, or off the file: nothing to follow from here.
    if (entry == null) continue;
    final chunk = await graph._load(entry);
    final vi = _vertexIndex(chunk, vertex);
    if (vi < 0) continue;

    final rules = modeName == 'car' ? chunk.restrictions[vertex] : null;
    int? onlyTo;
    if (rules != null) {
      for (final r in rules) {
        if (r.only && r.from == label.from) onlyTo = r.to;
      }
    }

    for (var e = chunk.start[vi]; e < chunk.start[vi + 1]; e++) {
      if (chunk.bits[e] & mode.bit == 0) continue;
      final target = chunk.to[e];
      if (rules != null) {
        if (onlyTo != null && target != onlyTo) continue;
        if (rules.any((r) => !r.only && r.from == label.from && r.to == target)) continue;
      }
      final cost = g + _edgeCost(chunk, e, modeName);
      final end = chunk.shapeStart[e + 1];
      final tLat = chunk.shape[end - 2] * 1e-6;
      final tLon = chunk.shape[end - 1] * 1e-6;
      // A junction with rules is kept once per way in, since the rules depend on it. That is only
      // known here for junctions in this chunk; one just over a chunk's edge still obeys its rules
      // when reached, but keeps only its best way in.
      final key = stateKey(target, vertex, chunk.restrictions.containsKey(target));
      final had = bestAt[key];
      if (had != null && had <= cost) continue;
      bestAt[key] = cost;
      labels.add(_Label(vertex: target, lat: tLat, lon: tLon, g: cost, prev: labelIndex, from: vertex, chunk: chunk, e: e));
      heap.push(cost + heur(tLat, tLon), labels.length - 1);
    }
  }
  return _Run(bestFinish, labels);
}

/* ---- from the search to something to follow ---- */

void _pushPoint(List<List<double>> coords, double lon, double lat) {
  if (coords.isEmpty || coords.last[0] != lon || coords.last[1] != lat) coords.add([lon, lat]);
}

// One stretch of road along the route, in order.
List<List<double>> _edgePoints(Chunk chunk, int vi, int e, double fromFrac, double toFrac) {
  final pts = <List<double>>[
    [chunk.lon[vi] * 1e-6, chunk.lat[vi] * 1e-6],
  ];
  for (var p = chunk.shapeStart[e]; p < chunk.shapeStart[e + 1]; p += 2) {
    pts.add([chunk.shape[p + 1] * 1e-6, chunk.shape[p] * 1e-6]);
  }
  if (fromFrac <= 0 && toFrac >= 1) return pts;

  final lengths = <double>[0];
  for (var i = 1; i < pts.length; i++) {
    lengths.add(lengths[i - 1] + metres(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]));
  }
  final total = lengths.last != 0 ? lengths.last : 1.0;
  List<double> at(double frac) {
    final d = frac * total;
    for (var i = 1; i < pts.length; i++) {
      if (lengths[i] >= d) {
        final span = lengths[i] - lengths[i - 1];
        final t = (d - lengths[i - 1]) / (span != 0 ? span : 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      }
    }
    return pts.last;
  }

  final out = <List<double>>[at(fromFrac)];
  for (var i = 1; i < pts.length - 1; i++) {
    if (lengths[i] > fromFrac * total && lengths[i] < toFrac * total) out.add(pts[i]);
  }
  out.add(at(toFrac));
  return out;
}

String _turnVerb(num angle) {
  final a = angle.abs();
  final side = angle < 0 ? 'left' : 'right';
  if (a < 25) return 'Continue';
  if (a < 50) return 'Keep $side';
  if (a < 125) return 'Turn $side';
  if (a < 165) return 'Turn sharp $side';
  return 'Make a U-turn';
}

String stepText(RouteStep step) {
  final onto = step.name.isNotEmpty ? ' onto ${step.name}' : '';
  switch (step.type) {
    case 'depart':
      return step.name.isNotEmpty ? 'Head ${step.compass} on ${step.name}' : 'Head ${step.compass}';
    case 'arrive':
      return 'You have arrived';
    case 'roundabout':
      return 'At the roundabout, take exit ${step.exit}$onto';
    case 'ramp':
      return 'Take the ramp$onto';
    case 'ferry':
      return 'Take the ferry${step.name.isNotEmpty ? ': ${step.name}' : ''}';
    case 'continue':
      return step.name.isNotEmpty ? 'Continue onto ${step.name}' : 'Continue';
    default:
      return '${_turnVerb(step.angle ?? 90)}$onto';
  }
}

const double _shortestStepM = 15;
const List<String> compassPoints = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
String _compassOf(double deg) => compassPoints[(deg / 45).round() % 8];

double _headingOut(List<List<double>> pts) => _bearing(pts[0][1], pts[0][0], pts[1][1], pts[1][0]);
double _headingIn(List<List<double>> pts) {
  final n = pts.length;
  return _bearing(pts[n - 2][1], pts[n - 2][0], pts[n - 1][1], pts[n - 1][0]);
}

class _Leg {
  _Leg(this.pts, this.index, this.name, this.cls, this.link, this.roundabout, this.distance, this.duration, this.branches);
  final List<List<double>> pts;
  final int index;
  final String name;
  final int cls;
  final bool link;
  final bool roundabout;
  final double distance;
  final double duration;
  final int branches;
}

class _Step {
  _Step(this.type, this.name, this.at, this.index, {this.angle, this.exit = 0, this.compass = ''});
  final String type;
  String name;
  final List<double> at;
  final int index;
  final int? angle;
  int exit;
  final String compass;
  double distance = 0;
  double duration = 0;
}

List<RouteStep> _buildSteps(List<_Leg> legs) {
  final steps = <_Step>[];
  _Step? current;
  void close() {
    if (current != null) steps.add(current!);
    current = null;
  }

  for (var i = 0; i < legs.length; i++) {
    final leg = legs[i];
    final prev = i > 0 ? legs[i - 1] : null;
    if (prev == null) {
      current = _Step('depart', leg.name, leg.pts[0], leg.index, compass: _compassOf(_headingOut(leg.pts)));
    } else {
      final angle = ((_headingOut(leg.pts) - _headingIn(prev.pts) + 540) % 360) - 180;
      final renamed = leg.name != prev.name;
      final entering = leg.roundabout && !prev.roundabout;
      final leaving = !leg.roundabout && prev.roundabout;
      final onRamp = leg.link && !prev.link;
      final ferry = leg.cls == _classFerry && prev.cls != _classFerry;

      if (leg.roundabout && prev.roundabout) {
        // Going round: counted, not announced.
        if (current?.type == 'roundabout' && leg.branches > 1) current!.exit++;
      } else if (entering) {
        close();
        current = _Step('roundabout', '', leg.pts[0], leg.index, exit: 1);
      } else if (leaving) {
        if (current?.type == 'roundabout') current!.name = leg.name;
      } else if (ferry) {
        close();
        current = _Step('ferry', leg.name, leg.pts[0], leg.index);
      } else if (onRamp) {
        close();
        current = _Step('ramp', leg.name, leg.pts[0], leg.index);
      } else if (angle.abs() >= (renamed ? 35 : 60) && (leg.branches > 2 || renamed)) {
        // Along one street, only a real corner is worth a line. A path bending round a planter isn't.
        close();
        current = _Step('turn', leg.name, leg.pts[0], leg.index, angle: angle.round());
      } else if (renamed && leg.name.isNotEmpty) {
        close();
        current = _Step('continue', leg.name, leg.pts[0], leg.index, angle: angle.round());
      }
    }
    current!.distance += leg.distance;
    current!.duration += leg.duration;
  }
  close();

  // A step shorter than this can't be followed as its own instruction, and is usually a kerb or a
  // crossing: it goes into the one before.
  for (var i = steps.length - 1; i > 0; i--) {
    final s = steps[i];
    if (s.distance < _shortestStepM && (s.type == 'turn' || s.type == 'continue')) {
      steps[i - 1].distance += s.distance;
      steps[i - 1].duration += s.duration;
      steps.removeAt(i);
    }
  }
  // Two steps left next to each other saying the same thing become one.
  for (var i = steps.length - 1; i > 0; i--) {
    final s = steps[i];
    if (s.type == 'continue' && s.name == steps[i - 1].name) {
      steps[i - 1].distance += s.distance;
      steps[i - 1].duration += s.duration;
      steps.removeAt(i);
    }
  }

  final last = legs.last;
  steps.add(_Step('arrive', '', last.pts.last, last.index + last.pts.length - 1));
  return steps.map((s) {
    final step = RouteStep(type: s.type, name: s.name, distance: s.distance.round(), duration: s.duration.round(), at: s.at, index: s.index, angle: s.angle, exit: s.exit, compass: s.compass);
    step.text = stepText(step);
    return step;
  }).toList();
}

/// Finds the way. Answers a route, or null when there isn't one.
Future<RouteResult?> findRoute(RouteGraph graph, LatLon from, LatLon to, String modeName, {bool Function()? shouldStop, int timeLimitMs = 25000}) async {
  final a = await graph.snap(from.lat, from.lon, modeName);
  final b = await graph.snap(to.lat, to.lon, modeName);
  if (a == null || b == null) return null;

  var run = await _search(graph, a, b, modeName, hierarchy: true, timeLimitMs: timeLimitMs, shouldStop: shouldStop);
  if (run.stopped) return null;
  // The main roads alone didn't connect them: every road, this once.
  if (run.finish == null) {
    run = await _search(graph, a, b, modeName, hierarchy: false, timeLimitMs: timeLimitMs, shouldStop: shouldStop);
    if (run.stopped || run.finish == null) return null;
  }
  final finish = run.finish!;
  final labels = run.labels;

  final legs = <_Leg>[];
  final coords = <List<double>>[];

  void addLeg(Chunk chunk, int vi, int e, double fromFrac, double toFrac) {
    final pts = _edgePoints(chunk, vi, e, fromFrac, toFrac);
    final span = toFrac - fromFrac;
    final index = math.max(0, coords.length - 1);
    for (final p in pts) {
      _pushPoint(coords, p[0], p[1]);
    }
    var branches = 0;
    for (var k = chunk.start[vi]; k < chunk.start[vi + 1]; k++) {
      if (chunk.bits[k] & travelModes[modeName]!.bit != 0) branches++;
    }
    legs.add(_Leg(pts, index, chunk.names[chunk.name[e]], chunk.cls[e] & 15, chunk.cls[e] & 16 != 0, chunk.cls[e] & 32 != 0, chunk.len[e] * span, _edgeSeconds(chunk, e, modeName, span), branches));
  }

  if (finish.direct) {
    addLeg(finish.part.chunk, finish.part.vi, finish.part.e, finish.fa, finish.fb);
  } else {
    // Walk the labels back from the end.
    final chain = <_Label>[];
    for (var i = finish.label; i != -1; i = labels[i].prev) {
      chain.insert(0, labels[i]);
    }
    final first = chain[0].startPart!;
    addLeg(first.chunk, first.vi, first.e, chain[0].frac, 1);
    for (var i = 1; i < chain.length; i++) {
      final chunk = chain[i].chunk!;
      final vi = _vertexIndex(chunk, chain[i - 1].vertex);
      addLeg(chunk, vi, chain[i].e, 0, 1);
    }
    addLeg(finish.part.chunk, finish.part.vi, finish.part.e, 0, finish.frac);
  }

  final usable = legs.where((l) => l.pts.length >= 2 && l.distance >= 0).toList();
  if (usable.isEmpty) return null;
  return RouteResult(
    source: 'offline',
    mode: modeName,
    distance: usable.fold<double>(0, (n, l) => n + l.distance).round(),
    duration: usable.fold<double>(0, (n, l) => n + l.duration).round(),
    coords: coords,
    steps: _buildSteps(usable),
  );
}

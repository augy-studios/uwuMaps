// Public transport on the map: Singapore's and Malaysia's snapshots that ship with the app, Malaysia's
// live vehicles, the cards a tapped marker opens, and searching the snapshots. A port of
// main-site/js/transit.js. The live feed needs a connection, and the rest works offline.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import '../core/config.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../map/map_service.dart';
import 'doors.dart';

const Duration _liveRefresh = Duration(seconds: 20);
const String sgBus = 'https://sgbus.uwuapps.org';
const String malaysiaSite = 'https://malaysia.uwuapps.org';

const List<double> _sgArea = [103.5, 1.1, 104.2, 1.55];
const List<double> _myArea = [99.0, 0.7, 119.5, 7.6];
// Singapore, short of the Johor shore. A view wholly inside this has nothing of Malaysia's to show.
const List<double> _sgOnly = [103.59, 1.15, 104.1, 1.46];

class _BusFeed {
  const _BusFeed(this.feed, this.area);
  final String feed;
  final List<double> area;
}

const List<_BusFeed> _busFeeds = [
  _BusFeed('rapid-bus-kl', [100.9, 2.5, 102.2, 3.7]),
  _BusFeed('rapid-bus-mrtfeeder', [101.2, 2.7, 102.0, 3.5]),
  _BusFeed('rapid-bus-penang', [99.9, 4.8, 100.9, 6.0]),
  _BusFeed('mybas-johor', [103.3, 1.2, 104.3, 2.0]),
];

const List<String> clickLayers = ['my-live-trains', 'my-live-buses', 'sg-stations', 'my-stations', 'sg-exits', 'sg-stops', 'my-stops'];

String fold(String s) => unorm.nfkd(s).replaceAll(RegExp(r'\p{M}', unicode: true), '').toLowerCase();

Map<String, dynamic> _fc(List<Object> features) => {'type': 'FeatureCollection', 'features': features};
Map<String, dynamic> _point(num lon, num lat, Map<String, Object?> properties) => {
      'type': 'Feature',
      'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
      'properties': properties,
    };

String _lineOfCode(String code) => code.replaceFirst(RegExp(r'\d.*$'), '');

// Parsing and shaping happen off the main thread, as these files are large.
Map<String, dynamic> _shapeSgRail(String text) {
  final rail = jsonDecode(text) as Map<String, dynamic>;
  final colour = {for (final l in rail['lines'] as List<dynamic>) (l as Map<String, dynamic>)['code'] as String: l['color'] as String};
  final lines = <Object>[];
  (rail['tracks'] as Map<String, dynamic>).forEach((code, paths) {
    for (final path in paths as List<dynamic>) {
      lines.add({
        'type': 'Feature',
        'geometry': {
          'type': 'LineString',
          'coordinates': (path as List<dynamic>).map((p) => [(p as List<dynamic>)[1], p[0]]).toList(),
        },
        'properties': {'color': colour[code] ?? '#888888', 'code': code},
      });
    }
  });
  final stations = <Object>[];
  final exits = <Object>[];
  final index = <Map<String, Object?>>[];
  for (final raw in rail['stations'] as List<dynamic>) {
    final s = raw as Map<String, dynamic>;
    final codes = (s['codes'] as List<dynamic>).cast<String>();
    final c = colour[_lineOfCode(codes.first)] ?? '#888888';
    stations.add(_point(s['lng'] as num, s['lat'] as num, {'kind': 'sg-station', 'name': s['name'], 'codes': codes.join(' '), 'color': c}));
    index.add({'name': s['name'], 'codes': codes, 'lat': s['lat'], 'lon': s['lng']});
    for (final e in (s['exits'] as List<dynamic>?) ?? const []) {
      final pair = e as List<dynamic>;
      exits.add(_point(pair[1] as num, pair[0] as num, {'kind': 'sg-exit', 'name': '${s['name']} exit', 'color': c}));
    }
  }
  return {'lines': _fc(lines), 'stations': _fc(stations), 'exits': _fc(exits), 'index': index};
}

Map<String, dynamic> _shapeSgStops(String text) {
  final stops = jsonDecode(text) as List<dynamic>;
  return {
    'fc': _fc([
      for (final s in stops) _point((s as Map<String, dynamic>)['lo'] as num, s['la'] as num, {'kind': 'sg-stop', 'name': s['n'], 'code': s['c'], 'road': s['r']}),
    ]),
    'index': stops,
  };
}

Map<String, dynamic> _shapeMy(String text) {
  final d = jsonDecode(text) as Map<String, dynamic>;
  return {
    'lines': _fc([
      for (final l in d['lines'] as List<dynamic>)
        {
          'type': 'Feature',
          'geometry': {
            'type': 'LineString',
            'coordinates': ((l as Map<String, dynamic>)['path'] as List<dynamic>).map((p) => [(p as List<dynamic>)[1], p[0]]).toList(),
          },
          'properties': {'color': l['color'], 'name': l['name']},
        },
    ]),
    'stations': _fc([
      for (final s in d['stations'] as List<dynamic>) _point((s as Map<String, dynamic>)['lng'] as num, s['lat'] as num, {'kind': 'my-station', 'name': s['name'], 'agency': s['agency'], 'lines': (s['lines'] as List<dynamic>).join(', '), 'color': s['color']}),
    ]),
    'stops': _fc([
      for (final s in d['busStops'] as List<dynamic>) _point((s as Map<String, dynamic>)['lo'] as num, s['la'] as num, {'kind': 'my-stop', 'name': s['n'], 'agency': s['a']}),
    ]),
    'index': d['stations'],
  };
}

class Transit extends ChangeNotifier {
  Transit(this.map);
  final MapService map;

  final Set<String> _loaded = {};
  List<Map<String, Object?>> _sgStationIndex = const [];
  List<dynamic> _sgStopIndex = const [];
  List<dynamic> _myStationIndex = const [];
  List<dynamic>? _doorPlatforms;
  Timer? _liveTimer;
  String liveStatus = '';
  bool _foreground = true;
  List<double>? _bounds;

  static Future<String> _asset(String name) => rootBundle.loadString('assets/data/$name.json');

  static bool _touches(List<double> b, List<double> area) => b[0] < area[2] && b[2] > area[0] && b[1] < area[3] && b[3] > area[1];

  bool _inMalaysia(List<double> b) {
    if (!_touches(b, _myArea)) return false;
    return !(b[0] >= _sgOnly[0] && b[2] <= _sgOnly[2] && b[1] >= _sgOnly[1] && b[3] <= _sgOnly[3]);
  }

  Future<void> _loadSgRail() async {
    final d = await compute(_shapeSgRail, await _asset('sg-rail'));
    _sgStationIndex = (d['index'] as List<dynamic>).cast<Map<String, Object?>>();
    await map.setData('sg-lines', d['lines'] as Map<String, dynamic>);
    await map.setData('sg-stations', d['stations'] as Map<String, dynamic>);
    await map.setData('sg-exits', d['exits'] as Map<String, dynamic>);
  }

  Future<void> _loadSgStops() async {
    final d = await compute(_shapeSgStops, await _asset('sg-bus-stops'));
    _sgStopIndex = d['index'] as List<dynamic>;
    await map.setData('sg-stops', d['fc'] as Map<String, dynamic>);
  }

  Future<void> _loadMy() async {
    final d = await compute(_shapeMy, await _asset('my-transit'));
    _myStationIndex = d['index'] as List<dynamic>;
    await map.setData('my-lines', d['lines'] as Map<String, dynamic>);
    await map.setData('my-stations', d['stations'] as Map<String, dynamic>);
    await map.setData('my-stops', d['stops'] as Map<String, dynamic>);
  }

  /// Loads what's on, where it's wanted. Called whenever the map stops moving.
  Future<void> loadVisible() async {
    final b = await map.visibleBounds();
    if (b == null) return;
    _bounds = b;
    final zoom = map.camera.zoom;
    final inSg = _touches(b, _sgArea);
    final inMy = _inMalaysia(b);
    try {
      if (inSg && !_loaded.contains('sg') && (map.isOn('sg-lines') || map.isOn('sg-stations') || map.isOn('sg-exits'))) {
        _loaded.add('sg');
        await _loadSgRail();
      }
      if (inSg && !_loaded.contains('sg-stops') && map.isOn('sg-stops') && zoom >= 13) {
        _loaded.add('sg-stops');
        await _loadSgStops();
      }
      if (inMy && !_loaded.contains('my') && (map.isOn('my-lines') || map.isOn('my-stations') || (map.isOn('my-stops') && zoom >= 13))) {
        _loaded.add('my');
        await _loadMy();
      }
    } catch (err) {
      debugPrint('Transport layers: $err');
      _loaded.clear();
    }
    unawaited(refreshLive());
  }

  void setForeground(bool on) {
    _foreground = on;
    if (on) {
      unawaited(refreshLive());
    } else {
      _liveTimer?.cancel();
    }
  }

  Future<Map<String, dynamic>> _fetchFeed(String feed) async {
    final res = await Net.get(Uri.parse('$apiOrigin/api/my-live?feed=$feed'));
    if (res.statusCode != 200) throw Exception('The live feed answered ${res.statusCode}');
    return Net.decode(res) as Map<String, dynamic>;
  }

  List<Object> _vehicles(Map<String, dynamic> body, String kind) => [
        for (final raw in body['vehicles'] as List<dynamic>)
          () {
            final v = raw as Map<String, dynamic>;
            return _point(v['lon'] as num, v['lat'] as num, {
              'kind': kind,
              'id': v['id'] ?? '',
              'route': v['route'] ?? '',
              'at': v['at'] ?? 0,
              'feed': body['feed'],
              if (v['bearing'] != null) 'bearing': v['bearing'],
            });
          }(),
      ];

  Future<void> refreshLive() async {
    _liveTimer?.cancel();
    final b = _bounds;
    if (b == null) return;
    final wantTrains = map.isOn('my-live-trains');
    final wantBuses = map.isOn('my-live-buses');
    final inMy = _inMalaysia(b);
    final zoom = map.camera.zoom;
    var status = '';

    if ((wantTrains || wantBuses) && inMy && Net.online.value && _foreground) {
      final jobs = <Future<void>>[];
      if (wantTrains && zoom >= 6) {
        jobs.add(_fetchFeed('ktmb').then((body) => map.setData('my-live-trains', _fc(_vehicles(body, 'my-live-train')))));
      }
      if (wantBuses && zoom >= 9) {
        final feeds = _busFeeds.where((f) => _touches(b, f.area)).toList();
        if (feeds.isNotEmpty) {
          jobs.add(() async {
            var failures = 0;
            final features = <Object>[];
            await Future.wait(feeds.map((f) async {
              try {
                features.addAll(_vehicles(await _fetchFeed(f.feed), 'my-live-bus'));
              } catch (_) {
                failures++;
              }
            }));
            await map.setData('my-live-buses', _fc(features));
            if (failures == feeds.length) throw Exception('No feed answered');
          }());
        }
      }
      var failed = false;
      await Future.wait(jobs.map((j) => j.catchError((Object _) {
            failed = true;
          })));
      if (failed) status = "Can't reach the live feed right now.";
    } else if (!Net.online.value) {
      status = 'Live vehicles need a connection.';
      unawaited(map.setData('my-live-trains', emptyCollection()));
      unawaited(map.setData('my-live-buses', emptyCollection()));
    }
    if (status != liveStatus) {
      liveStatus = status;
      notifyListeners();
    }
    if (_foreground) _liveTimer = Timer(_liveRefresh, refreshLive);
  }

  /* ---- the cards ---- */

  Future<List<DoorSlide>> doorsFor(List<String> codes) async {
    try {
      _doorPlatforms ??= ((await compute(jsonDecode, await _asset('sg-mrt-doors'))) as Map<String, dynamic>)['platforms'] as List<dynamic>? ?? const [];
      return stationPlatforms(codes, _doorPlatforms!);
    } catch (err) {
      debugPrint('Doors: $err');
      return const [];
    }
  }

  static String _encodeName(String name) => Uri.encodeComponent(name).replaceAllMapped(RegExp(r"[!'()*~]"), (m) => '%${m[0]!.codeUnitAt(0).toRadixString(16).toUpperCase()}');

  static String _sgTransitLink(double lat, double lon, String name) => '$sgBus/#nav/here/${lat.toStringAsFixed(5)},${lon.toStringAsFixed(5)}~${_encodeName(name)}';

  Place? _cardFor(Map<String, dynamic> feature) {
    final p = Map<String, dynamic>.from(feature['properties'] as Map);
    final coords = (feature['geometry'] as Map)['coordinates'] as List<dynamic>;
    final lon = (coords[0] as num).toDouble();
    final lat = (coords[1] as num).toDouble();
    final name = (p['name'] ?? '').toString();
    switch (p['kind']) {
      case 'sg-station':
        final codes = (p['codes'] as String).split(' ');
        return Place(name: name, lat: lat, lon: lon, sub: '${codes.join(' · ')} · Train station', doorCodes: codes, links: [PlaceLink(_sgTransitLink(lat, lon, '$name MRT'), 'Go by public transport', 'train')]);
      case 'sg-exit':
        return Place(name: name, lat: lat, lon: lon, sub: 'Station exit', links: [PlaceLink(_sgTransitLink(lat, lon, name), 'Go by public transport', 'train')]);
      case 'sg-stop':
        return Place(name: name, lat: lat, lon: lon, sub: '${p['code']} · ${p['road']} · Bus stop', links: [
          PlaceLink(_sgTransitLink(lat, lon, name), 'Go by public transport', 'train'),
          PlaceLink('$sgBus/#${Uri.encodeComponent('${p['code']}')}', 'Bus timings', 'bus'),
        ]);
      case 'my-station':
        return Place(name: name, lat: lat, lon: lon, sub: '${p['agency']} · ${p['lines']}', links: const [PlaceLink('$malaysiaSite/trains/', 'Train schedules', 'train')]);
      case 'my-stop':
        return Place(name: name, lat: lat, lon: lon, sub: '${p['agency']} · Bus stop', links: const [PlaceLink('$malaysiaSite/bus/', 'Bus routes', 'bus')]);
      case 'my-live-train':
      case 'my-live-bus':
        final train = p['kind'] == 'my-live-train';
        final at = (p['at'] as num?) ?? 0;
        final when = at != 0 ? 'Seen ${((DateTime.now().millisecondsSinceEpoch / 1000 - at) / 60).round().clamp(0, 1 << 31)} min ago' : '';
        final route = '${p['route'] ?? ''}';
        final id = '${p['id'] ?? ''}';
        return Place(
          name: '${train ? 'Train' : 'Bus'}${route.isNotEmpty ? ' $route' : ''}',
          lat: lat,
          lon: lon,
          sub: [if (id.isNotEmpty) 'Vehicle $id', if (when.isNotEmpty) when].join(' · '),
          links: [PlaceLink('$malaysiaSite/${train ? 'trains' : 'bus'}/', 'Live ${train ? 'trains' : 'buses'}', train ? 'train' : 'bus')],
        );
    }
    return null;
  }

  /// The card for whatever transport marker is at this point, or null.
  Future<Place?> cardAt(Offset point) async {
    final layers = clickLayers.where(map.isOn).toList();
    final hits = await map.queryBox(point, 6, layers);
    for (final hit in hits) {
      if (hit['properties'] == null) continue;
      final card = _cardFor(hit);
      if (card != null) return card;
    }
    return null;
  }

  /* ---- searching the shipped data ---- */

  Future<List<Place>> search(String query) async {
    final q = fold(query.trim());
    if (q.length < 2) return const [];
    final b = _bounds ?? await map.visibleBounds();
    final ranked = <MapEntry<int, Place>>[];
    void add(String name, String sub, num lat, num lon, int rank) => ranked.add(MapEntry(rank, Place(name: name, sub: sub, lat: lat.toDouble(), lon: lon.toDouble(), source: 'transit')));
    try {
      if (b == null || _touches(b, _sgArea)) {
        if (_sgStationIndex.isEmpty) await _loadSgRail();
        for (final s in _sgStationIndex) {
          final codes = (s['codes'] as List<dynamic>).cast<String>();
          if (fold(s['name'] as String).contains(q) || codes.any((c) => fold(c) == q)) add(s['name'] as String, '${codes.join(' · ')} · Train station', s['lat'] as num, s['lon'] as num, 0);
        }
        if (_sgStopIndex.isEmpty) await _loadSgStops();
        for (final raw in _sgStopIndex) {
          final s = raw as Map<String, dynamic>;
          final code = s['c'].toString();
          if (code == q || fold(s['n'] as String).contains(q)) add(s['n'] as String, '$code · ${s['r']} · Bus stop', s['la'] as num, s['lo'] as num, code == q ? 0 : 2);
        }
      }
      if (b != null && _inMalaysia(b)) {
        if (_myStationIndex.isEmpty) await _loadMy();
        for (final raw in _myStationIndex) {
          final s = raw as Map<String, dynamic>;
          if (fold(s['name'] as String).contains(q)) add(s['name'] as String, '${s['agency']} · Train station', s['lat'] as num, s['lng'] as num, 1);
        }
      }
    } catch (err) {
      debugPrint('Transit search: $err');
    }
    final indexed = ranked.asMap().entries.toList()
      ..sort((x, y) {
        final c = x.value.key - y.value.key;
        return c != 0 ? c : x.key - y.key;
      });
    return indexed.take(8).map((e) => e.value.value).toList();
  }
}

// Saved places, and syncing them between devices with a code. Places live on the device first. Each
// carries when it last changed, and a deleted one stays as a marker for a while, so two devices merging
// can tell "deleted there" from "not added here yet". The same format as the website's, so the two sync.

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show Offset;

import 'package:flutter/foundation.dart';

import '../core/config.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import '../map/map_service.dart';

const String _placesKey = 'uwumaps.places';
const String _syncKey = 'uwumaps.syncCode';
const String defaultList = 'Saved';
const String _alphabet = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const int syncCodeLength = 12;

// In step with main-site's roundCoord + `${}`: the id is how the two platforms know a place is the same.
String placeId(LatLon p) => '${coordText(p.lat)},${coordText(p.lon)}';

class Places extends ChangeNotifier {
  Places(this.map);
  final MapService map;

  Map<String, dynamic> _places = Prefs.readJson<Map<String, dynamic>>(_placesKey, {});
  Timer? _syncTimer;
  String syncState = '';

  Place _fromJson(Map<String, dynamic> p) => Place(name: p['name'] as String, sub: (p['sub'] as String?) ?? '', lat: (p['lat'] as num).toDouble(), lon: (p['lon'] as num).toDouble(), list: p['list'] as String?, source: 'saved');

  List<Place> get saved {
    final list = _places.values.cast<Map<String, dynamic>>().where((p) => p['deleted'] != true && p['name'] != null).map(_fromJson).toList();
    list.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return list;
  }

  List<String> get lists => ({for (final p in saved) p.list ?? defaultList}.toList()..sort());

  bool isSaved(LatLon p) {
    final hit = _places[placeId(p)] as Map<String, dynamic>?;
    return hit != null && hit['deleted'] != true;
  }

  void _persist() {
    Prefs.writeJson(_placesKey, _places);
    _scheduleSync();
    drawPins();
    notifyListeners();
  }

  void save(Place p, [String list = defaultList]) {
    _places[placeId(p)] = {'id': placeId(p), 'name': p.name, 'sub': p.sub, 'lat': roundCoord(p.lat), 'lon': roundCoord(p.lon), 'list': list, 't': DateTime.now().millisecondsSinceEpoch};
    _persist();
  }

  void forget(LatLon p) {
    final id = placeId(p);
    final had = _places[id] as Map<String, dynamic>?;
    if (had != null) _places[id] = {'id': id, 'deleted': true, 't': DateTime.now().millisecondsSinceEpoch, 'lat': had['lat'], 'lon': had['lon'], 'name': had['name']};
    _persist();
  }

  void moveToList(Place p, String list) {
    final had = _places[placeId(p)] as Map<String, dynamic>?;
    if (had == null) return;
    had['list'] = list.trim().isEmpty ? defaultList : list.trim();
    had['t'] = DateTime.now().millisecondsSinceEpoch;
    _persist();
  }

  void drawPins() {
    unawaited(map.setData('saved', {
      'type': 'FeatureCollection',
      'features': [
        for (final p in saved)
          {
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [p.lon, p.lat]},
            'properties': {'id': placeId(p), 'name': p.name},
          },
      ],
    }));
  }

  /// A saved place at this point of the map, or null.
  Future<Place?> savedAt(Offset point) async {
    if (!map.isOn('saved')) return null;
    final hits = await map.queryBox(point, 6, const ['saved']);
    if (hits.isEmpty) return null;
    final props = hits.first['properties'];
    final id = props is Map ? props['id'] : null;
    final p = _places[id] as Map<String, dynamic>?;
    return p == null || p['deleted'] == true ? null : _fromJson(p);
  }

  /* ---- sync ---- */

  String get syncCode => Prefs.getString(_syncKey) ?? '';

  void _setCode(String code) {
    if (code.isEmpty) {
      Prefs.remove(_syncKey);
    } else {
      Prefs.setString(_syncKey, code);
    }
  }

  void _scheduleSync() {
    if (syncCode.isEmpty) return;
    _syncTimer?.cancel();
    _syncTimer = Timer(const Duration(milliseconds: 1500), syncNow);
  }

  void init() {
    drawPins();
    map.onStyleChange(drawPins);
    if (syncCode.isNotEmpty) _scheduleSync();
    Net.online.addListener(() {
      if (Net.online.value) _scheduleSync();
    });
  }

  Future<void> syncNow() async {
    final code = syncCode;
    if (code.isEmpty || !Net.online.value) return;
    try {
      final res = await Net.send('POST', Uri.parse('$apiOrigin/api/sync'), {'code': code, 'places': _places});
      final body = (res.body.isEmpty ? <String, dynamic>{} : Net.decode(res)) as Map<String, dynamic>;
      if (res.statusCode != 200) throw Exception(body['error'] ?? 'The server answered ${res.statusCode}');
      // The server's answer already holds the newest of everything, this device's included.
      _places = (body['places'] as Map<String, dynamic>?) ?? _places;
      Prefs.writeJson(_placesKey, _places);
      drawPins();
      syncState = 'Synced at ${formatClock(DateTime.now())}';
    } catch (err) {
      syncState = '$err'.replaceFirst('Exception: ', '');
    }
    notifyListeners();
  }

  String? startSyncing() {
    if (!Net.online.value) return 'Syncing needs a connection';
    final r = math.Random.secure();
    _setCode(List.generate(syncCodeLength, (_) => _alphabet[r.nextInt(_alphabet.length)]).join());
    syncState = '';
    notifyListeners();
    unawaited(syncNow());
    return null;
  }

  void joinSync(String input) {
    final code = input.toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');
    if (code.length != syncCodeLength || !code.split('').every(_alphabet.contains)) {
      syncState = 'A code is $syncCodeLength letters and numbers.';
      notifyListeners();
      return;
    }
    _setCode(code);
    syncState = '';
    notifyListeners();
    unawaited(syncNow());
  }

  void stopSyncing() {
    _setCode('');
    syncState = '';
    notifyListeners();
  }
}

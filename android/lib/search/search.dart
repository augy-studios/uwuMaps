// Finding places: saved places and public transport first, then the search files of saved packs, then
// Photon when there's a connection. Works with none of the network parts present.

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../core/format.dart';
import '../core/gz.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../packs/pack_files.dart';
import '../packs/pack_store.dart';
import '../transit/transit.dart';

const String _photon = 'https://photon.komoot.io/api/';
const List<String> _kindLabel = ['Place', 'Area', 'Place of interest', 'Stop', 'Street'];

// In step with normalise() in tools/packs/compile-graph.mjs.
String _normalise(String s) => fold(s);
final RegExp _cjk = RegExp('[぀-ヿ㐀-鿿가-힯]');
List<String> _words(String s) => _normalise(s).split(RegExp(r'[^\p{L}\p{N}]+', unicode: true)).where((w) => w.isNotEmpty).toList();

class _Index {
  _Index(this.dataStart, this.dir);
  final int dataStart;
  final Map<String, dynamic> dir;
}

class SearchService {
  SearchService(this.packs, this.transit);
  final PackStore packs;
  final Transit transit;
  final Map<String, Future<_Index>> _indexes = {};

  Future<_Index> _indexOf(InstalledPack pack) => _indexes['${pack.id}/${pack.build}'] ??= () async {
        final head = await PackFiles.read(pack.id, pack.build, 'search', 0, 12);
        final len = ByteData.sublistView(head).getUint32(8, Endian.little);
        final header = jsonDecode(utf8.decode(await gunzip(await PackFiles.read(pack.id, pack.build, 'search', 12, len)))) as Map<String, dynamic>;
        return _Index(12 + len, header['dir'] as Map<String, dynamic>);
      }();

  Future<List<Place>> _searchPack(InstalledPack pack, String query, LatLon? near) async {
    final q = _words(query);
    if (q.isEmpty) return const [];
    final longest = q.reduce((a, b) => b.runes.length > a.runes.length ? b : a);
    final runes = longest.runes.toList();
    final bucket = _cjk.hasMatch(longest) ? String.fromCharCode(runes.first) : String.fromCharCodes(runes.take(2));
    final index = await _indexOf(pack);
    final entry = index.dir[bucket] as List<dynamic>?;
    if (entry == null) return const [];

    final bytes = await gunzip(await PackFiles.read(pack.id, pack.build, 'search', index.dataStart + (entry[0] as num).toInt(), (entry[1] as num).toInt()));
    final text = utf8.decode(bytes, allowMalformed: true);
    final results = <Place>[];
    for (final line in const LineSplitter().convert(text)) {
      if (line.isEmpty) continue;
      final f = line.split('\t');
      if (f.length < 4) continue;
      final name = f[0];
      final hay = _normalise('$name ${f.length > 4 ? f[4] : ''}');
      if (!q.every(hay.contains)) continue;
      final la = double.parse(f[1]);
      final lo = double.parse(f[2]);
      final kind = int.parse(f[3]);
      final folded = _normalise(name);
      final exact = folded == q.join(' ');
      final prefix = folded.startsWith(q.first);
      final dist = near != null ? metresBetween(near.lat, near.lon, la, lo) : 0.0;
      // Close matches beat kinds beat distance, in round numbers so one can't quite swamp the others.
      final score = (exact ? 0.0 : (prefix ? 1000.0 : 2000.0)) + kind * 200 + math.min(600.0, dist / 500);
      results.add(Place(name: name, sub: kind < _kindLabel.length ? _kindLabel[kind] : 'Place', lat: la, lon: lo, score: score, source: 'pack'));
    }
    results.sort((a, b) => a.score.compareTo(b.score));
    return results.take(8).toList();
  }

  Future<List<Place>> _searchOnline(String query, LatLon? near) async {
    final params = {'q': query, 'limit': '8', if (near != null) 'lat': '${near.lat}', if (near != null) 'lon': '${near.lon}'};
    final res = await Net.get(Uri.parse(_photon).replace(queryParameters: params));
    if (res.statusCode != 200) throw Exception('Search answered ${res.statusCode}');
    final body = Net.decode(res) as Map<String, dynamic>;
    final out = <Place>[];
    for (final raw in (body['features'] as List<dynamic>?) ?? const []) {
      final f = raw as Map<String, dynamic>;
      final p = (f['properties'] as Map<String, dynamic>?) ?? const {};
      final c = (f['geometry'] as Map<String, dynamic>)['coordinates'] as List<dynamic>;
      final bits = <String>[];
      for (final key in ['street', 'city', 'state', 'country']) {
        final v = p[key] as String?;
        if (v != null && v.isNotEmpty && v != p['name'] && !bits.contains(v)) bits.add(v);
      }
      final sub = bits.join(', ');
      final name = (p['name'] as String?) ?? (p['street'] as String?) ?? sub;
      if (name.isNotEmpty) out.add(Place(name: name, sub: sub, lat: (c[1] as num).toDouble(), lon: (c[0] as num).toDouble(), source: 'online'));
    }
    return out;
  }

  /// Places matching a query, best first.
  Future<List<Place>> find(String query, {LatLon? near, List<Place> saved = const []}) async {
    final q = _normalise(query.trim());
    final out = <Place>[];
    for (final p in saved) {
      if (_normalise(p.name).contains(q)) out.add(p.copyWith(sub: 'Saved', source: 'saved'));
    }
    out.addAll(await transit.search(query));

    final local = <Place>[];
    await Future.wait(packs.installedList.map((p) async {
      try {
        local.addAll(await _searchPack(p, query, near));
      } catch (err) {
        debugPrint('Searching ${p.id}: $err');
      }
    }));
    local.sort((a, b) => a.score.compareTo(b.score));
    out.addAll(local.take(8));

    if (Net.online.value) {
      try {
        out.addAll(await _searchOnline(query, near));
      } catch (_) {
        // Whatever was found locally still stands.
      }
    }

    // The same place from two sources shows once.
    final seen = <String>{};
    return out.where((r) => seen.add('${_normalise(r.name)}|${r.lat.toStringAsFixed(3)}|${r.lon.toStringAsFixed(3)}')).take(12).toList();
  }
}

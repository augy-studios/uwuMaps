// The router and the PMTiles reader, on the real Singapore pack tests/build-fixture.mjs builds. Their
// answers are compared with the website's JavaScript by tests/flutter/compare-router.mjs.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:uwumaps/core/models.dart';
import 'package:uwumaps/packs/pack_files_io.dart';
import 'package:uwumaps/packs/pack_published.dart';
import 'package:uwumaps/packs/pmtiles.dart';
import 'package:uwumaps/routing/route_core.dart';

const fixture = '../tests/.fixture';

void main() {
  final hasFixture = File('$fixture/singapore.route').existsSync();

  test('finds real routes the way the website does', () async {
    final graph = await RouteGraph.open(FileRanges('$fixture/singapore.route').read);
    const ends = {
      'orchard-marina': [LatLon(1.3048, 103.8318), LatLon(1.2835, 103.8565)],
      'tampines-jurong': [LatLon(1.3521, 103.9448), LatLon(1.3333, 103.7423)],
      'short-walk': [LatLon(1.2905, 103.8520), LatLon(1.2925, 103.8540)],
      'estate-walk': [LatLon(1.3665, 103.8500), LatLon(1.3690, 103.8440)],
    };
    final out = <String, Object?>{};
    for (final e in ends.entries) {
      for (final mode in ['car', 'bike', 'foot']) {
        if (e.key == 'tampines-jurong' && mode == 'foot') continue;
        final watch = Stopwatch()..start();
        final r = await findRoute(graph, e.value[0], e.value[1], mode);
        expect(r, isNotNull, reason: '${e.key} by $mode');
        expect(r!.coords.length, greaterThan(1));
        expect(r.steps.last.type, 'arrive');
        out['${e.key}/$mode'] = {
          'distance': r.distance,
          'duration': r.duration,
          'points': r.coords.length,
          'steps': r.steps.map((s) => s.text).toList(),
          'ms': watch.elapsedMilliseconds,
        };
      }
    }
    File('build/dart-routes.json')
      ..createSync(recursive: true)
      ..writeAsStringSync(jsonEncode(out));
  }, skip: hasFixture ? false : 'Run tests/build-fixture.mjs first', timeout: const Timeout(Duration(minutes: 3)));

  test('walks through void decks, on foot only', () async {
    final graph = await RouteGraph.open(FileRanges('$fixture/singapore.route').read);
    const walks = [
      [LatLon(1.3695, 103.8450), LatLon(1.3725, 103.8475)],
      [LatLon(1.3665, 103.8460), LatLon(1.3720, 103.8440)],
      [LatLon(1.3665, 103.8500), LatLon(1.3690, 103.8440)],
      [LatLon(1.3650, 103.8440), LatLon(1.3710, 103.8455)],
      [LatLon(1.3400, 103.8480), LatLon(1.3370, 103.8520)],
    ];
    bool usesOne(RouteResult r) => r.steps.any((s) => s.name.toLowerCase().contains('void deck'));
    var through = 0;
    for (final w in walks) {
      if (usesOne((await findRoute(graph, w[0], w[1], 'foot'))!)) through++;
      expect(usesOne((await findRoute(graph, w[0], w[1], 'car'))!), isFalse);
    }
    expect(through, greaterThan(0));
  }, skip: hasFixture ? false : 'Run tests/build-fixture.mjs first', timeout: const Timeout(Duration(minutes: 3)));

  test('reads a published pack by range, across its files', () async {
    final server = await HttpServer.bind('127.0.0.1', 0);
    final files = {
      'a': Uint8List.fromList(List.generate(10, (i) => i)),
      'b': Uint8List.fromList(List.generate(5, (i) => 10 + i)),
    };
    final ranges = <String>[];
    server.listen((request) async {
      final body = files[request.uri.pathSegments.last]!;
      final m = RegExp(r'bytes=(\d+)-(\d+)').firstMatch(request.headers.value('range') ?? '')!;
      ranges.add('${request.uri.pathSegments.last} ${m[0]}');
      request.response.statusCode = 206;
      request.response.add(body.sublist(int.parse(m[1]!), int.parse(m[2]!) + 1));
      await request.response.close();
    });
    final reader = PublishedRanges('http://127.0.0.1:${server.port}', const [('a', 10), ('b', 5)]);
    expect(await reader.read(2, 3), [2, 3, 4]);
    expect(await reader.read(8, 4), [8, 9, 10, 11]);
    expect(await reader.read(10, 5), [10, 11, 12, 13, 14]);
    await expectLater(reader.read(14, 5), throwsStateError);
    expect(ranges, ['a bytes=2-4', 'a bytes=8-9', 'b bytes=0-1', 'b bytes=0-4', 'b bytes=4-4']);
    await server.close(force: true);
  });

  test('reads tiles from a real PMTiles pack', () async {
    final base = PmTiles(FileRanges('$fixture/singapore.base').read);
    final buildings = PmTiles(FileRanges('$fixture/singapore.buildings').read);
    // Marina Bay at the zoom each is built to.
    final b = await base.tile(14, 12918, 8132);
    expect(b, isNotNull);
    expect(b!.length, greaterThan(100));
    final c = await buildings.tile(14, 12918, 8132);
    expect(c, isNotNull);
    // Mid-ocean has nothing.
    expect(await base.tile(14, 0, 0), isNull);
    final out = {'base': b.length, 'buildings': c!.length};
    File('build/dart-tiles.json')
      ..createSync(recursive: true)
      ..writeAsStringSync(jsonEncode(out));
  }, skip: hasFixture ? false : 'Run tests/build-fixture.mjs first');

  test('tile ids match the PMTiles spec', () {
    expect(zxyToTileId(0, 0, 0), 0);
    expect(zxyToTileId(1, 0, 0), 1);
    expect(zxyToTileId(1, 0, 1), 2);
    expect(zxyToTileId(1, 1, 1), 3);
    expect(zxyToTileId(1, 1, 0), 4);
    expect(zxyToTileId(2, 0, 0), 5);
    expect(zxyToTileId(12, 3423, 1763), 19078479);
  });
}

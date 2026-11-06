// A small server on this phone's loopback address, which is how MapLibre gets everything it draws. The
// website does this with a custom uwu:// protocol; MapLibre Native reads URLs, so here it's a URL.
//
//   /<token>/base/z/x/y          From a saved pack if one covers the tile, else OpenFreeMap.
//   /<token>/buildings/z/x/y     From a saved pack if one covers the tile, else Overture Maps.
//   /<token>/sprites/ofm*        The map's icons, from the app.
//   /<token>/fonts/<stack>/<r>   The map's fonts, from the app.
//
// It runs in an isolate of its own, so reading and unzipping tiles never holds up the screen. It only
// listens on 127.0.0.1, and the random token keeps other apps on the phone from using it. The port and
// token are kept between runs, so MapLibre's own cache of tiles it's seen stays valid.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../core/config.dart';
import '../core/prefs.dart';
import '../packs/pack_files.dart';
import '../packs/pack_store.dart';
import '../packs/pmtiles.dart';

const String _ofmFallback = 'https://tiles.openfreemap.org/planet/20260930_001001_pt/{z}/{x}/{y}.pbf';
// In step with the release Overture had when this was written. Only used until the catalogue answers.
const String _overtureFallback = '2026-10-21.0';

class TileServer {
  static String _base = '';
  static SendPort? _port;

  static String get baseTiles => '$_base/base/{z}/{x}/{y}';
  static String get buildingTiles => '$_base/buildings/{z}/{x}/{y}';
  static String get sprite => '$_base/sprites/ofm';
  static String get glyphs => '$_base/fonts/{fontstack}/{range}.pbf';

  static Future<void> start(List<InstalledPack> packs) async {
    var token = Prefs.getString('uwumaps.tileToken');
    if (token == null) {
      final r = math.Random.secure();
      token = List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      Prefs.setString('uwumaps.tileToken', token);
    }
    final support = (await getApplicationSupportDirectory()).path;
    final ready = ReceivePort();
    // The app's assets can only be read from this isolate, so the server asks here for each one.
    final assets = ReceivePort();
    assets.listen((message) {
      final ask = message as List<Object>;
      final reply = ask[1] as SendPort;
      rootBundle.load(ask[0] as String).then(
            (data) => reply.send(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes)),
            onError: (Object _) => reply.send(null),
          );
    });
    await Isolate.spawn(
      _serverMain,
      _Init(ready.sendPort, assets.sendPort, token, int.tryParse(Prefs.getString('uwumaps.tilePort') ?? '') ?? 0, support, _packJson(packs)),
      debugName: 'tile server',
    );
    final answer = await ready.first as List<Object>;
    _port = answer[0] as SendPort;
    final port = answer[1] as int;
    Prefs.setString('uwumaps.tilePort', '$port');
    _base = 'http://127.0.0.1:$port/$token';
  }

  static void updatePacks(List<InstalledPack> packs) => _port?.send(_packJson(packs));

  static List<Map<String, dynamic>> _packJson(List<InstalledPack> packs) => packs.map((p) => {...p.toJson(), 'base': PackFiles.archivePath(p.id, p.build, 'base'), 'buildings': PackFiles.archivePath(p.id, p.build, 'buildings')}).toList();
}

class _Init {
  _Init(this.reply, this.assets, this.secret, this.port, this.support, this.packs);
  final SendPort reply;
  final SendPort assets;
  final String secret;
  final int port;
  final String support;
  final List<Map<String, dynamic>> packs;
}

class _OpenPack {
  _OpenPack(Map<String, dynamic> m)
      : bounds = (m['bounds'] as List<dynamic>).map((n) => (n as num).toDouble()).toList(),
        _files = [FileRanges(m['base'] as String), FileRanges(m['buildings'] as String)] {
    base = PmTiles(_files[0].read);
    buildings = PmTiles(_files[1].read);
  }
  final List<double> bounds;
  final List<FileRanges> _files;
  late final PmTiles base;
  late final PmTiles buildings;

  void close() {
    for (final f in _files) {
      f.close();
    }
  }
}

List<double> _tileBounds(int z, int x, int y) {
  final n = math.pow(2, z).toDouble();
  double lat(int t) {
    final v = math.pi * (1 - (2 * t) / n);
    return math.atan((math.exp(v) - math.exp(-v)) / 2) * 180 / math.pi;
  }

  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

bool _contains(List<double> b, List<double> t) => t[0] >= b[0] && t[1] >= b[1] && t[2] <= b[2] && t[3] <= b[3];
bool _overlaps(List<double> b, List<double> t) => t[0] < b[2] && t[2] > b[0] && t[1] < b[3] && t[3] > b[1];

class _Server {
  _Server(this.support);
  final String support;
  final http.Client client = http.Client();
  List<_OpenPack> packs = [];

  String? _ofmTemplate;
  Future<void>? _ofmReady;
  Future<PmTiles>? _overture;

  // Tiles from whichever pack can answer. Whole tiles first: a tile a pack only partly covers is cut
  // off at the pack's edge, so it's only used when there's nothing better.
  Future<Uint8List?> fromPacks(String archive, int z, int x, int y, {required bool whole}) async {
    final t = _tileBounds(z, x, y);
    for (final p in packs) {
      if (!(whole ? _contains(p.bounds, t) : _overlaps(p.bounds, t))) continue;
      try {
        final got = await (archive == 'base' ? p.base : p.buildings).tile(z, x, y);
        if (got != null) return got;
      } catch (err) {
        stderr.writeln('Reading a pack: $err');
      }
    }
    return null;
  }

  File get _ofmFile => File('$support/ofm-template.txt');
  File get _overtureFile => File('$support/overture-release.txt');

  Future<void> _refreshOfm() async {
    _ofmTemplate = await _ofmFile.exists() ? (await _ofmFile.readAsString()).trim() : _ofmFallback;
    try {
      final res = await client.get(Uri.parse('https://tiles.openfreemap.org/planet'), headers: {'User-Agent': userAgent}).timeout(const Duration(seconds: 6));
      if (res.statusCode == 200) {
        final tiles = (jsonDecode(res.body) as Map<String, dynamic>)['tiles'] as List<dynamic>?;
        if (tiles != null && tiles.isNotEmpty) {
          _ofmTemplate = tiles.first as String;
          await _ofmFile.writeAsString(_ofmTemplate!);
        }
      }
    } catch (_) {
      // The last one known.
    }
  }

  Future<Uint8List?> baseTile(int z, int x, int y) async {
    final inPack = await fromPacks('base', z, x, y, whole: true);
    if (inPack != null) return inPack;
    await (_ofmReady ??= _refreshOfm());
    try {
      final url = _ofmTemplate!.replaceAll('{z}', '$z').replaceAll('{x}', '$x').replaceAll('{y}', '$y');
      final res = await client.get(Uri.parse(url), headers: {'User-Agent': userAgent}).timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) return res.bodyBytes;
    } catch (_) {
      // Offline, or nothing there.
    }
    return fromPacks('base', z, x, y, whole: false);
  }

  Future<Uint8List?> fontRange(String stackAndRange) async {
    try {
      final url = Uri.parse('https://tiles.openfreemap.org/fonts/${stackAndRange.split('/').map(Uri.encodeComponent).join('/')}');
      final res = await client.get(url, headers: {'User-Agent': userAgent}).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) return res.bodyBytes;
    } catch (_) {
      // Offline. Those letters don't draw, and everything else does.
    }
    return null;
  }

  Future<PmTiles> _openOverture() async {
    var release = await _overtureFile.exists() ? (await _overtureFile.readAsString()).trim() : _overtureFallback;
    try {
      final res = await client.get(Uri.parse('https://stac.overturemaps.org/catalog.json')).timeout(const Duration(seconds: 8));
      if (res.statusCode == 200) {
        final latest = (jsonDecode(res.body) as Map<String, dynamic>)['latest'];
        if (latest is String && RegExp(r'^\d{4}-\d{2}-\d{2}\.\d+$').hasMatch(latest)) {
          release = latest;
          await _overtureFile.writeAsString(release);
        }
      }
    } catch (_) {
      // The last known release.
    }
    final url = Uri.parse('https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/$release/buildings.pmtiles');
    return PmTiles((offset, length) async {
      final res = await client.get(url, headers: {'Range': 'bytes=$offset-${offset + length - 1}'}).timeout(const Duration(seconds: 20));
      if (res.statusCode != 206 && res.statusCode != 200) throw HttpException('Overture answered ${res.statusCode}');
      return res.bodyBytes;
    });
  }

  Future<Uint8List?> buildingTile(int z, int x, int y) async {
    final inPack = await fromPacks('buildings', z, x, y, whole: true);
    if (inPack != null) return inPack;
    try {
      final archive = await (_overture ??= _openOverture());
      final got = await archive.tile(z, x, y);
      if (got != null) return got;
    } catch (_) {
      // Offline, or a release retired under an app left open: look it up again next time.
      _overture = null;
    }
    return fromPacks('buildings', z, x, y, whole: false);
  }
}

// An asset from the app, asked of the main isolate. Here rootBundle has no bindings, and asking the engine
// directly from a background isolate never reaches its asset handler.
late SendPort _assetsPort;

Future<Uint8List?> _asset(String key) async {
  final answer = ReceivePort();
  _assetsPort.send(<Object>[key, answer.sendPort]);
  final bytes = await answer.first as Uint8List?;
  answer.close();
  return bytes;
}

Future<void> _serverMain(_Init init) async {
  _assetsPort = init.assets;
  final server = _Server(init.support);
  server.packs = init.packs.map(_OpenPack.new).toList();

  HttpServer http_;
  try {
    http_ = await HttpServer.bind(InternetAddress.loopbackIPv4, init.port);
  } on SocketException {
    // Something else took last time's port. MapLibre's cache starts again, and nothing else changes.
    http_ = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  }

  final inbox = ReceivePort();
  inbox.listen((message) {
    for (final p in server.packs) {
      p.close();
    }
    server.packs = (message as List<dynamic>).map((m) => _OpenPack(m as Map<String, dynamic>)).toList();
  });
  init.reply.send(<Object>[inbox.sendPort, http_.port]);

  final tile = RegExp(r'^/([0-9a-f]+)/(base|buildings)/(\d+)/(\d+)/(\d+)$');
  await for (final req in http_) {
    unawaited(_answer(req, server, init.secret, tile));
  }
}

Future<void> _answer(HttpRequest req, _Server server, String secret, RegExp tile) async {
  final res = req.response;
  try {
    final path = Uri.decodeComponent(req.uri.path);
    if (!path.startsWith('/$secret/')) {
      res.statusCode = HttpStatus.forbidden;
      return;
    }
    final m = tile.firstMatch(path);
    if (m != null) {
      final z = int.parse(m[3]!);
      final x = int.parse(m[4]!);
      final y = int.parse(m[5]!);
      final data = m[2] == 'base' ? await server.baseTile(z, x, y) : await server.buildingTile(z, x, y);
      // Nothing there, or nothing reachable: an empty answer rather than an error, which would retry.
      if (data == null) {
        res.statusCode = HttpStatus.noContent;
        res.headers.set('Cache-Control', 'no-store');
        return;
      }
      res.headers.set('Content-Type', 'application/x-protobuf');
      res.headers.set('Cache-Control', 'max-age=86400');
      res.add(data);
      return;
    }
    final rest = path.substring(secret.length + 2);
    if (rest.startsWith('sprites/') || rest.startsWith('fonts/')) {
      final bytes = await _asset('assets/map/$rest');
      if (bytes != null) {
        res.headers.set('Cache-Control', 'max-age=31536000');
        res.headers.contentType = rest.endsWith('.png') ? ContentType('image', 'png') : (rest.endsWith('.json') ? ContentType.json : ContentType('application', 'x-protobuf'));
        res.add(bytes);
        return;
      }
      if (rest.startsWith('fonts/')) {
        // Only the common ranges ship with the app. MapLibre holds a tile until every font range it needs
        // has been answered, and an error isn't an answer, so a range nobody has is answered as empty, or
        // the whole tile would never draw. Online, OpenFreeMap has the rest.
        final online = await server.fontRange(rest.substring('fonts/'.length));
        res.headers.set('Cache-Control', online != null ? 'max-age=604800' : 'no-store');
        if (online != null) {
          res.headers.contentType = ContentType('application', 'x-protobuf');
          res.add(online);
        } else {
          res.statusCode = HttpStatus.noContent;
        }
        return;
      }
    }
    res.statusCode = HttpStatus.notFound;
  } catch (err) {
    stderr.writeln('Tile server, ${req.uri.path}: $err');
    res.statusCode = HttpStatus.notFound;
  } finally {
    await res.close().catchError((_) {});
  }
}

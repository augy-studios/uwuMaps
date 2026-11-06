// Offline packs: what there is, downloading them, and keeping them.
//
// A pack is four files on the repository's `offline-packs` GitHub release. The website has to fetch
// them through /api/mappack, since GitHub's downloads send no CORS headers. The app isn't a web page
// and has no such limit, so it reads the release directly, 4 MiB at a time with range requests. That
// lets a stopped download carry on where it was, and costs the site nothing.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../core/config.dart';
import '../core/device.dart';
import '../core/format.dart';
import '../core/net.dart';
import 'pack_files.dart';
import 'pack_list.dart';

const int _parallel = 4;
const int _tries = 3;

class ReleaseFile {
  const ReleaseFile(this.name, this.size);
  final String name;
  final int size;
}

class CataloguePack {
  CataloguePack(this.id, this.build, this.built, this.size, this.files);
  final String id;
  final String build;
  final String? built;
  final int size;

  /// archive -> its release files, in order.
  final Map<String, List<ReleaseFile>> files;

  int archiveSize(String archive) => files[archive]!.fold(0, (n, f) => n + f.size);

  /// The routing file's pieces on the release, as name and size, in a form an isolate can be sent.
  List<(String, int)> get routeFiles => [for (final f in files['route']!) (f.name, f.size)];
}

class InstalledPack {
  InstalledPack(this.id, this.build, this.built, this.size, this.bounds);
  final String id;
  final String build;
  final String? built;
  final int size;
  final List<double> bounds;

  Map<String, dynamic> toJson() => {'id': id, 'build': build, 'built': built, 'size': size, 'bounds': bounds, 'complete': true};

  static InstalledPack? fromJson(Map<String, dynamic>? j) {
    if (j == null || j['complete'] != true) return null;
    return InstalledPack(j['id'] as String, j['build'] as String, j['built'] as String?, (j['size'] as num).toInt(), (j['bounds'] as List<dynamic>).map((n) => (n as num).toDouble()).toList());
  }
}

class PackDownload {
  PackDownload(this.total);
  final int total;
  int done = 0;
  String? error;
  bool stopping = false;
}

class _StartAgain implements Exception {}

class _Stopped implements Exception {}

class PackStore extends ChangeNotifier {
  final Map<String, InstalledPack> installed = {};
  final Map<String, PackDownload> downloads = {};
  Map<String, CataloguePack> catalogue = {};
  bool catalogueLoaded = false;
  int usedBytes = 0;
  int? freeBytes;

  /// Told when the set of packs on the phone changes, for the tile server.
  void Function(List<InstalledPack>)? onChanged;

  Future<void> init() async {
    await PackFiles.init();
    for (final p in packList) {
      final meta = InstalledPack.fromJson(await PackFiles.readMeta(p.id));
      if (meta != null) installed[p.id] = meta;
    }
  }

  List<InstalledPack> get installedList => installed.values.toList();

  InstalledPack? packAt(double lat, double lon) {
    for (final p in installed.values) {
      final b = p.bounds;
      if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return p;
    }
    return null;
  }

  Future<void> refreshCatalogue() async {
    if (!Net.online.value) return;
    final found = <String, CataloguePack>{};
    var next = 0;
    final ids = packList.map((p) => p.id).toList();
    await Future.wait(List.generate(6, (_) async {
      while (next < ids.length) {
        final id = ids[next++];
        final pack = await _manifest(id);
        if (pack != null) found[id] = pack;
      }
    }));
    catalogue = found;
    catalogueLoaded = true;
    notifyListeners();
  }

  final Map<String, Future<CataloguePack?>> _published = {};

  /// What's published of a pack, for walking with no saved map. Once a run is enough, unless it comes back empty.
  Future<CataloguePack?> published(String id) => _published[id] ??= _manifest(id).then((pack) {
        if (pack == null) _published.remove(id);
        return pack;
      });

  Future<CataloguePack?> _manifest(String id) async {
    try {
      final res = await Net.get(Uri.parse('$packsRelease/$id.json'), timeout: const Duration(seconds: 12));
      if (res.statusCode != 200) return null; // Not built yet.
      final m = Net.decode(res) as Map<String, dynamic>;
      final archives = m['archives'] as Map<String, dynamic>;
      final files = <String, List<ReleaseFile>>{};
      for (final a in packArchives) {
        final entry = archives[a] as Map<String, dynamic>?;
        if (entry == null) return null;
        files[a] = (entry['files'] as List<dynamic>).map((f) => ReleaseFile((f as Map<String, dynamic>)['name'] as String, (f['size'] as num).toInt())).toList();
      }
      final size = files.values.expand((f) => f).fold<int>(0, (n, f) => n + f.size);
      return CataloguePack(id, m['build'].toString(), m['built'] as String?, size, files);
    } catch (err) {
      debugPrint('Pack manifest $id: $err');
      return null;
    }
  }

  Future<void> refreshStorage() async {
    usedBytes = await PackFiles.usedBytes();
    freeBytes = await Device.freeBytes();
    notifyListeners();
  }

  /// A piece's bytes from the release. A file's end isn't a multiple of 4 MiB, so the last piece is short.
  Future<Uint8List> _fetchPiece(ReleaseFile file, int from, int length, PackDownload state) async {
    for (var attempt = 1;; attempt++) {
      if (state.stopping) throw _Stopped();
      try {
        final res = await Net.get(Uri.parse('$packsRelease/${file.name}'), headers: {'Range': 'bytes=$from-${from + length - 1}'}, timeout: const Duration(seconds: 90));
        if (res.statusCode == 404) throw _StartAgain();
        if (res.statusCode == 206) return res.bodyBytes;
        // A server that ignores Range sends the lot: cut out the piece.
        if (res.statusCode == 200) return Uint8List.sublistView(res.bodyBytes, from, math.min(res.bodyBytes.length, from + length));
        throw Exception('The map file answered ${res.statusCode}');
      } catch (err) {
        if (err is _StartAgain || attempt >= _tries) rethrow;
        await Future<void>.delayed(Duration(milliseconds: 800 * (1 << attempt)));
      }
    }
  }

  Future<String?> download(String id) async {
    final info = catalogue[id];
    if (info == null) return "That map isn't available yet";
    if (downloads[id] != null && downloads[id]!.error == null) return null;

    final state = PackDownload(info.size);
    downloads[id] = state;
    notifyListeners();

    String? message;
    try {
      final free = await Device.freeBytes();
      if (free != null && free < info.size) throw Exception('Not enough storage: it needs ${formatBytes(info.size)}');

      final done = await PackFiles.donePieces(id, info.build);
      final jobs = <_PieceJob>[];
      for (final archive in packArchives) {
        var at = 0;
        var n = 0;
        for (final file in info.files[archive]!) {
          for (var from = 0; from < file.size; from += partSize) {
            final bytes = math.min(partSize, file.size - from);
            if (done[archive]?.contains(n) ?? false) {
              state.done += bytes;
            } else {
              jobs.add(_PieceJob(archive, n, file, from, at, bytes));
            }
            at += bytes;
            n++;
          }
        }
      }
      notifyListeners();

      var next = 0;
      var lastDraw = DateTime.now();
      Future<void> saving = Future.value();
      await Future.wait(List.generate(_parallel, (_) async {
        while (next < jobs.length) {
          final job = jobs[next++];
          if (state.stopping) throw _Stopped();
          final bytes = await _fetchPiece(job.file, job.from, job.length, state);
          // Length is checked rather than trusted: a short piece would corrupt the archive for good.
          if (bytes.length != job.length) throw Exception('A piece of the map came back the wrong size');
          await PackFiles.writePiece(id, info.build, job.archive, job.at, bytes);
          (done[job.archive] ??= {}).add(job.n);
          saving = saving.then((_) => PackFiles.saveDonePieces(id, info.build, done));
          state.done += job.length;
          final now = DateTime.now();
          if (now.difference(lastDraw).inMilliseconds >= 200) {
            lastDraw = now;
            notifyListeners();
          }
        }
      }));
      await saving;

      final pack = packList.firstWhere((p) => p.id == id);
      final made = InstalledPack(id, info.build, info.built, info.size, pack.bounds);
      await PackFiles.writeMeta(id, made.toJson());
      installed[id] = made;
      onChanged?.call(installedList);
      await PackFiles.dropOtherBuilds(id, info.build);
      downloads.remove(id);
      message = '${pack.name} is ready to use offline';
    } on _StartAgain {
      // Rebuilt since this started. Look up the new build, and go again at the next press.
      downloads.remove(id);
      await refreshCatalogue();
      message = 'That map was just rebuilt. Press Download to start the new one.';
    } on _Stopped {
      downloads.remove(id);
    } catch (err) {
      state.error = err is Exception ? err.toString().replaceFirst('Exception: ', '') : "Couldn't download that map";
    }
    await refreshStorage();
    notifyListeners();
    return message;
  }

  void stop(String id) {
    downloads[id]?.stopping = true;
    notifyListeners();
  }

  Future<void> remove(String id) async {
    await PackFiles.remove(id);
    installed.remove(id);
    onChanged?.call(installedList);
    await refreshStorage();
    notifyListeners();
  }
}

class _PieceJob {
  _PieceJob(this.archive, this.n, this.file, this.from, this.at, this.length);
  final String archive;
  final int n;
  final ReleaseFile file;

  /// Where in its release file.
  final int from;

  /// Where in the whole archive.
  final int at;
  final int length;
}

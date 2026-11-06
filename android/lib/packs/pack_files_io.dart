// A pack on disk: <support>/packs/<id>/meta.json, and one file per archive under its build's folder,
// each written at its own offsets as pieces arrive. pieces.json says which are done, so a stopped
// download carries on where it was. A new build goes alongside the old one, which stays in use until
// the new one is complete.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import 'pack_list.dart';

/// Reads ranges of one file, one read at a time, as a RandomAccessFile allows. No Flutter in it, so
/// the tile server's and the router's isolates can use it too.
class FileRanges {
  FileRanges(this.path);
  final String path;
  RandomAccessFile? _file;
  Future<void> _queue = Future.value();

  Future<Uint8List> read(int offset, int length) {
    final done = Completer<Uint8List>();
    _queue = _queue.then((_) async {
      try {
        final f = _file ??= await File(path).open();
        await f.setPosition(offset);
        final bytes = await f.read(length);
        done.complete(bytes);
      } catch (err, stack) {
        done.completeError(err, stack);
      }
    });
    return done.future;
  }

  Future<void> close() async {
    await _queue;
    await _file?.close();
    _file = null;
  }
}

class PackFiles {
  static late String _root;
  static final Map<String, FileRanges> _open = {};
  static final Map<String, Future<void>> _writes = {};

  static Future<void> init() async {
    _root = '${(await getApplicationSupportDirectory()).path}/packs';
    await Directory(_root).create(recursive: true);
  }

  static String get root => _root;

  static String archivePath(String id, String build, String archive) => '$_root/$id/$build/$archive';

  static Future<Uint8List> read(String id, String build, String archive, int offset, int length) {
    final path = archivePath(id, build, archive);
    return (_open[path] ??= FileRanges(path)).read(offset, length);
  }

  // Pieces arrive out of order and at once, so each file takes one write at a time.
  static Future<void> writePiece(String id, String build, String archive, int offset, Uint8List bytes) {
    final path = archivePath(id, build, archive);
    final run = (_writes[path] ?? Future<void>.value()).then((_) async {
      final file = File(path);
      await file.parent.create(recursive: true);
      final f = await file.open(mode: FileMode.append);
      try {
        await f.setPosition(offset);
        await f.writeFrom(bytes);
      } finally {
        await f.close();
      }
    });
    _writes[path] = run.catchError((_) {});
    return run;
  }

  static File _piecesFile(String id, String build) => File('$_root/$id/$build/pieces.json');

  static Future<Map<String, Set<int>>> donePieces(String id, String build) async {
    final out = <String, Set<int>>{};
    try {
      final json = jsonDecode(await _piecesFile(id, build).readAsString()) as Map<String, dynamic>;
      for (final e in json.entries) {
        out[e.key] = (e.value as List<dynamic>).map((n) => (n as num).toInt()).toSet();
      }
    } catch (_) {
      // Nothing kept yet.
    }
    return out;
  }

  static Future<void> saveDonePieces(String id, String build, Map<String, Set<int>> done) async {
    final file = _piecesFile(id, build);
    await file.parent.create(recursive: true);
    final temp = File('${file.path}.tmp');
    await temp.writeAsString(jsonEncode(done.map((k, v) => MapEntry(k, v.toList()))));
    await temp.rename(file.path);
  }

  static File _metaFile(String id) => File('$_root/$id/meta.json');

  static Future<Map<String, dynamic>?> readMeta(String id) async {
    try {
      return jsonDecode(await _metaFile(id).readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  static Future<void> writeMeta(String id, Map<String, dynamic> meta) async {
    final file = _metaFile(id);
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode(meta));
  }

  /// The older builds, now that this one is complete.
  static Future<void> dropOtherBuilds(String id, String build) async {
    final dir = Directory('$_root/$id');
    await for (final e in dir.list()) {
      if (e is Directory && !e.path.replaceAll(r'\', '/').endsWith('/$build')) await _closeUnder(e.path);
      if (e is Directory && !e.path.replaceAll(r'\', '/').endsWith('/$build')) await e.delete(recursive: true);
    }
  }

  static Future<void> _closeUnder(String path) async {
    final norm = path.replaceAll(r'\', '/');
    for (final key in _open.keys.toList()) {
      if (key.replaceAll(r'\', '/').startsWith(norm)) await _open.remove(key)?.close();
    }
  }

  static Future<void> remove(String id) async {
    final dir = Directory('$_root/$id');
    await _closeUnder(dir.path);
    if (await dir.exists()) await dir.delete(recursive: true);
  }

  static Future<int> usedBytes() async {
    var total = 0;
    final dir = Directory(_root);
    if (!await dir.exists()) return 0;
    await for (final e in dir.list(recursive: true)) {
      if (e is File) total += await e.length();
    }
    return total;
  }

  static List<String> get ids => packList.map((p) => p.id).toList();
}

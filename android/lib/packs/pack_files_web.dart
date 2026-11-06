// The browser test build keeps packs in memory, for the page's life: enough to run the real download,
// router and search code. On the phone this is pack_files_io.dart.

import 'dart:typed_data';

import 'pack_list.dart';

class PackFiles {
  static final Map<String, Uint8List> _files = {};
  static final Map<String, Map<String, dynamic>> _meta = {};
  static final Map<String, Map<String, Set<int>>> _done = {};

  static Future<void> init() async {}

  static String get root => '';

  static String archivePath(String id, String build, String archive) => '$id/$build/$archive';

  static Future<Uint8List> read(String id, String build, String archive, int offset, int length) async {
    final file = _files[archivePath(id, build, archive)];
    if (file == null) throw StateError('No such file');
    final end = offset + length > file.length ? file.length : offset + length;
    return Uint8List.sublistView(file, offset, end);
  }

  static Future<void> writePiece(String id, String build, String archive, int offset, Uint8List bytes) async {
    final key = archivePath(id, build, archive);
    final had = _files[key];
    final size = offset + bytes.length;
    if (had == null || had.length < size) {
      final grown = Uint8List(size);
      if (had != null) grown.setRange(0, had.length, had);
      _files[key] = grown;
    }
    _files[key]!.setRange(offset, offset + bytes.length, bytes);
  }

  static Future<Map<String, Set<int>>> donePieces(String id, String build) async => _done['$id/$build'] ?? {};

  static Future<void> saveDonePieces(String id, String build, Map<String, Set<int>> done) async {
    _done['$id/$build'] = done;
  }

  static Future<Map<String, dynamic>?> readMeta(String id) async => _meta[id];

  static Future<void> writeMeta(String id, Map<String, dynamic> meta) async {
    _meta[id] = meta;
  }

  static Future<void> dropOtherBuilds(String id, String build) async {
    _files.removeWhere((k, _) => k.startsWith('$id/') && !k.startsWith('$id/$build/'));
  }

  static Future<void> remove(String id) async {
    _files.removeWhere((k, _) => k.startsWith('$id/'));
    _meta.remove(id);
    _done.removeWhere((k, _) => k.startsWith('$id/'));
  }

  static Future<int> usedBytes() async => _files.values.fold<int>(0, (n, f) => n + f.length);

  static List<String> get ids => packList.map((p) => p.id).toList();
}

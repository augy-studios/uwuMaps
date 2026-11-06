// The update being downloaded, in the app's cache.

import 'dart:io';

import 'package:path_provider/path_provider.dart';

class ApkFile {
  ApkFile._(this._file, this._sink);
  final File _file;
  final IOSink _sink;

  static Future<ApkFile> create() async {
    final dir = Directory('${(await getTemporaryDirectory()).path}/update');
    await dir.create(recursive: true);
    final file = File('${dir.path}/uwumaps.apk');
    return ApkFile._(file, file.openWrite());
  }

  String get path => _file.path;

  void add(List<int> bytes) => _sink.add(bytes);

  Future<void> close() => _sink.close();

  Future<void> delete() async {
    try {
      await _sink.close();
    } catch (_) {
      // Already closed.
    }
    if (await _file.exists()) await _file.delete();
  }
}

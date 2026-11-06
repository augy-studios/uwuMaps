// The browser test build goes through the whole download and throws the bytes away: there's nothing to
// install them on.

class ApkFile {
  static Future<ApkFile> create() async => ApkFile();
  String get path => '';
  void add(List<int> bytes) {}
  Future<void> close() async {}
  Future<void> delete() async {}
}

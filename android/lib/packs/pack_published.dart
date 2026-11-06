// Reads ranges of a pack that isn't saved, straight from the release, for walking with no saved map. No Flutter
// in it, so the router's isolate can use it. Reads are small and few: a walk touches a few chunks of the graph.

import 'dart:typed_data';

import 'package:http/http.dart' as http;

class PublishedRanges {
  /// [files] are the archive's pieces on the release, as name and size, in order.
  PublishedRanges(this.release, this.files);
  final String release;
  final List<(String, int)> files;
  final http.Client _client = http.Client();

  Future<Uint8List> read(int offset, int length) async {
    final out = BytesBuilder(copy: false);
    var at = offset;
    var left = length;
    var fileStart = 0;
    for (final (name, size) in files) {
      if (left > 0 && at < fileStart + size) {
        final from = at - fileStart;
        final count = left < size - from ? left : size - from;
        out.add(await _fetch(name, from, count));
        at += count;
        left -= count;
      }
      fileStart += size;
    }
    if (left > 0) throw StateError('Read past the end of the map');
    return out.takeBytes();
  }

  Future<Uint8List> _fetch(String name, int from, int count) async {
    final res = await _client.get(Uri.parse('$release/$name'), headers: {'Range': 'bytes=$from-${from + count - 1}'}).timeout(const Duration(seconds: 20));
    if (res.statusCode == 206) return res.bodyBytes;
    // A server that ignores Range sends the lot: cut out the piece.
    if (res.statusCode == 200 && res.bodyBytes.length >= from + count) return Uint8List.sublistView(res.bodyBytes, from, from + count);
    throw Exception('The map file answered ${res.statusCode}');
  }
}

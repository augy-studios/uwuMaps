// The browser test build's addresses: the test server answers tiles from its fixture, and the assets
// are Flutter's own. The phone's are in tile_server_io.dart.

import '../packs/pack_store.dart';

class TileServer {
  static String get _origin => Uri.base.origin;

  static Future<void> start(List<InstalledPack> packs) async {}
  static void updatePacks(List<InstalledPack> packs) {}

  static String get baseTiles => '$_origin/__tiles/base/{z}/{x}/{y}';
  static String get buildingTiles => '$_origin/__tiles/buildings/{z}/{x}/{y}';
  static String get sprite => '$_origin/assets/assets/map/sprites/ofm';
  static String get glyphs => '$_origin/assets/assets/map/fonts/{fontstack}/{range}.pbf';
}

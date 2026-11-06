// The browser test build runs the same router on the page's one thread; it yields as it goes.

import '../core/config.dart';
import '../core/models.dart';
import '../packs/pack_files.dart';
import '../packs/pack_published.dart';
import '../packs/pack_store.dart';
import 'route_core.dart';

class RouteWorker {
  RouteWorker._();
  static final RouteWorker instance = RouteWorker._();

  final Map<String, Future<RouteGraph>> _graphs = {};
  int _latest = 0;

  Future<RouteResult?> find(InstalledPack pack, LatLon from, LatLon to, String mode) async {
    final id = ++_latest;
    final key = '${pack.id}/${pack.build}';
    final graph = await (_graphs[key] ??= RouteGraph.open((o, l) => PackFiles.read(pack.id, pack.build, 'route', o, l)));
    return findRoute(graph, from, to, mode, shouldStop: () => _latest != id);
  }

  Future<RouteResult?> findPublished(CataloguePack pack, LatLon from, LatLon to, String mode) async {
    final id = ++_latest;
    final key = 'published/${pack.id}/${pack.build}';
    final graph = await (_graphs[key] ??= RouteGraph.open(PublishedRanges(packsRelease, pack.routeFiles).read));
    return findRoute(graph, from, to, mode, shouldStop: () => _latest != id);
  }
}

// Runs the offline router in an isolate of its own, so a long search doesn't stop the map moving.

import 'dart:async';
import 'dart:isolate';

import '../core/config.dart';
import '../core/models.dart';
import '../packs/pack_files.dart';
import '../packs/pack_published.dart';
import '../packs/pack_store.dart';
import 'route_core.dart';

class _Job {
  _Job(this.id, this.path, this.files, this.from, this.to, this.mode, this.reply);
  final int id;

  /// A saved pack's file, or else the files of a published one.
  final String path;
  final List<(String, int)>? files;
  final LatLon from;
  final LatLon to;
  final String mode;
  final SendPort reply;
}

class RouteWorker {
  RouteWorker._();
  static final RouteWorker instance = RouteWorker._();

  Future<SendPort>? _port;
  int _next = 1;

  Future<SendPort> _start() async {
    final ready = ReceivePort();
    await Isolate.spawn(_main, ready.sendPort, debugName: 'router');
    return await ready.first as SendPort;
  }

  Future<RouteResult?> find(InstalledPack pack, LatLon from, LatLon to, String mode) => _ask(PackFiles.archivePath(pack.id, pack.build, 'route'), null, from, to, mode);

  Future<RouteResult?> findPublished(CataloguePack pack, LatLon from, LatLon to, String mode) => _ask('published/${pack.id}/${pack.build}', pack.routeFiles, from, to, mode);

  Future<RouteResult?> _ask(String path, List<(String, int)>? files, LatLon from, LatLon to, String mode) async {
    final port = await (_port ??= _start());
    final answer = ReceivePort();
    port.send(_Job(_next++, path, files, LatLon(from.lat, from.lon), LatLon(to.lat, to.lon), mode, answer.sendPort));
    final result = await answer.first;
    answer.close();
    if (result is String) throw Exception(result);
    return result as RouteResult?;
  }
}

Future<void> _main(SendPort ready) async {
  final inbox = ReceivePort();
  ready.send(inbox.sendPort);
  final graphs = <String, Future<RouteGraph>>{};
  var latest = 0;
  await for (final message in inbox) {
    final job = message as _Job;
    latest = job.id;
    unawaited(() async {
      try {
        final files = job.files;
        final graph = await (graphs[job.path] ??= RouteGraph.open(files == null ? FileRanges(job.path).read : PublishedRanges(packsRelease, files).read));
        // A newer request means this one's answer is no longer wanted.
        final route = await findRoute(graph, job.from, job.to, job.mode, shouldStop: () => latest != job.id);
        job.reply.send(route);
      } catch (err) {
        graphs.remove(job.path);
        job.reply.send('$err');
      }
    }());
  }
}

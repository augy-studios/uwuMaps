// Sharing: short links through the site's /api/share (places, directions, live ETAs and lists), and
// links that hold everything themselves. Also what opening any of those does.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import '../app.dart';
import '../core/config.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../core/prefs.dart';
import '../nav/directions.dart';
import 'links.dart';

const String _nameKey = 'uwumaps.shareName';
const Duration _etaEvery = Duration(seconds: 15);
const Duration _etaPoll = Duration(seconds: 10);

List<List<double>> _thin(List<List<double>> coords, int max) {
  if (coords.length <= max) return coords;
  final step = (coords.length - 1) / (max - 1);
  return List.generate(max, (i) => coords[(i * step).round()]);
}

List<List<double>> _pathOf(List<List<double>> coords) => _thin(coords, 400).map((c) => [roundCoord(c[1]), roundCoord(c[0])]).toList();

/// What the share sheet is showing.
class ShareCard {
  ShareCard({required this.title, required this.kind, required this.data, required this.payload, required this.url});
  final String title;
  final String kind;
  final Map<String, Object?> data;
  final Map<String, Object?> payload;
  String url;
  String note = '';
  String? mapImage;
}

class EtaView {
  EtaView(this.id, this.title, this.detail);
  final String id;
  String title;
  String detail;
}

class ShareService extends ChangeNotifier {
  ShareService(this.app) {
    app.navigation.onProgress = _etaUpdate;
    app.navigation.onEnd = (arrived) => unawaited(stopEta(arrived ? 'arrived' : 'stopped'));
  }
  final App app;

  ShareCard? card;
  EtaView? watching;
  Timer? _pollTimer;

  /// Set by the home screen, to put up the sheets that links open.
  void Function(ShareCard card)? showShareSheet;
  void Function(Map<String, dynamic> list)? showListSheet;
  void Function(String code)? showJoin;

  Future<Map<String, dynamic>> _makeLink(String kind, Map<String, Object?> data) async {
    final res = await Net.send('POST', Uri.parse('$apiOrigin/api/share'), {'kind': kind, 'data': data});
    final body = (res.body.isEmpty ? <String, dynamic>{} : Net.decode(res)) as Map<String, dynamic>;
    if (res.statusCode != 200) throw Exception(body['error'] ?? 'The server answered ${res.statusCode}');
    return body;
  }

  Future<void> _showCard(String title, String kind, Map<String, Object?> data, Map<String, Object?> payload) async {
    final made = ShareCard(title: title, kind: kind, data: data, payload: payload, url: selfLink(payload));
    card = made;
    showShareSheet?.call(made);
    if (!Net.online.value) {
      made.note = "You're offline, so this is a long link. Nearby sends it with a QR code.";
      notifyListeners();
      return;
    }
    made.note = 'Making a short link...';
    notifyListeners();
    try {
      final link = await _makeLink(kind, data);
      if (card != made) return;
      made.url = '$siteOrigin${link['path']}';
      made.note = '';
      made.mapImage = '$apiOrigin/api/share-map?id=${Uri.encodeComponent(link['id'] as String)}';
    } catch (_) {
      // Long links work everywhere the short ones do.
      made.note = '';
    }
    notifyListeners();
  }

  void sharePlace(Place p) {
    final data = placeOf(p, p.name);
    unawaited(_showCard(p.name, 'place', data, {'kind': 'place', 'data': data}));
  }

  void shareDirections() {
    final d = app.directions;
    final route = d.route;
    if (route == null || d.from == null || d.to == null) return;
    Object end(Place e) => e.here ? 'here' : placeOf(e, e.name);
    final from = end(d.from!);
    final to = end(d.to!);
    final data = <String, Object?>{
      'from': from,
      'to': to,
      'mode': d.mode,
      'summary': '${formatDuration(route.duration)}, ${(route.distance / 1000).toStringAsFixed(1)} km',
      'path': _pathOf(route.coords),
    };
    final compact = <String, Object?>{
      'kind': 'directions',
      'data': {'from': from, 'to': to, 'mode': d.mode},
    };
    final fromName = d.from!.here ? 'Your location' : d.from!.name;
    final toName = d.to!.here ? 'Your location' : d.to!.name;
    unawaited(_showCard('$fromName to $toName', 'directions', data, compact));
  }

  void shareList(String name, List<Place> items) {
    final data = <String, Object?>{
      'name': name,
      'places': items.take(200).map((p) => placeOf(p, p.name)).toList(),
    };
    unawaited(_showCard('$name (${(data['places'] as List<dynamic>).length} places)', 'list', data, {'kind': 'list', 'data': data}));
  }

  Future<void> send(String url, String title) async {
    try {
      await SharePlus.instance.share(ShareParams(text: url, subject: title));
    } catch (_) {
      await copy(url);
    }
  }

  Future<void> copy(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    app.toast('Link copied');
  }

  /* ---- sharing an ETA while navigating ---- */

  String? _etaId;
  String? _etaSecret;
  DateTime _etaLast = DateTime.fromMillisecondsSinceEpoch(0);

  bool get sharingEta => _etaId != null;

  Map<String, Object?> _etaBody({bool ended = false, bool stopped = false}) {
    final n = app.navigation;
    final route = n.route!;
    final p = n.progress;
    final fix = n.lastFix;
    return {
      'name': Prefs.getString(_nameKey) ?? '',
      'to': placeOf(n.to!, n.to!.name),
      'arriveAt': DateTime.now().millisecondsSinceEpoch + ((p?.secondsLeft ?? route.duration.toDouble()) * 1000).round(),
      'mode': route.mode,
      'path': _pathOf(route.coords),
      'me': fix == null ? null : {'lat': roundCoord(fix.lat), 'lng': roundCoord(fix.lon), 'accuracy': fix.accuracy, 't': fix.at},
      'ended': ended,
      'stopped': stopped,
    };
  }

  Future<void> _pushEta({bool ended = false, bool stopped = false}) async {
    if (_etaId == null) return;
    try {
      await Net.send('PATCH', Uri.parse('$apiOrigin/api/share'), {'id': _etaId, 'secret': _etaSecret, 'data': _etaBody(ended: ended, stopped: stopped)});
    } catch (_) {
      // The next one will catch up.
    }
  }

  void _etaUpdate() {
    if (_etaId != null && DateTime.now().difference(_etaLast) >= _etaEvery) {
      _etaLast = DateTime.now();
      unawaited(_pushEta());
    }
  }

  Future<void> toggleEta() async {
    if (_etaId != null) {
      await stopEta('stopped');
      return;
    }
    if (!Net.online.value) {
      app.toast('Sharing an ETA needs a connection', error: true);
      return;
    }
    try {
      final made = await _makeLink('eta', _etaBody());
      _etaId = made['id'] as String;
      _etaSecret = made['secret'] as String?;
      _etaLast = DateTime.now();
      notifyListeners();
      final url = '$siteOrigin${made['path']}';
      await Clipboard.setData(ClipboardData(text: url));
      app.toast('Live ETA link copied. It stops when you do.');
      unawaited(send(url, 'My ETA on uwuMaps'));
    } catch (err) {
      app.toast('$err'.replaceFirst('Exception: ', ''), error: true);
    }
  }

  // One last update while navigation still knows the route.
  Future<void> stopEta(String how) async {
    if (_etaId == null) return;
    final future = app.navigation.active ? _pushEta(ended: how == 'arrived', stopped: how != 'arrived') : Future<void>.value();
    await future;
    _etaId = null;
    _etaSecret = null;
    notifyListeners();
  }

  /* ---- following somebody's ETA ---- */

  void _drawEta(String id, Map<String, dynamic> data, int updatedAt) {
    final who = ((data['name'] as String?)?.isNotEmpty ?? false) ? data['name'] as String : 'Someone';
    final label = (data['to'] as Map)['label'];
    final ended = data['ended'] == true;
    final stopped = data['stopped'] == true;
    final title = stopped ? '$who stopped sharing' : (ended ? '$who has arrived at $label' : '$who is heading to $label');
    final ago = math.max(0, ((DateTime.now().millisecondsSinceEpoch - updatedAt) / 60000).round());
    final arrive = DateTime.fromMillisecondsSinceEpoch((data['arriveAt'] as num).toInt());
    final detail = ended || stopped ? '' : 'Arriving around ${formatClock(arrive)}. Updated ${ago > 0 ? '$ago min ago' : 'just now'}.';
    watching = EtaView(id, title, detail);
    final path = data['path'] as List<dynamic>?;
    if (path != null && path.length >= 2) app.map.showRoute(_lonLat(path));
    final me = data['me'];
    if (me is Map) app.map.setYouMarker((me['lat'] as num).toDouble(), (me['lng'] as num).toDouble());
    notifyListeners();
  }

  List<List<double>> _lonLat(List<dynamic> path) => path.map((p) => [((p as List<dynamic>)[1] as num).toDouble(), (p[0] as num).toDouble()]).toList();

  int _stamp(Object? v) => v is num ? v.toInt() : (DateTime.tryParse('$v')?.millisecondsSinceEpoch ?? DateTime.now().millisecondsSinceEpoch);

  void _watchEta(String id, Map<String, dynamic> data, Object? updatedAt) {
    stopWatching();
    app.directions.close();
    _drawEta(id, data, _stamp(updatedAt));
    final path = data['path'] as List<dynamic>?;
    if (path != null && path.length >= 2) unawaited(app.map.fitCoords(_lonLat(path), app.screen));
    Future<void> poll() async {
      if (watching?.id != id) return;
      try {
        final res = await Net.get(Uri.parse('$apiOrigin/api/share?id=${Uri.encodeComponent(id)}'));
        if (res.statusCode == 404) {
          watching = EtaView(id, 'This trip has ended', '');
          notifyListeners();
          return;
        }
        if (res.statusCode == 200) {
          final body = Net.decode(res) as Map<String, dynamic>;
          final next = body['data'] as Map<String, dynamic>;
          if (watching?.id == id) _drawEta(id, next, _stamp(body['updatedAt']));
          if (next['ended'] == true || next['stopped'] == true) return;
        }
      } catch (_) {
        // Offline for now: the next try may work.
      }
      if (watching?.id == id) _pollTimer = Timer(_etaPoll, poll);
    }

    _pollTimer = Timer(_etaPoll, poll);
  }

  void stopWatching() {
    _pollTimer?.cancel();
    watching = null;
    notifyListeners();
  }

  void closeEtaView() {
    stopWatching();
    app.map.clearRoute();
  }

  /* ---- opening a link ---- */

  void _applyLink(String? kind, Map<String, dynamic> data, {String? id, Object? updatedAt}) {
    if (kind == 'place') {
      app.showPlace(fromLink(data));
    } else if (kind == 'directions') {
      Place end(Object? e) => e == 'here' ? herePlace : fromLink(Map<String, dynamic>.from(e! as Map));
      app.directions.openPanel(from: end(data['from']), to: end(data['to']), setFrom: true, setTo: true, mode: data['mode'] as String?);
    } else if (kind == 'list') {
      showListSheet?.call(data);
      final places = (data['places'] as List<dynamic>).map((p) => fromLink(Map<String, dynamic>.from(p as Map))).toList();
      unawaited(app.map.fitCoords(places.map((p) => [p.lon, p.lat]).toList(), app.screen));
    } else if (kind == 'eta' && id != null) {
      _watchEta(id, data, updatedAt);
    }
  }

  Future<void> _openShort(String id) async {
    if (!Net.online.value) {
      app.toast('Opening this link needs a connection', error: true);
      return;
    }
    try {
      final res = await Net.get(Uri.parse('$apiOrigin/api/share?id=${Uri.encodeComponent(id)}'));
      if (res.statusCode == 404) {
        app.toast("That link has expired or doesn't exist", error: true);
        return;
      }
      if (res.statusCode != 200) throw Exception('${res.statusCode}');
      final body = Net.decode(res) as Map<String, dynamic>;
      _applyLink(body['kind'] as String?, Map<String, dynamic>.from(body['data'] as Map), id: id, updatedAt: body['updatedAt']);
    } catch (err) {
      debugPrint('Opening a link: $err');
      app.toast("Couldn't open that link. Try again in a moment.", error: true);
    }
  }

  /// Opens a link the app was opened with, or a scanned one. Answers whether it was one of ours.
  bool openLink(Uri uri) {
    final target = parseLink(uri);
    switch (target) {
      case ShortLink(:final id):
        unawaited(_openShort(id));
      case SelfLink(:final payload):
        _applyLink(payload['kind'] as String?, Map<String, dynamic>.from(payload['data'] as Map));
      case JoinLink(:final code):
        showJoin?.call(code);
      case null:
        return false;
    }
    return true;
  }

  void receive(Map<String, dynamic> payload) {
    if (validSelfLink(payload)) _applyLink(payload['kind'] as String?, Map<String, dynamic>.from(payload['data'] as Map));
  }
}

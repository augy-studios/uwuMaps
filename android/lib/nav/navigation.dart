// Live navigation: following somebody along a route, saying what's next, and finding a new way when they
// leave it. Everything here works offline: positions come from the phone, the route from a saved pack,
// and the voice from the phone's own speech engine.

import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:geolocator/geolocator.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show MyLocationTrackingMode;
import 'package:wakelock_plus/wakelock_plus.dart';

import '../app.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/prefs.dart';
import '../routing/route_client.dart';
import 'directions.dart';

const String _voiceKey = 'uwumaps.navVoice';
// Further off the line than this, a few fixes running, is off the route rather than a poor fix.
const Map<String, double> _offRouteM = {'foot': 35, 'bike': 45, 'car': 60};
const int _offRouteFixes = 3;
const Duration _rerouteGap = Duration(seconds: 10);
const double _arrivedM = 25;
const Map<String, List<double>> _announceAtM = {
  'foot': [60],
  'bike': [120],
  'car': [800, 200],
};

class NavProgress {
  NavProgress(this.left, this.stepIndex, this.toStep);
  final double left;
  final int stepIndex;
  final double toStep;
  double secondsLeft = 0;
}

class _Here {
  _Here(this.d, this.index, this.m);
  final double d;
  final int index;
  final double m;
}

class LastFix {
  LastFix(this.lat, this.lon, this.accuracy, this.at);
  final double lat;
  final double lon;
  final double accuracy;
  final int at;
}

class Navigation extends ChangeNotifier {
  Navigation(this.app);
  final App app;

  bool active = false;
  bool voice = true;
  RouteResult? route;
  Place? to;
  NavProgress? progress;
  LastFix? lastFix;
  bool sharingEta = false;

  Float64List _along = Float64List(0);
  List<double> _stepAt = const [];
  int _index = 0;
  Set<String> _said = {};
  int _offCount = 0;
  DateTime _reroutedAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _rerouting = false;
  bool _framing = false;
  bool _framed = false;
  StreamSubscription<Position>? _watch;
  FlutterTts? _tts;

  /// How much of the route's shape to hand an ETA link's map.
  void Function()? onProgress;
  void Function(bool arrived)? onEnd;

  RouteStep? get nextStep {
    final r = route;
    final p = progress;
    if (r == null || p == null) return null;
    return p.stepIndex + 1 < r.steps.length ? r.steps[p.stepIndex + 1] : r.steps.last;
  }

  void _say(String text) {
    if (!voice || text.isEmpty) return;
    try {
      final tts = _tts ??= FlutterTts();
      unawaited(tts.stop().then((_) => tts.speak(text)).catchError((Object _) {}));
    } catch (_) {
      // The screen still says it.
    }
  }

  void toggleVoice() {
    voice = !voice;
    Prefs.setBool(_voiceKey, voice);
    if (!voice) unawaited(_tts?.stop().catchError((Object _) {}));
    notifyListeners();
  }

  void _useRoute(RouteResult r) {
    route = r;
    final coords = r.coords;
    final along = Float64List(coords.length);
    for (var i = 1; i < coords.length; i++) {
      along[i] = along[i - 1] + metresBetween(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    _along = along;
    _index = 0;
    // Where each step begins, in metres along the route.
    _stepAt = r.steps.map((s) => along[math.min(s.index, coords.length - 1)]).toList();
    _said = {};
    app.map.showRoute(coords);
  }

  // The nearest point on the line, looking only a little behind and ahead of the last one, so a road
  // that doubles back on itself doesn't make somebody jump along the route.
  _Here _locate(List<List<double>> coords, int fromIndex, double lat, double lon) {
    final cos = math.cos(lat * math.pi / 180);
    var best = _Here(double.infinity, fromIndex, _along[fromIndex]);
    final start = math.max(0, fromIndex - 5);
    final end = math.min(coords.length - 1, fromIndex + 200);
    for (var i = start; i < end; i++) {
      final ax = coords[i][0] * cos;
      final ay = coords[i][1];
      final bx = coords[i + 1][0] * cos;
      final by = coords[i + 1][1];
      final px = lon * cos;
      final dx = bx - ax;
      final dy = by - ay;
      final l2 = dx * dx + dy * dy;
      final t = l2 != 0 ? (((px - ax) * dx + (lat - ay) * dy) / l2).clamp(0.0, 1.0) : 0.0;
      final ex = px - ax - t * dx;
      final ey = lat - ay - t * dy;
      final d = math.sqrt(ex * ex + ey * ey) * 111195;
      if (d < best.d) best = _Here(d, i, _along[i] + t * (_along[i + 1] - _along[i]));
    }
    return best;
  }

  int _stepIndexAt(double m) {
    var i = 0;
    while (i + 1 < _stepAt.length && _stepAt[i + 1] <= m) {
      i++;
    }
    return i;
  }

  void _announce() {
    final r = route!;
    final p = progress!;
    final nextIndex = p.stepIndex + 1;
    if (nextIndex >= r.steps.length) return;
    final next = r.steps[nextIndex];
    final points = _announceAtM[r.mode] ?? const [100.0];
    for (final at in points) {
      final key = '${p.stepIndex}:$at';
      if (p.toStep <= at && !_said.contains(key)) {
        for (final a in points) {
          if (a >= at) _said.add('${p.stepIndex}:$a');
        }
        _say('In ${formatDistance(p.toStep).replaceAll(' m', ' metres').replaceAll(' km', ' kilometres')}, ${next.text}');
        return;
      }
    }
  }

  Future<void> _reroute(double lat, double lon) async {
    if (_rerouting || DateTime.now().difference(_reroutedAt) < _rerouteGap) return;
    _rerouting = true;
    _reroutedAt = DateTime.now();
    final current = route;
    try {
      final found = await getRoute(app.packs, LatLon(lat, lon), to!, current!.mode);
      if (!active || route != current) return;
      _useRoute(found);
      _offCount = 0;
      _say('Route updated.');
    } on NoRoute catch (err) {
      app.toast(err.message, error: true);
    } catch (err) {
      debugPrint('Reroute: $err');
    } finally {
      _rerouting = false;
    }
  }

  void onPosition(double lat, double lon, {double accuracy = 20, double heading = double.nan, double speed = 0}) {
    if (!active) return;
    final r = route!;
    final here = _locate(r.coords, _index, lat, lon);
    _index = here.index;

    // The way ahead is up, tilted, when moving. Otherwise along the line.
    final nextPoint = r.coords[math.min(here.index + 1, r.coords.length - 1)];
    final lineBearing = math.atan2((nextPoint[0] - lon) * math.cos(lat * math.pi / 180), nextPoint[1] - lat) * 180 / math.pi;
    final bearing = heading.isFinite && speed > 1 ? heading : lineBearing;
    app.you.fix(lat, lon, accuracy: accuracy, bearing: (bearing + 360) % 360, mps: speed, routeMode: r.mode);

    lastFix = LastFix(lat, lon, accuracy, DateTime.now().millisecondsSinceEpoch);

    if (here.d > (_offRouteM[r.mode] ?? 60)) {
      _offCount++;
      if (_offCount >= _offRouteFixes) unawaited(_reroute(lat, lon));
    } else {
      _offCount = 0;
    }

    final total = _along.last;
    final left = math.max(0.0, total - here.m);
    final stepIndex = _stepIndexAt(here.m);
    final nextAt = stepIndex + 1 < _stepAt.length ? _stepAt[stepIndex + 1] : total;
    final p = NavProgress(left, stepIndex, math.max(0, nextAt - here.m));
    p.secondsLeft = r.distance > 0 ? r.duration * (left / r.distance) : 0;
    progress = p;
    notifyListeners();
    _announce();

    final end = r.coords.last;
    if (left < _arrivedM || metresBetween(lat, lon, end[1], end[0]) < _arrivedM) {
      _finish(true);
      return;
    }

    // Over to the first fix, close and tilted, and from then on the camera goes where the dot goes. Dragged
    // away, it's back with the next fix.
    if (!_framing) {
      _framing = true;
      unawaited(app.map.easeTo(lat, lon, zoom: r.mode == 'car' ? 17 : 18, tilt: 60, bearing: bearing).whenComplete(() => _framed = true));
    }
    if (_framed) app.you.follow(MyLocationTrackingMode.trackingGps);
    onProgress?.call();
  }

  Future<void> start(RouteResult r, ResolvedEnds ends) async {
    if (active) stop();
    voice = Prefs.getBool(_voiceKey, true);
    to = ends.to;
    active = true;
    _offCount = 0;
    _framing = false;
    _framed = false;
    _rerouting = false;
    _reroutedAt = DateTime.fromMillisecondsSinceEpoch(0);
    _useRoute(r);
    final first = r.steps.isNotEmpty ? r.steps.first : null;
    final p = NavProgress(r.distance.toDouble(), 0, (first?.distance ?? r.distance).toDouble());
    p.secondsLeft = r.duration.toDouble();
    progress = p;
    notifyListeners();
    _say(first?.text ?? '');
    unawaited(WakelockPlus.enable().catchError((Object _) {}));
    try {
      await ensureLocationPermission();
      if (!active) return;
      _watch = Geolocator.getPositionStream(locationSettings: const LocationSettings(accuracy: LocationAccuracy.bestForNavigation)).listen(
        (pos) => onPosition(pos.latitude, pos.longitude, accuracy: pos.accuracy, heading: pos.heading, speed: pos.speed),
        onError: (Object err) {
          if (err is PermissionDeniedException) {
            app.toast('Allow location access to follow the route', error: true);
            _finish(false);
          } else {
            app.toast('Waiting for your location...');
          }
        },
      );
    } on LocationFailure catch (err) {
      app.toast(err.serviceOff ? "Turn on your phone's location to follow the route" : 'Allow location access to follow the route', error: true);
      _finish(false);
    }
  }

  void _finish(bool arrived) {
    if (!active) return;
    if (arrived) {
      _say('You have arrived.');
      app.toast('You have arrived');
    }
    onEnd?.call(arrived);
    stop(keepVoice: arrived);
  }

  void userStopped() {
    onEnd?.call(false);
    stop();
  }

  void stop({bool keepVoice = false}) {
    if (!active) return;
    unawaited(_watch?.cancel());
    _watch = null;
    unawaited(WakelockPlus.disable().catchError((Object _) {}));
    if (!keepVoice) unawaited(_tts?.stop().catchError((Object _) {}));
    active = false;
    route = null;
    progress = null;
    app.map.clearRoute();
    app.you.navigationEnded();
    notifyListeners();
  }
}

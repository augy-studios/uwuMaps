// You on the map, live: the dot, the camera following it, and how fast you're going.
//
// MapLibre draws the dot and moves the camera with the same animation, so the dot stays in the middle of the
// screen throughout, where moving a marker and then easing the camera after it left the dot off centre until
// the camera caught up. The fixes are the app's own, from Geolocator, so navigation can choose the bearing.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:geolocator/geolocator.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../app.dart';

/// Whether there's a speed to show, and what it is. On a route, the mode says: a car or a bike always shows
/// it, stopped at the lights too, and on foot never does. With no route nothing says how you're travelling, so
/// it shows once you're clearly faster than a walk, and stays until you've slowed down.
class SpeedReadout {
  /// 9 km/h, and 5.4 km/h.
  static const showFrom = 2.5;
  static const hideBelow = 1.5;

  /// Metres a second, or null with nothing to show.
  double? mps;

  void update(double? speed, {String? routeMode}) {
    if (speed == null || speed < 0) {
      mps = null;
      return;
    }
    final show = switch (routeMode) {
      'car' || 'bike' => true,
      null => speed >= (mps == null ? showFrom : hideBelow),
      _ => false,
    };
    mps = show ? speed : null;
  }
}

/// Spots two fingers dragging the map together. While it's following you, MapLibre ignores two fingers moving
/// until they've gone a very long way, so that a pinch can't pull the dot off centre, and two-finger panning
/// stops working. So a drag is seen here and following let go, which puts its usual threshold back. A pinch or
/// a twist moves the fingers apart or around, and doesn't count.
class TwoFingerDrag {
  /// In logical pixels.
  static const _together = 16.0;
  static const _eachFinger = 8.0;

  final Map<int, Offset> _start = {};
  final Map<int, Offset> _now = {};

  void down(int pointer, Offset at) {
    _now[pointer] = at;
    _start
      ..clear()
      ..addAll(_now);
  }

  void up(int pointer) {
    _now.remove(pointer);
    _start
      ..clear()
      ..addAll(_now);
  }

  /// Whether this move makes it a drag.
  bool move(int pointer, Offset at) {
    if (!_now.containsKey(pointer)) return false;
    _now[pointer] = at;
    if (_now.length != 2) return false;
    final moves = [for (final e in _now.entries) e.value - _start[e.key]!];
    final a = moves.first, b = moves.last;
    return a.distance >= _eachFinger && b.distance >= _eachFinger && a.dx * b.dx + a.dy * b.dy > 0 && ((a + b) / 2).distance >= _together;
  }
}

class You extends ChangeNotifier {
  You(this.app) {
    app.map.onCameraTaken = stopFollowing;
    // Turning the view by hand wins over the compass. The map stays on you.
    app.map.onOrbit = () {
      if (mode == MyLocationTrackingMode.trackingCompass) _setMode(MyLocationTrackingMode.tracking);
    };
  }

  final App app;

  MyLocationTrackingMode mode = MyLocationTrackingMode.none;

  /// The dot is on the map. Off until something has asked where you are.
  bool shown = false;

  final SpeedReadout speed = SpeedReadout();
  final TwoFingerDrag fingers = TwoFingerDrag();

  /// With no fix for this long, a speed on screen is old news: in a tunnel, say.
  static const _stale = Duration(seconds: 5);
  Timer? _staleTimer;
  StreamSubscription<Position>? _watch;
  bool _wantWatch = false;
  bool _foreground = true;

  bool get following => mode != MyLocationTrackingMode.none;
  bool get facingCompass => mode == MyLocationTrackingMode.trackingCompass;

  MyLocationRenderMode get renderMode => switch (mode) {
        MyLocationTrackingMode.trackingCompass => MyLocationRenderMode.compass,
        MyLocationTrackingMode.trackingGps => MyLocationRenderMode.gps,
        _ => MyLocationRenderMode.normal,
      };

  /// My location: to where you are, and with you from then on, until the map's dragged away.
  Future<void> followLocation() async {
    try {
      final pos = await locate();
      fix(pos.lat, pos.lon);
      await app.map.flyTo(pos.lat, pos.lon);
      _setMode(MyLocationTrackingMode.tracking);
      _startWatching();
    } on LocationFailure catch (err) {
      app.toast(locationMessage(err), error: true);
    }
  }

  /// The compass button: the map turns as the phone does, and a second press puts it north and flat.
  Future<void> toggleCompass() async {
    if (facingCompass) {
      await app.map.resetNorth();
      return;
    }
    _show();
    _setMode(MyLocationTrackingMode.trackingCompass);
    try {
      await ensureLocationPermission();
      _startWatching();
    } on LocationFailure {
      // The compass needs no location. The map still turns, just without following you.
    }
  }

  void follow(MyLocationTrackingMode next) => _setMode(next);

  void stopFollowing() => _setMode(MyLocationTrackingMode.none);

  /// What MapLibre did by itself: a drag away ends following, and a twist ends the compass.
  void trackingChanged(MyLocationTrackingMode now) => _setMode(now);

  /// A finger moved on the map.
  void fingerMoved(int pointer, Offset at) {
    if (fingers.move(pointer, at) && following) stopFollowing();
  }

  /// One fix: the dot moves there, and so does the camera if it's following. [routeMode] is the route being
  /// followed, if there is one.
  void fix(double lat, double lon, {double? accuracy, double? bearing, double? mps, String? routeMode}) {
    _show();
    app.map.showYou(lat, lon, accuracy: accuracy, bearing: bearing, speed: mps);
    speed.update(mps, routeMode: routeMode);
    _staleTimer?.cancel();
    _staleTimer = Timer(_stale, () {
      speed.mps = null;
      notifyListeners();
    });
    notifyListeners();
  }

  /// Navigation's over: nothing's following, and a speed from its route doesn't apply any more.
  void navigationEnded() {
    speed.mps = null;
    stopFollowing();
    notifyListeners();
  }

  void setForeground(bool on) {
    _foreground = on;
    if (on) {
      if (_wantWatch) _startWatching();
    } else {
      unawaited(_watch?.cancel());
      _watch = null;
    }
  }

  void _show() {
    if (shown) return;
    shown = true;
    app.map.useYouDot();
    notifyListeners();
  }

  void _setMode(MyLocationTrackingMode next) {
    if (mode == next) return;
    mode = next;
    notifyListeners();
  }

  void _startWatching() {
    _wantWatch = true;
    if (_watch != null || !_foreground) return;
    _watch = Geolocator.getPositionStream(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high)).listen(
      (pos) {
        // Navigation has fixes of its own, with the bearing it wants.
        if (app.navigation.active) return;
        fix(pos.latitude, pos.longitude, accuracy: pos.accuracy, bearing: pos.speed > 1 && pos.heading.isFinite ? pos.heading : null, mps: pos.speed);
      },
      onError: (Object err) => debugPrint('Location: $err'),
    );
  }
}

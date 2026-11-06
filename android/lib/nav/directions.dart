// Planning a route: two ends, how to travel, and the route between them.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../app.dart';
import '../core/models.dart';
import '../core/prefs.dart';
import '../routing/route_client.dart';

const String _modeKey = 'uwumaps.travelMode';
const String hereLabel = 'My location';
const Place herePlace = Place(name: hereLabel, lat: 0, lon: 0, here: true);

class ResolvedEnds {
  const ResolvedEnds(this.from, this.to);
  final Place from;
  final Place to;
}

class Directions extends ChangeNotifier {
  Directions(this.app);
  final App app;

  bool open = false;

  /// An end is a place, herePlace for where you are, or null when it's still to pick.
  Place? from = herePlace;
  Place? to;
  String mode = Prefs.getString(_modeKey)?.replaceAll('"', '') ?? 'car';
  RouteResult? route;
  ResolvedEnds? resolved;
  String status = '';
  bool working = false;

  /// Which end a tap on the map fills: the field last chosen, then whichever's empty.
  String? picking;
  int _request = 0;

  String endLabel(Place? end) => end?.name ?? '';

  String? get _nextEmpty => from == null ? 'from' : (to == null ? 'to' : null);
  String get _askForEnd => '${to != null ? 'Where from?' : 'Where to?'} Type it, or tap the map.';

  void _drawEnds() {
    app.map.setEndMarkers(from != null && !from!.here ? from : null, to != null && !to!.here ? to : null);
  }

  void setPicking(String? which) {
    picking = which;
    notifyListeners();
  }

  void togglePick(String which) {
    picking = picking == which ? null : which;
    status = picking != null ? 'Tap the map for ${which == 'from' ? 'where to start' : 'where to go'}.' : '';
    notifyListeners();
  }

  void setMode(String m) {
    mode = m;
    Prefs.setString(_modeKey, m);
    unawaited(plan());
  }

  void setEnd(String which, Place? end) {
    if (which == 'from') {
      from = end;
    } else {
      to = end;
    }
    if (end != null) picking = _nextEmpty;
    _drawEnds();
    if (end != null) {
      unawaited(plan());
    } else {
      notifyListeners();
    }
  }

  void swap() {
    final was = from;
    from = to;
    to = was;
    picking = _nextEmpty;
    _drawEnds();
    unawaited(plan());
  }

  void openPanel({Place? from, Place? to, bool setFrom = false, bool setTo = false, String? mode}) {
    if (setFrom) this.from = from;
    if (setTo) this.to = to;
    if (mode != null) {
      this.mode = mode;
      Prefs.setString(_modeKey, mode);
    }
    app.hidePlace();
    open = true;
    picking = _nextEmpty;
    _drawEnds();
    if (this.from != null && this.to != null) {
      unawaited(plan());
    } else {
      status = _askForEnd;
      notifyListeners();
    }
  }

  void close() {
    _request++;
    route = null;
    picking = null;
    open = false;
    working = false;
    app.map.setEndMarkers(null, null);
    app.map.clearRoute();
    notifyListeners();
  }

  /// A tap on the map, as an end of the route. Answers false if neither end is waiting for one.
  bool pickFromMap(Place place) {
    final which = picking ?? _nextEmpty;
    if (which == null) return false;
    setEnd(which, Place(name: place.name, lat: place.lat, lon: place.lon));
    return true;
  }

  Future<Place> _resolve(Place end) async {
    if (!end.here) return end;
    final pos = await locate();
    app.map.setYouMarker(pos.lat, pos.lon);
    return Place(name: hereLabel, lat: pos.lat, lon: pos.lon);
  }

  Future<void> plan({bool fit = true}) async {
    final id = ++_request;
    route = null;
    app.map.clearRoute();
    if (from == null || to == null) {
      status = _askForEnd;
      working = false;
      notifyListeners();
      return;
    }
    if (from!.here && to!.here) {
      status = 'Pick somewhere other than where you are.';
      working = false;
      notifyListeners();
      return;
    }
    status = 'Finding the way...';
    working = true;
    notifyListeners();
    try {
      final a = await _resolve(from!);
      final b = await _resolve(to!);
      final found = await getRoute(app.packs, a, b, mode);
      if (id != _request) return;
      route = found;
      resolved = ResolvedEnds(a, b);
      status = '';
      app.map.showRoute(found.coords);
      if (fit) unawaited(app.map.fitCoords(found.coords, app.screen));
    } on NoRoute catch (err) {
      if (id != _request) return;
      status = err.message;
    } on LocationFailure catch (err) {
      if (id != _request) return;
      status = err.denied || err.serviceOff ? 'Allow location access to start from where you are, or type a start.' : "Couldn't find your location. Type a start instead.";
    } catch (err) {
      if (id != _request) return;
      debugPrint('Planning: $err');
      status = "Couldn't find the way. Try again in a moment.";
    }
    working = false;
    notifyListeners();
  }
}

// The app's services, made once at the start, and the few things every screen does.

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import 'core/models.dart';
import 'map/map_service.dart';
import 'nav/directions.dart';
import 'nav/navigation.dart';
import 'nav/you.dart';
import 'packs/pack_store.dart';
import 'places/places.dart';
import 'search/search.dart';
import 'share/share.dart';
import 'theme/theme_controller.dart';
import 'transit/transit.dart';
import 'update/updater.dart';

class Toast {
  const Toast(this.message, this.error, this.id);
  final String message;
  final bool error;
  final int id;
}

class App {
  App() {
    transit = Transit(map);
    places = Places(map);
    search = SearchService(packs, transit);
    directions = Directions(this);
    navigation = Navigation(this);
    you = You(this);
    share = ShareService(this);
  }

  final ThemeController theme = ThemeController();
  final MapService map = MapService();
  final PackStore packs = PackStore();
  final Updater updater = Updater();
  late final Transit transit;
  late final Places places;
  late final SearchService search;
  late final Directions directions;
  late final Navigation navigation;
  late final You you;
  late final ShareService share;

  /// The place on the card, if there is one.
  final ValueNotifier<Place?> currentPlace = ValueNotifier(null);

  final ValueNotifier<Toast?> toastNotifier = ValueNotifier(null);
  int _toastId = 0;

  void toast(String message, {bool error = false}) {
    toastNotifier.value = Toast(message, error, ++_toastId);
  }

  /// The size of the screen, for fitting things on the map.
  Size screen = const Size(400, 800);

  /// Puts the app's own sheets up from anywhere, as links opened from outside do.
  final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  void showPlace(Place place, {bool fly = true}) {
    currentPlace.value = place;
    map.setPlaceMarker(place.lat, place.lon);
    if (fly) map.flyTo(place.lat, place.lon);
  }

  void hidePlace() {
    currentPlace.value = null;
    map.clearPlaceMarker();
  }

  Future<LatLon> currentPosition() => locate();
}

late final App app;

/// Why a location couldn't be had.
class LocationFailure implements Exception {
  const LocationFailure({required this.denied, this.serviceOff = false});
  final bool denied;
  final bool serviceOff;
}

/// Asks for location at the moment it's wanted, never at launch.
Future<void> ensureLocationPermission() async {
  if (!await Geolocator.isLocationServiceEnabled()) throw const LocationFailure(denied: false, serviceOff: true);
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
  if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
    throw const LocationFailure(denied: true);
  }
}

Future<LatLon> locate() async {
  await ensureLocationPermission();
  try {
    final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)));
    return LatLon(p.latitude, p.longitude);
  } on LocationFailure {
    rethrow;
  } catch (_) {
    final last = await Geolocator.getLastKnownPosition();
    if (last != null) return LatLon(last.latitude, last.longitude);
    throw const LocationFailure(denied: false);
  }
}

String locationMessage(LocationFailure err) {
  if (err.serviceOff) return "Turn on your phone's location to see where you are";
  return err.denied ? 'Allow location access to see where you are' : "Couldn't find your location";
}

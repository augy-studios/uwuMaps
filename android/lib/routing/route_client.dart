// Getting a route: from a saved pack when one covers both ends, so it works the same with or without a
// connection, and otherwise from the public OSRM servers (the same ones SG Bus Timings uses).

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart';
import '../core/net.dart';
import '../packs/pack_store.dart';
import 'route_core.dart';
import 'route_worker.dart';

const Map<String, String> _osrm = {
  'foot': 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  'bike': 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
  'car': 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};

const Map<String, int> _modifierAngle = {'sharp left': -140, 'left': -90, 'slight left': -35, 'straight': 0, 'slight right': 35, 'right': 90, 'sharp right': 140, 'uturn': 180};

class NoRoute implements Exception {
  const NoRoute(this.message);
  final String message;
  @override
  String toString() => message;
}

RouteStep _osrmStep(Map<String, dynamic> s, int index) {
  final m = s['maneuver'] as Map<String, dynamic>;
  final kind = m['type'] as String?;
  final modifier = m['modifier'] as String?;
  var type = 'turn';
  if (kind == 'depart') {
    type = 'depart';
  } else if (kind == 'arrive') {
    type = 'arrive';
  } else if (kind == 'roundabout' || kind == 'rotary') {
    type = 'roundabout';
  } else if (kind == 'on ramp' || kind == 'off ramp') {
    type = 'ramp';
  } else if (kind == 'new name' || modifier == 'straight') {
    type = 'continue';
  } else if (s['mode'] == 'ferry') {
    type = 'ferry';
  }
  final location = (m['location'] as List<dynamic>).map((n) => (n as num).toDouble()).toList();
  final name = (s['name'] as String?) ?? '';
  final ref = (s['ref'] as String?) ?? '';
  final step = RouteStep(
    type: type,
    name: name.isNotEmpty ? name : ref,
    distance: (s['distance'] as num).round(),
    duration: (s['duration'] as num).round(),
    at: location,
    index: index,
    angle: _modifierAngle[modifier] ?? 0,
    exit: (m['exit'] as num?)?.toInt() ?? 0,
    compass: compassPoints[(((m['bearing_after'] as num?) ?? 0) / 45).round() % 8],
  );
  step.text = stepText(step);
  return step;
}

Future<RouteResult?> _onlineRoute(LatLon from, LatLon to, String mode) async {
  final url = '${_osrm[mode]}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true';
  final res = await Net.get(Uri.parse(url));
  if (res.statusCode != 200) throw Exception('The route server answered ${res.statusCode}');
  final routes = (Net.decode(res) as Map<String, dynamic>)['routes'] as List<dynamic>?;
  if (routes == null || routes.isEmpty) return null;
  final r = routes.first as Map<String, dynamic>;
  final coords = ((r['geometry'] as Map<String, dynamic>)['coordinates'] as List<dynamic>).map((c) => (c as List<dynamic>).map((n) => (n as num).toDouble()).toList()).toList();
  // Each step's place along the line, by the point nearest where it happens.
  var at = 0;
  final steps = <RouteStep>[];
  for (final leg in r['legs'] as List<dynamic>) {
    for (final s in (leg as Map<String, dynamic>)['steps'] as List<dynamic>) {
      final step = s as Map<String, dynamic>;
      final loc = (step['maneuver'] as Map<String, dynamic>)['location'] as List<dynamic>;
      for (var i = at; i < coords.length; i++) {
        if ((coords[i][0] - (loc[0] as num)).abs() < 1e-5 && (coords[i][1] - (loc[1] as num)).abs() < 1e-5) {
          at = i;
          break;
        }
      }
      steps.add(_osrmStep(step, at));
    }
  }
  return RouteResult(source: 'online', mode: mode, distance: (r['distance'] as num).round(), duration: (r['duration'] as num).round(), coords: coords, steps: steps);
}

/// Answers a route, or throws [NoRoute] with something worth reading.
Future<RouteResult> getRoute(PackStore packs, LatLon from, LatLon to, String mode) async {
  final a = packs.packAt(from.lat, from.lon);
  final b = packs.packAt(to.lat, to.lon);
  final pack = a != null && b != null && a.id == b.id ? a : null;

  if (pack != null) {
    try {
      final route = await RouteWorker.instance.find(pack, from, to, mode);
      if (route != null) return route;
    } catch (err) {
      debugPrint('Offline router: $err');
    }
    if (!Net.online.value) throw const NoRoute('No way there was found on the saved map.');
  }
  if (!Net.online.value) throw const NoRoute("You're offline. Save this area in Offline maps to get directions here.");
  try {
    final route = await _onlineRoute(from, to, mode);
    if (route == null) throw const NoRoute('No way there was found.');
    return route;
  } on NoRoute {
    rethrow;
  } catch (_) {
    throw const NoRoute("Couldn't reach the route server. Try again in a moment.");
  }
}

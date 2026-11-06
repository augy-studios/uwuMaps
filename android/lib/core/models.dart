// The app's small plain types. No Flutter here, so the routing isolate and the tests can use them.

class LatLon {
  const LatLon(this.lat, this.lon);
  final double lat;
  final double lon;
}

/// A link on a place's card, to another site.
class PlaceLink {
  const PlaceLink(this.href, this.text, this.icon);
  final String href;
  final String text;
  final String icon;
}

/// Somewhere on the map. [doorCodes] is a Singapore station's codes, for its card's train doors.
class Place implements LatLon {
  const Place({required this.name, required this.lat, required this.lon, this.sub = '', this.source = '', this.list, this.links = const [], this.doorCodes = const [], this.score = 0, this.here = false});

  final String name;
  @override
  final double lat;
  @override
  final double lon;
  final String sub;
  final String source;
  final String? list;
  final List<PlaceLink> links;
  final List<String> doorCodes;
  final double score;

  /// "My location", offered as a route's start.
  final bool here;

  Place copyWith({String? sub, String? source, double? score}) => Place(name: name, lat: lat, lon: lon, sub: sub ?? this.sub, source: source ?? this.source, list: list, links: links, doorCodes: doorCodes, score: score ?? this.score, here: here);
}

class RouteStep {
  RouteStep({required this.type, required this.name, required this.distance, required this.duration, required this.at, required this.index, this.angle, this.exit = 0, this.compass = '', this.text = ''});

  final String type;
  final String name;
  final int distance;
  final int duration;

  /// [lon, lat]
  final List<double> at;
  final int index;
  final int? angle;
  final int exit;
  final String compass;
  String text;
}

class RouteResult {
  RouteResult({required this.source, required this.mode, required this.distance, required this.duration, required this.coords, required this.steps});

  final String source;
  final String mode;
  final int distance;
  final int duration;

  /// [lon, lat] pairs.
  final List<List<double>> coords;
  final List<RouteStep> steps;

  /// The same route, found over the network rather than from a saved map.
  RouteResult fromOnline() => RouteResult(source: 'online', mode: mode, distance: distance, duration: duration, coords: coords, steps: steps);
}

/// The icon for a step of a route.
String stepIconName(RouteStep step) {
  if (step.type == 'arrive') return 'arrive';
  if (step.type == 'roundabout') return 'roundabout';
  if (step.type == 'depart' || step.type == 'continue' || step.type == 'ferry') return 'straight';
  final a = step.angle ?? 0;
  if (a.abs() >= 165) return 'uturn';
  if (a.abs() < 25) return 'straight';
  if (a.abs() < 50) return a < 0 ? 'slightLeft' : 'slightRight';
  return a < 0 ? 'turnLeft' : 'turnRight';
}

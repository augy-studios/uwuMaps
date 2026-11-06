// Small formatting and geometry helpers, as main-site/js/ui.js has them.

import 'dart:math' as math;

String formatDistance(num metres) {
  if (metres < 950) return '${math.max(10, (metres / 10).round() * 10)} m';
  if (metres < 100000) return '${(metres / 1000).toStringAsFixed(1)} km';
  return '${(metres / 1000).round()} km';
}

String formatSpeed(num metresASecond) => '${(metresASecond * 3.6).round()} km/h';

String formatDuration(num seconds) {
  final mins = math.max(1, (seconds / 60).round());
  if (mins < 60) return '$mins min';
  final h = mins ~/ 60;
  return mins % 60 != 0 ? '$h h ${mins % 60} min' : '$h h';
}

String formatClock(DateTime when) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(when.hour)}:${two(when.minute)}';
}

String formatBytes(num bytes) {
  if (bytes >= 1e9) return '${(bytes / 1e9).toStringAsFixed(1)} GB';
  if (bytes >= 1e6) return '${math.max(1, (bytes / 1e6).round())} MB';
  return '${math.max(1, (bytes / 1e3).round())} KB';
}

/// A straight-line distance in metres, good enough for ranking and for how far off a route somebody is.
double metresBetween(double aLat, double aLon, double bLat, double bLon) {
  const rad = math.pi / 180;
  final dLat = (bLat - aLat) * rad;
  final dLon = (bLon - aLon) * rad * math.cos(((aLat + bLat) / 2) * rad);
  return 6371000 * math.sqrt(dLat * dLat + dLon * dLon);
}

double roundCoord(double v) => (v * 1e5).round() / 1e5;

/// A coordinate as main-site's JavaScript prints one: 103.85 rather than 103.85000000000001, and 1 rather than 1.0.
String coordText(double v) {
  final r = roundCoord(v);
  return r == r.roundToDouble() ? r.toInt().toString() : r.toString();
}

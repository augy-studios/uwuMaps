// Links that hold everything themselves, which is what makes sharing possible with no connection, and
// reading any link the app can be opened with. The same links as the website's, so each opens the other's.

import 'dart:convert';

import '../core/config.dart';
import '../core/format.dart';
import '../core/models.dart';

Map<String, Object?> placeOf(LatLon p, String name) => {'label': name, 'lat': roundCoord(p.lat), 'lng': roundCoord(p.lon)};

Place fromLink(Map<String, dynamic> p) => Place(name: p['label'] as String, lat: (p['lat'] as num).toDouble(), lon: (p['lng'] as num).toDouble());

String selfLink(Map<String, Object?> payload) {
  final b64 = base64Url.encode(utf8.encode(jsonEncode(payload))).replaceAll('=', '');
  return '$siteOrigin/#s=$b64';
}

Map<String, dynamic>? decodeSelf(String fragment) {
  try {
    if (!fragment.startsWith('s=')) return null;
    var b64 = fragment.substring(2);
    b64 += '=' * ((4 - b64.length % 4) % 4);
    return jsonDecode(utf8.decode(base64Url.decode(b64))) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}

bool _validPoint(Object? p) {
  if (p is! Map) return false;
  final lat = p['lat'];
  final lng = p['lng'];
  return p['label'] is String && lat is num && lng is num && lat.isFinite && lng.isFinite && lat.abs() <= 90 && lng.abs() <= 180;
}

/// A link's contents came from outside the app, so they're checked rather than trusted.
bool validSelfLink(Map<String, dynamic> payload) {
  final kind = payload['kind'];
  final data = payload['data'];
  if (data is! Map) return false;
  if (kind == 'place') return _validPoint(data);
  if (kind == 'directions') {
    bool end(Object? e) => e == 'here' || _validPoint(e);
    return end(data['from']) && end(data['to']) && const ['foot', 'bike', 'car'].contains(data['mode']);
  }
  if (kind == 'list') {
    final places = data['places'];
    return data['name'] is String && places is List && places.length <= 200 && places.every(_validPoint);
  }
  return false;
}

/// What a link means, whichever way it came: maps.uwuapps.org, or uwu://uwumaps/.
sealed class LinkTarget {
  const LinkTarget();
}

class ShortLink extends LinkTarget {
  const ShortLink(this.id);
  final String id;
}

class SelfLink extends LinkTarget {
  const SelfLink(this.payload);
  final Map<String, dynamic> payload;
}

class JoinLink extends LinkTarget {
  const JoinLink(this.code);
  final String code;
}

LinkTarget? parseLink(Uri uri) {
  final origin = Uri.parse(siteOrigin);
  final ours = (uri.scheme == 'uwu' && uri.host == 'uwumaps') || (uri.scheme == 'https' && uri.host == 'maps.uwuapps.org') || uri.host == origin.host;
  if (!ours) return null;
  final path = RegExp(r'^/(go|trip|eta|list)/([a-z0-9]{10})$').firstMatch(uri.path);
  if (path != null) return ShortLink(path[2]!);
  final fragment = uri.fragment;
  final short = RegExp(r'^share/([a-z0-9]{10})$').firstMatch(fragment);
  if (short != null) return ShortLink(short[1]!);
  final self = decodeSelf(fragment);
  if (self != null && self['kind'] != null && self['data'] != null && validSelfLink(self)) return SelfLink(self);
  final join = RegExp(r'^join=([A-Za-z0-9]+)$').firstMatch(fragment);
  if (join != null) return JoinLink(join[1]!);
  return null;
}

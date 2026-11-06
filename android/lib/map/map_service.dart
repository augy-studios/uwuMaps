// What the rest of the app asks of the map: moving it, putting things on it, and asking what's where.
// Everything set here is kept, and put back after a change of style.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../core/models.dart';
import '../core/prefs.dart';
import '../theme/tokens.dart';
import 'map_style.dart';

/// Where a drag on the orbit handle takes the camera, staying over the same spot: up tilts further, down
/// flattens, and sideways turns the view.
CameraPosition orbited(CameraPosition from, Offset drag) => CameraPosition(
      target: from.target,
      zoom: from.zoom,
      tilt: (from.tilt - drag.dy * 0.5).clamp(0.0, 60.0),
      bearing: (from.bearing + drag.dx * 0.8) % 360,
    );

const String _viewKey = 'uwumaps.view';
const String _layersKey = 'uwumaps.layers';

// Marina Bay: somewhere the 3D buildings show what they can do on a first visit.
const CameraPosition defaultView = CameraPosition(target: LatLng(1.2835, 103.8565), zoom: 15.3, tilt: 58, bearing: -20);

Map<String, dynamic> emptyCollection() => {'type': 'FeatureCollection', 'features': <Object>[]};

class MapService extends ChangeNotifier {
  MapLibreMapController? controller;
  BuiltStyle? style;
  bool styleLoaded = false;
  bool dark = false;
  Tokens? _tokens;
  ColorScheme? _scheme;
  final Map<String, Map<String, dynamic>> _data = {};
  Map<String, dynamic> layerState = Prefs.readJson<Map<String, dynamic>>(_layersKey, {});
  final List<void Function()> _onStyle = [];

  List<double>? _place;
  List<double>? _you;
  bool _youDot = false;

  /// Something else is taking the camera, so whatever was following you lets go of it.
  VoidCallback? onCameraTaken;

  /// The orbit handle is about to turn the view.
  VoidCallback? onOrbit;
  LatLon? _fromEnd;
  LatLon? _toEnd;

  bool isOn(String id) => (layerState[id] as bool?) ?? true;

  void setLayer(String id, bool on) {
    layerState[id] = on;
    Prefs.writeJson(_layersKey, layerState);
    _applyVisibility();
    notifyListeners();
  }

  void onStyleChange(void Function() fn) => _onStyle.add(fn);

  CameraPosition get initialView {
    final saved = Prefs.readJson<Map<String, dynamic>?>(_viewKey, null);
    if (saved == null) return defaultView;
    try {
      final c = saved['center'] as List<dynamic>;
      return CameraPosition(target: LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()), zoom: (saved['zoom'] as num).toDouble(), tilt: (saved['pitch'] as num).toDouble(), bearing: (saved['bearing'] as num).toDouble());
    } catch (_) {
      return defaultView;
    }
  }

  Future<void> prepareStyle(bool darkNow) async {
    dark = darkNow;
    style = await buildStyle(dark: dark, isOn: isOn);
  }

  /// The look changed: a new style if it went between light and dark, and new colours regardless.
  Future<void> applyTheme(Tokens tokens, ColorScheme scheme) async {
    final changedMode = tokens.dark != dark;
    _tokens = tokens;
    _scheme = scheme;
    if (changedMode) {
      await prepareStyle(tokens.dark);
      styleLoaded = false;
      await controller?.setStyle(style!.json);
    } else if (styleLoaded) {
      await _addImages();
      await _applyRouteColours();
    }
  }

  void attach(MapLibreMapController c) {
    controller = c;
  }

  Future<void> onStyleLoaded() async {
    styleLoaded = true;
    await _addImages();
    await _applyRouteColours();
    _applyVisibility();
    for (final e in _data.entries) {
      await controller?.setGeoJsonSource(e.key, e.value);
    }
    _drawMarkers();
    for (final fn in _onStyle) {
      fn();
    }
    notifyListeners();
  }

  void _applyVisibility() {
    final c = controller;
    if (c == null || !styleLoaded) return;
    mapLayersOf.forEach((id, layers) {
      for (final layer in layers) {
        unawaited(c.setLayerVisibility(layer, isOn(id)).catchError((Object _) {}));
      }
    });
  }

  Future<void> _applyRouteColours() async {
    final c = controller;
    final scheme = _scheme;
    final tokens = _tokens;
    if (c == null || scheme == null || tokens == null) return;
    // Material You draws the route in the phone's colours. uwuapps keeps the website's blue.
    final line = tokens.material ? _hex(scheme.primary) : '#3b8bff';
    final casing = tokens.material ? _hex(scheme.onPrimaryFixedVariant) : '#0b3d91';
    try {
      // All of each layer's properties: the plugin sends what's left out as null, which resets it.
      List<Object> widths(num a, num b) => ['interpolate', ['linear'], ['zoom'], 8, a, 16, b];
      await c.setLayerProperties('route-line', LineLayerProperties(lineColor: line, lineWidth: widths(3, 8), lineCap: 'round', lineJoin: 'round'));
      await c.setLayerProperties('route-casing', LineLayerProperties(lineColor: casing, lineWidth: widths(5, 12), lineCap: 'round', lineJoin: 'round'));
    } catch (err) {
      debugPrint('Route colours: $err');
    }
  }

  String _hex(Color c) => '#${c.toARGB32().toRadixString(16).padLeft(8, '0').substring(2)}';

  /* ---- images for the markers ---- */

  Future<Uint8List> _render(int size, void Function(Canvas c, double s) paint) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    paint(canvas, size.toDouble());
    final image = await recorder.endRecording().toImage(size, size);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    return png!.buffer.asUint8List();
  }

  Future<Uint8List> _pin(Color colour, Color fill) => _render(102, (c, s) {
        // The site's pin, at three times its 34px.
        c.scale(s / 24);
        final outline = Path()
          ..moveTo(12, 22)
          ..cubicTo(12, 22, 19.5, 15.2, 19.5, 9.7)
          ..arcToPoint(const Offset(4.5, 9.7), radius: const Radius.circular(7.5), rotation: 0, largeArc: true, clockwise: false)
          ..cubicTo(4.5, 15.2, 12, 22, 12, 22)
          ..close();
        c.drawShadow(outline, Colors.black, 1, true);
        c.drawPath(outline, Paint()..color = fill);
        c.drawPath(
          outline,
          Paint()
            ..color = colour
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.8
            ..strokeJoin = StrokeJoin.round,
        );
        c.drawCircle(const Offset(12, 9.7), 2.6, Paint()..color = colour);
      });

  Future<void> _addImages() async {
    final c = controller;
    final t = _tokens;
    if (c == null || t == null) return;
    try {
      final fill = t.dark ? const Color(0xFF20262A) : Colors.white;
      await c.addImage('uwu-pin', await _pin(t.error, fill), false, 3);
      await c.addImage('uwu-pin-from', await _pin(t.ok, fill), false, 3);
      await c.addImage(
        'uwu-you',
        await _render(96, (canvas, s) {
          final centre = Offset(s / 2, s / 2);
          final blue = t.material ? (_scheme?.primary ?? t.busy) : t.busy;
          canvas.drawCircle(centre, s / 2, Paint()..color = blue.withValues(alpha: 0.28));
          canvas.drawCircle(centre, s * 0.32, Paint()..color = t.dark ? const Color(0xFF20262A) : Colors.white);
          canvas.drawCircle(centre, s * 0.22, Paint()..color = blue);
        }),
        false,
        3,
      );
      await c.addImage(
        'uwu-arrow',
        await _render(32, (canvas, s) {
          final path = Path()
            ..moveTo(16, 3)
            ..lineTo(25, 22)
            ..lineTo(16, 17)
            ..lineTo(7, 22)
            ..close();
          canvas.drawPath(path, Paint()..color = Colors.white);
        }),
        false,
        2,
      );
    } catch (err) {
      debugPrint('Map images: $err');
    }
  }

  /* ---- sources ---- */

  Future<void> setData(String id, Map<String, dynamic> data) async {
    _data[id] = data;
    if (styleLoaded) {
      try {
        await controller?.setGeoJsonSource(id, data);
      } catch (err) {
        debugPrint('Setting $id: $err');
      }
    }
  }

  /* ---- markers ---- */

  void _drawMarkers() {
    Map<String, dynamic> f(double lat, double lon, String kind, [String icon = '']) => {
          'type': 'Feature',
          'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
          'properties': {'kind': kind, 'icon': icon},
        };
    final features = <Object>[
      if (_you != null && !_youDot) f(_you![0], _you![1], 'you'),
      if (_fromEnd != null) f(_fromEnd!.lat, _fromEnd!.lon, 'from', 'uwu-pin-from'),
      if (_toEnd != null) f(_toEnd!.lat, _toEnd!.lon, 'to', 'uwu-pin'),
      if (_place != null) f(_place![0], _place![1], 'place', 'uwu-pin'),
    ];
    unawaited(setData('markers', {'type': 'FeatureCollection', 'features': features}));
  }

  void setPlaceMarker(double lat, double lon) {
    _place = [lat, lon];
    _drawMarkers();
  }

  void clearPlaceMarker() {
    _place = null;
    _drawMarkers();
  }

  /// From here on you're MapLibre's live dot, so the one-off marker stays out of its way.
  void useYouDot() {
    _youDot = true;
    _drawMarkers();
  }

  /// Moves the live dot, and the camera with it if it's following.
  void showYou(double lat, double lon, {double? accuracy, double? bearing, double? speed}) {
    unawaited(controller
        ?.updateManualLocation(ManualLocationUpdate(target: LatLng(lat, lon), horizontalAccuracy: accuracy, bearing: bearing, speed: speed))
        .catchError((Object err) => debugPrint('showYou: $err')));
  }

  void setYouMarker(double lat, double lon) {
    _you = [lat, lon];
    _drawMarkers();
  }

  void setEndMarkers(LatLon? from, LatLon? to) {
    _fromEnd = from;
    _toEnd = to;
    _drawMarkers();
  }

  bool get hasPlaceMarker => _place != null;

  /* ---- the route ---- */

  List<List<double>>? routeCoords;

  void showRoute(List<List<double>> coords) {
    routeCoords = coords;
    unawaited(setData('route', {
      'type': 'Feature',
      'geometry': {'type': 'LineString', 'coordinates': coords},
      'properties': <String, Object>{},
    }));
  }

  void clearRoute() {
    routeCoords = null;
    unawaited(setData('route', emptyCollection()));
  }

  /* ---- moving ---- */

  CameraPosition get camera => controller?.cameraPosition ?? initialView;

  CameraPosition? _orbitGoal;
  bool _orbitSending = false;

  void saveView() {
    final c = controller?.cameraPosition;
    if (c == null) return;
    Prefs.writeJson(_viewKey, {
      'center': [c.target.longitude, c.target.latitude],
      'zoom': c.zoom,
      'pitch': c.tilt,
      'bearing': c.bearing,
    });
  }

  Future<void> flyTo(double lat, double lon, {double? zoom}) async {
    onCameraTaken?.call();
    final z = math.max(camera.zoom, zoom ?? 16);
    await controller?.animateCamera(CameraUpdate.newCameraPosition(CameraPosition(target: LatLng(lat, lon), zoom: z, tilt: camera.tilt, bearing: camera.bearing)), duration: const Duration(milliseconds: 900));
  }

  Future<void> easeTo(double lat, double lon, {required double zoom, required double tilt, required double bearing}) async {
    await controller?.animateCamera(CameraUpdate.newCameraPosition(CameraPosition(target: LatLng(lat, lon), zoom: zoom, tilt: tilt, bearing: bearing)), duration: const Duration(milliseconds: 800));
  }

  Future<void> zoomBy(double delta) async {
    await controller?.animateCamera(CameraUpdate.zoomBy(delta), duration: const Duration(milliseconds: 250));
  }

  Future<void> resetNorth() async {
    onCameraTaken?.call();
    final c = camera;
    await controller?.animateCamera(CameraUpdate.newCameraPosition(CameraPosition(target: c.target, zoom: c.zoom, tilt: 0, bearing: 0)), duration: const Duration(milliseconds: 400));
  }

  /// A new drag on the orbit handle, which starts from wherever the camera is now.
  void orbitStart() {
    _orbitGoal = null;
    onOrbit?.call();
  }

  /// Tilts and turns by a drag on the handle. A drag comes faster than the map answers, so only the latest
  /// goal is sent. Anything else moving the map meanwhile, such as navigation following along, keeps its place.
  void orbitBy(Offset drag) {
    final goal = _orbitGoal;
    final c = camera;
    _orbitGoal = orbited(goal == null ? c : CameraPosition(target: c.target, zoom: c.zoom, tilt: goal.tilt, bearing: goal.bearing), drag);
    unawaited(_sendOrbit());
  }

  Future<void> _sendOrbit() async {
    if (_orbitSending) return;
    _orbitSending = true;
    try {
      CameraPosition? sent;
      while (_orbitGoal != null && _orbitGoal != sent) {
        sent = _orbitGoal;
        await controller?.moveCamera(CameraUpdate.newCameraPosition(sent!));
      }
    } finally {
      _orbitSending = false;
    }
  }

  /// Fits points in, leaving room for the panels and for the tray along the right.
  Future<void> fitCoords(List<List<double>> coords, Size screen) async {
    final c = controller;
    if (c == null || coords.isEmpty) return;
    onCameraTaken?.call();
    var w = coords.first[0];
    var e = w;
    var s = coords.first[1];
    var n = s;
    for (final p in coords) {
      w = math.min(w, p[0]);
      e = math.max(e, p[0]);
      s = math.min(s, p[1]);
      n = math.max(n, p[1]);
    }
    if (w == e && s == n) {
      await flyTo(s, w);
      return;
    }
    final narrow = screen.width <= 920;
    // Narrow, the panel takes up to 46% of the height from the bottom.
    final left = narrow ? 30.0 : 420.0;
    final right = narrow ? 70.0 : 80.0;
    const top = 80.0;
    final bottom = narrow ? screen.height * 0.5 : 60.0;
    // One move to where it all fits, face on and flat, as the website's fitBounds makes. As three moves, one
    // after another, the map could still be on its way when somebody looked.
    double worldX(double lon) => (lon + 180) / 360;
    double worldY(double lat) {
      final r = lat * math.pi / 180;
      return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2;
    }

    final dx = worldX(e) - worldX(w);
    final dy = worldY(s) - worldY(n);
    double log2(double v) => math.log(v) / math.ln2;
    final zoom = [
      16.0,
      if (dx > 0) log2((screen.width - left - right) / (dx * 512)),
      if (dy > 0) log2((screen.height - top - bottom) / (dy * 512)),
    ].reduce(math.min);
    final scale = 512 * math.pow(2, zoom);
    // The middle of the room left between the panels, rather than of the screen.
    final x = (worldX(w) + worldX(e)) / 2 - (left - right) / 2 / scale;
    final y = (worldY(n) + worldY(s)) / 2 - (top - bottom) / 2 / scale;
    final lon = x * 360 - 180;
    final lat = math.atan((math.exp(math.pi * (1 - 2 * y)) - math.exp(-math.pi * (1 - 2 * y))) / 2) * 180 / math.pi;
    await c.animateCamera(CameraUpdate.newCameraPosition(CameraPosition(target: LatLng(lat, lon), zoom: zoom, tilt: 0, bearing: 0)), duration: const Duration(milliseconds: 700));
  }

  Future<List<double>?> visibleBounds() async {
    try {
      final b = await controller?.getVisibleRegion();
      return b == null ? null : [b.southwest.longitude, b.southwest.latitude, b.northeast.longitude, b.northeast.latitude];
    } catch (_) {
      return null;
    }
  }

  /* ---- what's where ---- */

  Future<List<Map<String, dynamic>>> queryBox(Offset at, double half, List<String> layers) async {
    final c = controller;
    if (c == null || layers.isEmpty) return const [];
    try {
      final rect = Rect.fromCenter(center: at, width: half * 2, height: half * 2);
      final raw = await c.queryRenderedFeaturesInRect(rect, layers, null);
      return raw.map<Map<String, dynamic>>((f) => f is String ? jsonDecode(f) as Map<String, dynamic> : Map<String, dynamic>.from(f as Map)).toList();
    } catch (err) {
      debugPrint('Query: $err');
      return const [];
    }
  }

  /// How many features of these layers are on screen now. For the tests.
  Future<int> renderedCount(List<String> layers, Size screen) async {
    final c = controller;
    if (c == null) return 0;
    try {
      final raw = await c.queryRenderedFeaturesInRect(Offset.zero & screen, layers, null);
      return raw.length;
    } catch (_) {
      return -1;
    }
  }
}

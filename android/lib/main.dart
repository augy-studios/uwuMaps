// uwuMaps for Android. Native rather than a web page in a WebView: Flutter draws the app, MapLibre Native
// draws the map, and the Dart code here does what main-site/js does on the website.

import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import 'app.dart';
import 'core/config.dart';
import 'core/models.dart';
import 'core/net.dart';
import 'core/prefs.dart';
import 'core/test_hook.dart';
import 'map/tile_server.dart';
import 'theme/tokens.dart';
import 'ui/home_screen.dart';
import 'ui/nearby_sheet.dart';
import 'ui/widgets.dart';

final GlobalKey<HomeScreenState> _home = GlobalKey<HomeScreenState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Prefs.init();
  await Net.init();
  app = App();
  await app.theme.init();
  await app.packs.init();
  await TileServer.start(app.packs.installedList);
  app.packs.onChanged = TileServer.updatePacks;
  await app.map.prepareStyle(app.theme.isDark);
  unawaited(app.updater.init());
  if (kIsWeb) {
    // The test build's copy of MapLibre, from the same vendored file the website ships.
    MapLibreJsSource.configured = const MapLibreJsSource.urls(scriptUrl: '/__vendor/maplibre/maplibre-gl.mjs', styleUrl: '/__vendor/maplibre/maplibre-gl.css');
  }
  if (testBuild) SemanticsBinding.instance.ensureSemantics();
  _installTestHook();
  runApp(const UwuMapsApp());
}

class UwuMapsApp extends StatefulWidget {
  const UwuMapsApp({super.key});
  @override
  State<UwuMapsApp> createState() => _UwuMapsAppState();
}

class _UwuMapsAppState extends State<UwuMapsApp> {
  StreamSubscription<Uri>? _links;

  @override
  void initState() {
    super.initState();
    app.theme.addListener(_applyTheme);
    WidgetsBinding.instance.addPostFrameCallback((_) => _startLinks());
  }

  @override
  void dispose() {
    app.theme.removeListener(_applyTheme);
    _links?.cancel();
    super.dispose();
  }

  void _applyTheme() {
    if (mounted) setState(() {});
  }

  Future<void> _startLinks() async {
    void open(Uri uri) {
      // Once the map's there to show it on.
      Future<void>.delayed(const Duration(milliseconds: 600), () => app.share.openLink(uri));
    }

    if (kIsWeb) {
      if (Uri.base.fragment.isNotEmpty || Uri.base.path.length > 1) open(Uri.base);
      return;
    }
    try {
      final links = AppLinks();
      _links = links.uriLinkStream.listen(open);
    } catch (err) {
      debugPrint('Links: $err');
    }
  }

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final theme = app.theme.build(lightDynamic, darkDynamic);
        app.theme.applySystemBars();
        WidgetsBinding.instance.addPostFrameCallback((_) {
          unawaited(app.map.applyTheme(theme.extension<Tokens>()!, theme.colorScheme));
        });
        return MaterialApp(
          title: 'uwuMaps',
          debugShowCheckedModeBanner: false,
          navigatorKey: app.navigatorKey,
          theme: theme,
          themeAnimationDuration: const Duration(milliseconds: 220),
          home: HomeScreen(key: _home),
          builder: (context, child) => Stack(
            children: [
              child!,
              ToastLayer(toasts: app.toastNotifier),
            ],
          ),
        );
      },
    );
  }
}

/* ---- what the browser tests ask ---- */

void _installTestHook() {
  installTestHook(
    () {
      final th = app.theme;
      final d = app.directions;
      final cam = app.map.camera;
      final context = app.navigatorKey.currentContext;
      final theme = context == null ? null : Theme.of(context);
      final style = theme?.textTheme.bodyMedium;
      final t = theme?.extension<Tokens>();
      return jsonEncode({
        'materialYou': th.materialYou,
        'phoneColours': th.phoneColours,
        'phoneFont': th.phoneFont,
        'dark': th.isDark,
        'modePreference': th.modePreference,
        'colorTheme': th.colorTheme,
        'fontFamily': style?.fontFamily,
        'primary': theme?.colorScheme.primary.toARGB32(),
        'page': t?.page.toARGB32(),
        'tokensMaterial': t?.material,
        'styleLoaded': app.map.styleLoaded,
        'mapDark': app.map.dark,
        'camera': {'lat': cam.target.latitude, 'lon': cam.target.longitude, 'zoom': cam.zoom, 'tilt': cam.tilt, 'bearing': cam.bearing},
        'trayOpen': _home.currentState?.trayOpen,
        'directionsOpen': d.open,
        'from': d.from?.name,
        'to': d.to?.name,
        'mode': d.mode,
        'status': d.status,
        'route': d.route == null ? null : {'distance': d.route!.distance, 'duration': d.route!.duration, 'source': d.route!.source, 'steps': d.route!.steps.length},
        'place': app.currentPlace.value?.name,
        'placeSub': app.currentPlace.value?.sub,
        'doorCodes': app.currentPlace.value?.doorCodes,
        'navigating': app.navigation.active,
        'navText': app.navigation.nextStep?.text,
        'navEnd': app.navigation.route?.coords.last,
        'installed': app.packs.installed.keys.toList(),
        'downloading': app.packs.downloads.map((k, v) => MapEntry(k, {'done': v.done, 'total': v.total, 'error': v.error})),
        'catalogue': app.packs.catalogue.keys.toList(),
        'saved': app.places.saved.map((p) => p.name).toList(),
        'syncCode': app.places.syncCode,
        'syncState': app.places.syncState,
        'toast': app.toastNotifier.value?.message,
        'online': Net.online.value,
        'layers': app.map.layerState,
        'updateAvailable': app.updater.available?.version,
        'shareUrl': app.share.card?.url,
        'eta': app.share.watching?.title,
        'nearbyCode': shownNearbyCode,
      });
    },
    (method, arg) async {
      switch (method) {
        case 'rendered':
          return '${await app.map.renderedCount((jsonDecode(arg) as List<dynamic>).cast<String>(), app.screen)}';
        case 'jumpTo':
          final v = jsonDecode(arg) as Map<String, dynamic>;
          await app.map.controller?.moveCamera(CameraUpdate.newCameraPosition(CameraPosition(target: LatLng((v['lat'] as num).toDouble(), (v['lon'] as num).toDouble()), zoom: (v['zoom'] as num).toDouble(), tilt: (v['tilt'] as num?)?.toDouble() ?? 0, bearing: (v['bearing'] as num?)?.toDouble() ?? 0)));
          return 'ok';
        case 'position':
          final v = jsonDecode(arg) as Map<String, dynamic>;
          app.navigation.onPosition((v['lat'] as num).toDouble(), (v['lon'] as num).toDouble());
          return 'ok';
        case 'showPlace':
          final v = jsonDecode(arg) as Map<String, dynamic>;
          app.showPlace(Place(name: v['name'] as String, lat: (v['lat'] as num).toDouble(), lon: (v['lon'] as num).toDouble()));
          return 'ok';
        case 'openLink':
          return '${app.share.openLink(Uri.parse(arg))}';
        case 'online':
          Net.online.value = arg == 'true';
          return 'ok';
        case 'tapMap':
          final v = jsonDecode(arg) as Map<String, dynamic>;
          final p = await app.map.controller!.toScreenLocation(LatLng((v['lat'] as num).toDouble(), (v['lon'] as num).toDouble()));
          return jsonEncode({'x': p.x, 'y': p.y});
      }
      return 'unknown';
    },
  );
}

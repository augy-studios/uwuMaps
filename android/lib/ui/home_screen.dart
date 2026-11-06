// The one screen: the map, and everything that floats over it.

import 'dart:async';
import 'dart:math' as math;
import 'dart:math' show Point;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:maplibre_gl/maplibre_gl.dart';

import '../app.dart';
import '../core/device.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../theme/app_icon.dart';
import '../theme/tokens.dart';
import '../update/update_page.dart';
import 'edge_tray.dart';
import 'nearby_sheet.dart';
import 'panels.dart';
import 'sheets.dart';
import 'widgets.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  final _trayKey = GlobalKey<EdgeTrayState>();
  bool _trayOpen = EdgeTray.startsOpen;
  Timer? _searchTimer;
  int _asked = 0;
  List<Place> _results = const [];
  bool _showResults = false;
  double _bannerHeight = 0;

  EdgeTrayState? get tray => _trayKey.currentState;
  bool get trayOpen => _trayOpen;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    app.share.showShareSheet = (card) => openShareSheet(_sheetContext, card);
    app.share.showListSheet = (data) => openListSheet(_sheetContext, data);
    app.share.showJoin = (code) => openNearby(_sheetContext, join: code);
    app.map.onStyleChange(() => app.transit.loadVisible());
    Net.online.addListener(_onOnline);
    app.places.init();
  }

  BuildContext get _sheetContext => app.navigatorKey.currentContext ?? context;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    Net.online.removeListener(_onOnline);
    _searchTimer?.cancel();
    _search.dispose();
    _searchFocus.dispose();
    super.dispose();
  }

  void _onOnline() {
    app.transit.refreshLive();
    if (mounted) setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final on = state == AppLifecycleState.resumed;
    app.transit.setForeground(on);
    if (on) app.updater.onResume();
  }

  /* ---- the map ---- */

  Future<Place?> _placeAt(Point<double> point, LatLng at) async {
    final offset = Offset(point.x, point.y);
    final saved = await app.places.savedAt(offset);
    if (saved != null) return saved;
    final transit = await app.transit.cardAt(offset);
    if (transit != null) return transit;
    final names = await app.map.queryBox(offset, 8, app.map.style?.symbolLayers ?? const []);
    for (final f in names) {
      final props = f['properties'];
      if (props is! Map) continue;
      final name = (props['name:en'] ?? props['name']) as String?;
      if (name == null || name.isEmpty) continue;
      final geom = f['geometry'];
      if (geom is Map && geom['type'] == 'Point') {
        final c = geom['coordinates'] as List<dynamic>;
        return Place(name: name, lat: (c[1] as num).toDouble(), lon: (c[0] as num).toDouble());
      }
      return Place(name: name, lat: at.latitude, lon: at.longitude);
    }
    return null;
  }

  Future<void> _onMapTap(Point<double> point, LatLng at) async {
    if (app.navigation.active) return;
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => _showResults = false);
    final place = await _placeAt(point, at);
    if (!mounted) return;
    final d = app.directions;
    if (d.open) {
      if (!d.pickFromMap(place ?? Place(name: 'Dropped pin', lat: at.latitude, lon: at.longitude))) {
        app.toast('Press the pin beside From or To to change it');
      }
      return;
    }
    if (place != null) {
      app.showPlace(place, fly: false);
      return;
    }
    if (app.currentPlace.value == null) {
      app.showPlace(Place(name: 'Dropped pin', lat: at.latitude, lon: at.longitude), fly: false);
    } else {
      app.hidePlace();
    }
  }

  /* ---- searching ---- */

  void _typed(String value) {
    _searchTimer?.cancel();
    _searchTimer = Timer(const Duration(milliseconds: 250), () => _runSearch(value));
  }

  Future<void> _runSearch(String value) async {
    final q = value.trim();
    if (q.length < 2) {
      setState(() => _showResults = false);
      return;
    }
    final id = ++_asked;
    final c = app.map.camera.target;
    final found = await app.search.find(q, near: LatLon(c.latitude, c.longitude), saved: app.places.saved);
    // Only the newest question's answer is wanted.
    if (id != _asked || !mounted) return;
    setState(() {
      _results = found;
      _showResults = true;
    });
  }

  void _pickResult(Place r) {
    setState(() => _showResults = false);
    _search.text = r.name;
    FocusManager.instance.primaryFocus?.unfocus();
    app.directions.close();
    app.showPlace(r);
  }

  /* ---- the tray ---- */

  Future<void> _locate() async {
    try {
      final pos = await locate();
      app.map.setYouMarker(pos.lat, pos.lon);
      await app.map.flyTo(pos.lat, pos.lon);
    } on LocationFailure catch (err) {
      app.toast(locationMessage(err), error: true);
    }
  }

  Future<void> _checkForUpdates(BuildContext c) => openUpdatePage(c, checkOnly: true);

  Future<bool> _onBack() async {
    if (_showResults) {
      setState(() => _showResults = false);
      return true;
    }
    if (app.directions.open) {
      app.directions.close();
      return true;
    }
    if (app.currentPlace.value != null) {
      app.hidePlace();
      return true;
    }
    if (app.share.watching != null) {
      app.share.closeEtaView();
      return true;
    }
    // At the first screen, leaves rather than closes, so the map keeps where it was.
    await Device.moveToBack();
    return true;
  }

  /* ---- drawing ---- */

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final m = MediaQuery.of(context);
    app.screen = m.size;
    final safeTop = m.padding.top;
    final trayTop = math.max(_bannerHeight + 14, safeTop + 14);

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onBack();
      },
      child: AnnotatedRegion<SystemUiOverlayStyle>(
        value: SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          systemNavigationBarColor: Colors.transparent,
          statusBarIconBrightness: t.dark ? Brightness.light : Brightness.dark,
          systemNavigationBarIconBrightness: t.dark ? Brightness.light : Brightness.dark,
        ),
        child: Scaffold(
          resizeToAvoidBottomInset: false,
          backgroundColor: t.page,
          body: Stack(
            children: [
              AnimatedPositioned(
                duration: const Duration(milliseconds: 200),
                left: 0,
                right: 0,
                bottom: 0,
                top: _bannerHeight,
                child: _MapView(onTap: _onMapTap, background: t.page),
              ),
              // The clock and icons stay readable over the map, where the status bar shows. Flat, and fading
              // to nothing, so it reads as part of the bar rather than a shape on the map.
              if (safeTop > 0 && _bannerHeight == 0)
                Positioned(
                  left: 0,
                  right: 0,
                  top: 0,
                  height: safeTop + 16,
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, stops: const [0, 0.55, 1], colors: [t.page.withValues(alpha: 0.85), t.page.withValues(alpha: 0.7), t.page.withValues(alpha: 0)]),
                      ),
                    ),
                  ),
                ),
              ListenableBuilder(
                listenable: Listenable.merge([app.directions, app.navigation, app.currentPlace, app.share, app.packs, app.updater, Net.online]),
                builder: (context, _) => Stack(children: _overlays(context, trayTop)),
              ),
              Positioned(left: 0, right: 0, top: 0, child: _UpdateBar(onHeight: (h) {
                if (h != _bannerHeight) setState(() => _bannerHeight = h);
              })),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _overlays(BuildContext context, double trayTop) {
    final t = context.t;
    final m = MediaQuery.of(context);
    final d = app.directions;
    final n = app.navigation;
    final place = app.currentPlace.value;
    final eta = app.share.watching;
    final narrow = m.size.width <= 920;
    final height = m.size.height;
    final btn = m.size.width <= 480 ? 40.0 : 44.0;
    final edge = (m.size.width <= 480 ? 10.0 : 16.0) + m.padding.right;

    // On a phone a panel stops short of the tray's column, so nothing in it ends up under the tray, and on
    // a screen too short for both it's the tray that scrolls.
    final trayBottom = trayTop + 8 * btn + 5 + 8 * 8;
    final beneathTray = height - trayBottom - m.padding.bottom - 24;
    final panelMax = narrow ? math.min(height * 0.62, math.max(beneathTray, height * 0.4)) : math.min(height * 0.62, height - _bannerHeight - 130);
    final dirMax = narrow ? height * 0.46 : height - _bannerHeight - 40;
    final panelUp = place != null || d.open || eta != null;
    final trayMax = narrow && panelUp ? math.max(btn, height - m.padding.bottom - 12 - (d.open ? dirMax : panelMax) - trayTop - 8) : null;

    final topbarWidth = narrow
        ? (_trayOpen ? math.min(360.0, m.size.width - 24 - btn - edge - 32) : math.min(360.0, m.size.width - 24 - 34))
        : 360.0;

    return [
      // Out of the way of a panel that's taking the bottom of a phone's screen.
      if (!(narrow && (place != null || d.open || eta != null || n.active))) MapControls(right: edge - 2, bottom: m.padding.bottom + 44, service: app.map),
      if (!d.open && !n.active)
        AnimatedPositioned(
          duration: const Duration(milliseconds: 340),
          curve: trayEase,
          left: 12 + m.padding.left,
          top: trayTop,
          width: topbarWidth,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Align(alignment: Alignment.centerLeft, child: _Brand(t: t)),
              const SizedBox(height: 8),
              _SearchBox(controller: _search, focusNode: _searchFocus, onChanged: _typed, onSubmitted: _runSearch),
              if (_showResults) ...[
                const SizedBox(height: 8),
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: height * 0.46),
                  child: Panel(
                    radius: 14,
                    padding: const EdgeInsets.all(4),
                    child: SuggestionList(results: _results, emptyText: 'Nothing found. Saved areas are searched offline.', onPick: _pickResult),
                  ),
                ),
              ],
            ],
          ),
        ),
      if (place != null && !d.open)
        PanelSlot(visible: true, maxHeight: panelMax, child: PlaceCard(key: ValueKey('${place.lat},${place.lon}'), place: place)),
      PanelSlot(
        visible: d.open,
        maxHeight: dirMax,
        topAligned: !narrow,
        topOffset: trayTop,
        child: const DirectionsPanel(),
      ),
      if (eta != null)
        PanelSlot(
          visible: true,
          maxHeight: panelMax,
          child: Panel(
            padding: const EdgeInsets.all(14),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SheetHead(title: eta.title, onClose: app.share.closeEtaView),
                if (eta.detail.isNotEmpty) ...[const SizedBox(height: 6), Muted(eta.detail)],
              ],
            ),
          ),
        ),
      if (n.active) Positioned.fill(child: NavHud(top: trayTop)),
      Positioned(
        top: trayTop,
        right: 0,
        child: _Tray(
          trayKey: _trayKey,
          maxHeight: trayMax,
          onChanged: (open) => setState(() => _trayOpen = open),
          directionsOpen: d.open,
          onDirections: () {
            if (d.open) {
              d.close();
            } else {
              d.openPanel();
            }
          },
          onLocate: _locate,
          onCheckUpdates: _checkForUpdates,
        ),
      ),
    ];
  }

}

class _Tray extends StatelessWidget {
  const _Tray({required this.trayKey, this.maxHeight, required this.onChanged, required this.directionsOpen, required this.onDirections, required this.onLocate, required this.onCheckUpdates});
  final GlobalKey<EdgeTrayState> trayKey;
  final double? maxHeight;
  final ValueChanged<bool> onChanged;
  final bool directionsOpen;
  final VoidCallback onDirections;
  final VoidCallback onLocate;
  final void Function(BuildContext) onCheckUpdates;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return EdgeTray(
      key: trayKey,
      maxHeight: maxHeight,
      onChanged: onChanged,
      buttons: [
        TrayButton('directions', 'Directions', onDirections, selected: directionsOpen),
        TrayButton('bookmark', 'Saved places', () => openSaved(context)),
        TrayButton('download', 'Offline maps', () => openPacks(context)),
        null,
        TrayButton('locate', 'My location', onLocate),
        TrayButton('layers', 'Layers', () => openLayers(context)),
        TrayButton('nearby', 'Send to a device nearby', () => openNearby(context)),
        TrayButton('update', 'Check for updates', () => onCheckUpdates(context)),
        TrayButton(t.material ? 'settings' : (t.dark ? 'moon' : 'sun'), 'Settings', () => openSettings(context)),
      ],
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand({required this.t});
  final Tokens t;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(4, 4, 12, 4),
        decoration: BoxDecoration(color: t.panel, borderRadius: BorderRadius.circular(999), boxShadow: t.shadow),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClipOval(child: Image.asset('assets/app-icon.png', width: 32, height: 32, excludeFromSemantics: true)),
            const SizedBox(width: 8),
            Semantics(header: true, child: Text('uwuMaps', style: TextStyle(fontSize: 16, color: t.brandInk))),
          ],
        ),
      );
}

class _SearchBox extends StatelessWidget {
  const _SearchBox({required this.controller, required this.focusNode, required this.onChanged, required this.onSubmitted});
  final TextEditingController controller;
  final FocusNode focusNode;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Panel(
      radius: t.material ? 24 : 14,
      child: SizedBox(
        height: 44,
        child: Row(
          children: [
            const SizedBox(width: 12),
            AppIcon('search', size: 18, color: t.mutedStrong),
            const SizedBox(width: 8),
            Expanded(
              child: NamedField(
                name: 'Search places',
                child: TextField(
                  controller: controller,
                  focusNode: focusNode,
                  onChanged: onChanged,
                  onSubmitted: onSubmitted,
                  textInputAction: TextInputAction.search,
                  autocorrect: false,
                  style: TextStyle(color: t.ink, fontSize: 16),
                  decoration: InputDecoration(
                    border: InputBorder.none,
                    isDense: true,
                    hint: ExcludeSemantics(child: Text('Search places', style: TextStyle(color: t.mutedStrong, fontSize: 16))),
                    filled: false,
                    contentPadding: const EdgeInsets.symmetric(vertical: 11),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
          ],
        ),
      ),
    );
  }
}

class _MapView extends StatefulWidget {
  const _MapView({required this.onTap, required this.background});
  final void Function(Point<double>, LatLng) onTap;
  final Color background;

  @override
  State<_MapView> createState() => _MapViewState();
}

class _MapViewState extends State<_MapView> {
  // Built once: the widget's style never changes, and later changes go through the controller.
  late final String _style = app.map.style!.json;
  late final CameraPosition _start = app.map.initialView;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: MapLibreMap(
        styleString: _style,
        initialCameraPosition: _start,
        // A TextureView, so Flutter draws the map into its own frame: the map's updates reach the screen as
        // they happen, and the glass over it can blur it. On the default SurfaceView, labels stayed frozen
        // part way through fading in until something else on screen moved. They appear without that fade.
        androidView: const AndroidMapView(surface: AndroidMapSurface.textureView),
        symbolPlacementTransitionsEnabled: false,
        trackCameraPosition: true,
        compassEnabled: false,
        logoEnabled: false,
        attributionEnabled: true,
        attributionButtonPosition: AttributionButtonPosition.bottomLeft,
        attributionButtonMargins: Point<double>(4 + MediaQuery.of(context).padding.left, 4 + MediaQuery.of(context).padding.bottom),
        foregroundLoadColor: widget.background,
        rotateGesturesEnabled: true,
        tiltGesturesEnabled: true,
        onMapCreated: app.map.attach,
        onStyleLoadedCallback: app.map.onStyleLoaded,
        onMapClick: widget.onTap,
        onCameraIdle: () {
          app.map.saveView();
          app.transit.loadVisible();
        },
      ),
    );
  }
}

/// The bar at the very top: one bar, one state. Being offline outranks a new version being ready.
class _UpdateBar extends StatefulWidget {
  const _UpdateBar({required this.onHeight});
  final ValueChanged<double> onHeight;
  @override
  State<_UpdateBar> createState() => _UpdateBarState();
}

class _UpdateBarState extends State<_UpdateBar> {
  final _key = GlobalKey();

  void _report() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final h = _key.currentContext?.size?.height ?? 0;
      if (mounted) widget.onHeight(h);
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return ListenableBuilder(
      listenable: Listenable.merge([Net.online, app.updater]),
      builder: (context, _) {
        final offline = !Net.online.value;
        final release = app.updater.available;
        final showUpdate = release != null && !app.updater.dismissed;
        _report();
        if (!offline && !showUpdate) return SizedBox.shrink(key: _key);
        final material = t.material;
        final scheme = Theme.of(context).colorScheme;
        final fill = material ? scheme.secondaryContainer : Color.alphaBlend(mix(t.brandFill, 0.3, transparentInk), t.bg);
        final ink = material ? scheme.onSecondaryContainer : t.ink;
        return Semantics(
          container: true,
          liveRegion: true,
          label: offline ? 'Connection' : 'Update',
          child: Container(
            key: _key,
            decoration: BoxDecoration(color: fill, border: material ? null : Border(bottom: BorderSide(color: mix(t.ink, 0.12, transparentInk)))),
            padding: EdgeInsets.fromLTRB(16, math.max(8, MediaQuery.of(context).padding.top), 16, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    offline ? "You're offline. Saved areas still work." : 'Version ${release!.version} of the uwuMaps app is out.',
                    style: TextStyle(fontSize: 14, color: ink),
                  ),
                ),
                if (!offline) ...[
                  const SizedBox(width: 12),
                  AppButton('Update', kind: BtnKind.primary, onPressed: () => openUpdatePage(context, checkOnly: false)),
                  const SizedBox(width: 8),
                  AppButton('Not now', kind: BtnKind.quiet, onPressed: app.updater.dismiss),
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

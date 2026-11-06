// The panels that float over the map: a place's card, planning a route, navigating, and following somebody
// else's trip.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../map/map_service.dart';
import '../nav/directions.dart';
import '../theme/app_icon.dart';
import '../theme/tokens.dart';
import '../transit/doors.dart';
import 'widgets.dart';

/// Where a panel sits: bottom left on a wide screen, across the bottom on a phone.
class PanelSlot extends StatelessWidget {
  const PanelSlot({super.key, required this.visible, required this.child, required this.maxHeight, this.topAligned = false, this.topOffset = 0, this.width = 380});
  final bool visible;
  final Widget child;
  final double maxHeight;
  final bool topAligned;
  final double topOffset;
  final double width;

  @override
  Widget build(BuildContext context) {
    final m = MediaQuery.of(context);
    final left = 12 + m.padding.left;
    final panelWidth = (m.size.width - 24).clamp(0.0, width);
    final bottom = (m.viewInsets.bottom > 0 ? m.viewInsets.bottom : m.padding.bottom) + 12;
    return Positioned(
      left: left,
      top: topAligned ? topOffset : null,
      bottom: topAligned ? null : bottom,
      width: panelWidth,
      child: IgnorePointer(
        ignoring: !visible,
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: const Duration(milliseconds: 180),
          child: AnimatedSlide(
            offset: visible ? Offset.zero : const Offset(0, 0.05),
            duration: const Duration(milliseconds: 220),
            curve: trayEase,
            child: ExcludeSemantics(
              excluding: !visible,
              child: ConstrainedBox(constraints: BoxConstraints(maxHeight: maxHeight), child: child),
            ),
          ),
        ),
      ),
    );
  }
}

/* ---- a place's card ---- */

class PlaceCard extends StatelessWidget {
  const PlaceCard({super.key, required this.place});
  final Place place;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Panel(
      padding: EdgeInsets.all(t.material ? 16 : 14),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            SheetHead(title: place.name, sub: place.sub.isNotEmpty ? place.sub : '${place.lat.toStringAsFixed(5)}, ${place.lon.toStringAsFixed(5)}', onClose: app.hidePlace),
            const SizedBox(height: 10),
            ListenableBuilder(
              listenable: app.places,
              builder: (_, _) => Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppButton('Directions', icon: 'directions', kind: BtnKind.primary, onPressed: () => app.directions.openPanel(from: herePlace, to: place, setFrom: true, setTo: true)),
                  AppButton('From here', icon: 'pin', onPressed: () => app.directions.openPanel(from: place, to: null, setFrom: true, setTo: true)),
                  AppButton(app.places.isSaved(place) ? 'Saved' : 'Save', icon: 'bookmark', onPressed: () {
                    if (app.places.isSaved(place)) {
                      app.places.forget(place);
                    } else {
                      app.places.save(place);
                    }
                  }),
                  AppButton('Share', icon: 'share', onPressed: () => app.share.sharePlace(place)),
                ],
              ),
            ),
            if (place.links.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final l in place.links)
                    AppButton(l.text, icon: l.icon, onPressed: () => launchUrl(Uri.parse(l.href), mode: LaunchMode.externalApplication)),
                ],
              ),
            ],
            // Under the buttons, so a tall set of doors doesn't push them off a phone's screen.
            if (place.doorCodes.isNotEmpty) ...[const SizedBox(height: 10), DoorsCarousel(key: ValueKey(place.doorCodes.join()), codes: place.doorCodes)],
          ],
        ),
      ),
    );
  }
}

/* ---- a station's train doors ---- */

class DoorsCarousel extends StatefulWidget {
  const DoorsCarousel({super.key, required this.codes});
  final List<String> codes;
  @override
  State<DoorsCarousel> createState() => _DoorsCarouselState();
}

class _DoorsCarouselState extends State<DoorsCarousel> {
  List<DoorSlide>? _slides;
  int _page = 0;
  int _dir = 1;

  @override
  void initState() {
    super.initState();
    app.transit.doorsFor(widget.codes).then((s) {
      if (mounted) setState(() => _slides = s);
    });
  }

  void _turn(int step) {
    final n = _slides!.length;
    if (n < 2) return;
    setState(() {
      _dir = step;
      _page = (_page + step + n) % n;
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final slides = _slides;
    if (slides == null) return const SizedBox.shrink();
    if (slides.isEmpty) return const Muted('No door details for this station yet.');
    Widget arrow(int step, String icon, String label) => slides.length < 2
        ? const SizedBox(width: 30)
        : Semantics(
            container: true,
            button: true,
            label: label,
            excludeSemantics: true,
            onTap: () => _turn(step),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => _turn(step),
              child: Container(
                width: 30,
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: mix(t.ink, 0.06, transparentInk), borderRadius: BorderRadius.circular(10)),
                child: AppIcon(icon, size: 18, color: t.ink),
              ),
            ),
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GestureDetector(
          onHorizontalDragEnd: (d) {
            final v = d.primaryVelocity ?? 0;
            if (v.abs() > 100) _turn(v < 0 ? 1 : -1);
          },
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              arrow(-1, 'back', 'Previous direction'),
              const SizedBox(width: 4),
              Expanded(
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 220),
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SlideTransition(position: Tween(begin: Offset(0.08 * _dir, 0), end: Offset.zero).animate(animation), child: child),
                  ),
                  layoutBuilder: (current, previous) => current ?? const SizedBox.shrink(),
                  child: KeyedSubtree(key: ValueKey(_page), child: _DoorSlideView(slide: slides[_page])),
                ),
              ),
              const SizedBox(width: 4),
              arrow(1, 'forward', 'Next direction'),
            ],
          ),
        ),
        const SizedBox(height: 4),
        Center(child: Text('${_page + 1} of ${slides.length}', style: TextStyle(fontSize: 12, color: t.muted))),
      ],
    );
  }
}

class _DoorSlideView extends StatelessWidget {
  const _DoorSlideView({required this.slide});
  final DoorSlide slide;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final colour = lineColourOf(slide.code);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(color: colour, borderRadius: BorderRadius.circular(999)),
              child: Text(slide.code, style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(slide.last ? 'Trains end here' : 'Towards ${slide.towards}', style: TextStyle(fontSize: 14, color: t.ink)),
                  if (slide.next != null) Text('Next: ${slide.next}', style: TextStyle(fontSize: 12, color: t.muted)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (slide.rows.isEmpty)
          const Muted('No door details for this platform yet.')
        else
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(color: t.surfaceStrong, borderRadius: BorderRadius.circular(12), border: Border.all(color: t.surfaceBorder)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final r in slide.rows)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AppIcon(doorType.containsKey(r.type) ? r.type : 'train', size: 24, color: t.brandInk),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(r.where, style: TextStyle(fontSize: 13, color: t.ink)),
                              const SizedBox(height: 6),
                              Wrap(spacing: 8, runSpacing: 8, children: [for (final n in r.doors) _DoorChip(number: n, colour: colour)]),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                Row(
                  children: [
                    if (slide.numberAt != null) ...[_DoorDrawing(at: slide.numberAt!, colour: colour), const SizedBox(width: 8)],
                    Expanded(
                      child: Text(
                        slide.numberAt != null ? 'Door number: ${numberAtWords[slide.numberAt]}' : 'Look for the number on each platform door',
                        style: TextStyle(fontSize: 12, color: t.muted),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        if (slide.cross.isNotEmpty) ...[
          const SizedBox(height: 8),
          Row(
            children: [
              AppIcon('across', size: 16, color: t.mutedStrong),
              const SizedBox(width: 6),
              Expanded(child: Text('Across the platform: ${listText(slide.cross)}', style: TextStyle(fontSize: 13, color: t.mutedStrong))),
            ],
          ),
        ],
      ],
    );
  }
}

/// A little platform door: a band in the line's colour saying Door, over glass split down the middle,
/// with the door's number on it, as on the real one.
class _DoorChip extends StatelessWidget {
  const _DoorChip({required this.number, required this.colour});
  final int number;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final glass = t.material ? Theme.of(context).colorScheme.secondaryContainer : mix(t.brandFill, 0.45, t.surfaceStrong);
    return Container(
      constraints: const BoxConstraints(minWidth: 46),
      decoration: BoxDecoration(color: glass, borderRadius: const BorderRadius.vertical(top: Radius.circular(7), bottom: Radius.circular(3)), border: Border.all(color: mix(t.ink, 0.7, transparentInk), width: 2)),
      child: ClipRRect(
        borderRadius: const BorderRadius.vertical(top: Radius.circular(5), bottom: Radius.circular(1)),
        child: IntrinsicWidth(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                color: colour,
                padding: const EdgeInsets.fromLTRB(6, 1, 6, 2),
                child: const Text('DOOR', textAlign: TextAlign.center, style: TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w700, letterSpacing: 0.6)),
              ),
              Stack(
                alignment: Alignment.center,
                children: [
                  Positioned(top: 0, bottom: 0, child: Container(width: 2, color: mix(t.ink, 0.22, transparentInk))),
                  Container(
                    margin: const EdgeInsets.fromLTRB(5, 5, 5, 7),
                    padding: const EdgeInsets.fromLTRB(8, 1, 8, 3),
                    decoration: BoxDecoration(color: t.material ? Theme.of(context).colorScheme.surfaceContainerHighest : t.surfaceStrong, borderRadius: BorderRadius.circular(5)),
                    child: Text('$number', style: TextStyle(color: t.ink, fontSize: 17, fontWeight: FontWeight.w700, height: 1.15)),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Where on the platform door its number is: a little drawing of that kind of door, the spot ringed.
class _DoorDrawing extends StatelessWidget {
  const _DoorDrawing({required this.at, required this.colour});
  final String at;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    String hex(Color c) => '#${c.toARGB32().toRadixString(16).padLeft(8, '0').substring(2)}';
    final frame = 'fill="${hex(Color.alphaBlend(t.surfaceStrong, t.bg))}" stroke="${hex(Color.alphaBlend(mix(t.ink, 0.7, transparentInk), t.bg))}" stroke-width="1.5"';
    final band = 'fill="${hex(colour)}"';
    final glass = 'fill="${hex(Color.alphaBlend(mix(t.brandFill, 0.45, t.surfaceStrong), t.bg))}" stroke="${hex(Color.alphaBlend(mix(t.ink, 0.55, transparentInk), t.bg))}" stroke-width="1"';
    final full = '<rect x="3" y="2" width="34" height="27" rx="1.5" $frame/><rect x="3" y="2" width="34" height="6" $band/><rect x="7" y="10" width="12.5" height="19" $glass/><rect x="20.5" y="10" width="12.5" height="19" $glass/>';
    final half = '<rect x="2" y="5" width="6" height="24" rx="1" $frame/><rect x="32" y="5" width="6" height="24" rx="1" $frame/><rect x="2" y="5" width="6" height="3" $band/><rect x="32" y="5" width="6" height="3" $band/><rect x="9" y="14" width="10.5" height="15" $glass/><rect x="20.5" y="14" width="10.5" height="15" $glass/>';
    final spot = const {'above': [20, 5.0], 'corner': [31, 11.5], 'post': [35, 11.0]}[at]!;
    final svg = '<svg viewBox="0 0 40 32">${at == 'post' ? half : full}<circle cx="${spot[0]}" cy="${spot[1]}" r="4.2" fill="none" stroke="#f2b31b" stroke-width="2"/><circle cx="${spot[0]}" cy="${spot[1]}" r="1.6" fill="#f2b31b"/></svg>';
    return SvgPicture.string(svg, width: 50, height: 40, excludeFromSemantics: true);
  }
}

/* ---- planning a route ---- */

class DirectionsPanel extends StatefulWidget {
  const DirectionsPanel({super.key});
  @override
  State<DirectionsPanel> createState() => _DirectionsPanelState();
}

class _DirectionsPanelState extends State<DirectionsPanel> {
  final _from = TextEditingController();
  final _to = TextEditingController();
  final _fromFocus = FocusNode();
  final _toFocus = FocusNode();
  Timer? _timer;
  int _asked = 0;
  String? _for;
  List<Place> _results = const [];
  String _empty = '';
  bool _showing = false;

  @override
  void initState() {
    super.initState();
    app.directions.addListener(_sync);
    _fromFocus.addListener(() => _onFocus('from', _fromFocus, _from));
    _toFocus.addListener(() => _onFocus('to', _toFocus, _to));
    _sync();
  }

  @override
  void dispose() {
    app.directions.removeListener(_sync);
    _timer?.cancel();
    _from.dispose();
    _to.dispose();
    _fromFocus.dispose();
    _toFocus.dispose();
    super.dispose();
  }

  void _sync() {
    final d = app.directions;
    if (!_fromFocus.hasFocus) _from.text = d.endLabel(d.from);
    if (!_toFocus.hasFocus) _to.text = d.endLabel(d.to);
    if (mounted) setState(() {});
  }

  void _onFocus(String which, FocusNode node, TextEditingController c) {
    if (!node.hasFocus) return;
    c.selection = TextSelection(baseOffset: 0, extentOffset: c.text.length);
    app.directions.setPicking(which);
    setState(() => _showing = false);
    // The way back to starting from here, once a start's been picked.
    if (which == 'from' && !(app.directions.from?.here ?? false)) _offer(which, const [herePlace], '');
  }

  void _offer(String which, List<Place> found, String empty) {
    setState(() {
      _for = which;
      _results = found;
      _empty = empty;
      _showing = true;
    });
  }

  void _typed(String which, String value) {
    _timer?.cancel();
    final q = value.trim();
    app.directions.setEnd(which, null);
    if (q.length < 2) {
      setState(() => _showing = false);
      return;
    }
    _timer = Timer(const Duration(milliseconds: 250), () async {
      final id = ++_asked;
      final c = app.map.camera.target;
      final found = await app.search.find(q, near: LatLon(c.latitude, c.longitude), saved: app.places.saved);
      if (id != _asked || !mounted) return;
      _offer(which, which == 'from' ? [herePlace, ...found] : found, 'Nothing found');
    });
  }

  void _pick(Place r) {
    setState(() => _showing = false);
    FocusManager.instance.primaryFocus?.unfocus();
    app.directions.setEnd(_for!, r.here ? herePlace : r);
  }

  Widget _field(String which, TextEditingController c, FocusNode node, String hint) {
    final d = app.directions;
    return Row(
      children: [
        Expanded(child: AppField(controller: c, focusNode: node, hint: hint, label: hint, onChanged: (v) => _typed(which, v))),
        const SizedBox(width: 6),
        AppIconButton(
          'pin',
          label: which == 'from' ? 'Pick the start on the map' : 'Pick the destination on the map',
          small: true,
          selected: d.picking == which,
          onPressed: () {
            setState(() => _showing = false);
            FocusManager.instance.primaryFocus?.unfocus();
            d.togglePick(which);
          },
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final d = app.directions;
    final route = d.route;
    return Panel(
      padding: EdgeInsets.all(t.material ? 16 : 14),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            SheetHead(title: 'Directions', onClose: d.close),
            const SizedBox(height: 10),
            SegmentPicker<String>(
              value: d.mode,
              onChanged: d.setMode,
              segments: const [
                Segment('foot', 'Walk', icon: 'walk'),
                Segment('bike', 'Cycle', icon: 'bike'),
                Segment('car', 'Drive', icon: 'car'),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Column(
                    children: [
                      _field('from', _from, _fromFocus, 'From'),
                      const SizedBox(height: 6),
                      _field('to', _to, _toFocus, 'To'),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                AppIconButton('swap', label: 'Swap start and end', onPressed: d.swap),
              ],
            ),
            if (_showing && _for != null) ...[
              const SizedBox(height: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 220),
                child: Container(
                  decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(14), border: t.material ? null : Border.all(color: t.surfaceBorder)),
                  padding: const EdgeInsets.all(4),
                  child: SuggestionList(results: _results, emptyText: _empty, onPick: _pick),
                ),
              ),
            ],
            if (d.status.isNotEmpty) ...[
              const SizedBox(height: 10),
              Semantics(liveRegion: true, child: Muted(d.status)),
            ],
            if (route != null) ...[
              const SizedBox(height: 10),
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.end,
                spacing: 8,
                runSpacing: 4,
                children: [
                  Text(formatDuration(route.duration), style: TextStyle(fontSize: 20.8, color: t.ink)),
                  Muted(formatDistance(route.distance)),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(color: t.brandFillStrong, borderRadius: BorderRadius.circular(999)),
                    child: Text(route.source == 'offline' ? 'Offline' : 'Online', style: TextStyle(fontSize: 12, color: t.onBrand)),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  AppButton('Start', icon: 'navigate', kind: BtnKind.primary, onPressed: () {
                    final ends = d.resolved;
                    final r = d.route;
                    if (ends == null || r == null) return;
                    d.close();
                    app.navigation.start(r, ends);
                  }),
                  AppButton('Share', icon: 'share', onPressed: app.share.shareDirections),
                ],
              ),
              const SizedBox(height: 10),
              for (final s in route.steps)
                Semantics(
                  container: true,
                  button: true,
                  label: s.text,
                  excludeSemantics: true,
                  onTap: () => app.map.flyTo(s.at[1], s.at[0]),
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => app.map.flyTo(s.at[1], s.at[0]),
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
                      decoration: BoxDecoration(border: Border(top: BorderSide(color: mix(t.ink, 0.12, transparentInk)))),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppIcon(stepIconName(s), size: 20, color: t.brandInk),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(s.text, style: TextStyle(fontSize: 14.4, color: t.ink)),
                                if (s.distance > 0) Text(formatDistance(s.distance), style: TextStyle(fontSize: 12.5, color: t.mutedStrong)),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class SuggestionList extends StatelessWidget {
  const SuggestionList({super.key, required this.results, required this.emptyText, required this.onPick});
  final List<Place> results;
  final String emptyText;
  final ValueChanged<Place> onPick;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (results.isEmpty) {
      return emptyText.isEmpty ? const SizedBox.shrink() : Padding(padding: const EdgeInsets.all(10), child: Text(emptyText, style: TextStyle(fontSize: 13.6, color: t.mutedStrong)));
    }
    return ListView.builder(
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      itemCount: results.length,
      itemBuilder: (_, i) {
        final r = results[i];
        return Semantics(
          container: true,
          button: true,
          label: r.sub.isEmpty ? r.name : '${r.name}, ${r.sub}',
          excludeSemantics: true,
          onTap: () => onPick(r),
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => onPick(r),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              child: Row(
                children: [
                  AppIcon(r.source == 'saved' ? 'bookmark' : (r.here ? 'locate' : 'pin'), size: 18, color: t.brandInk),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(r.name, style: TextStyle(fontSize: 15.2, color: t.ink)),
                        if (r.sub.isNotEmpty) Text(r.sub, style: TextStyle(fontSize: 12.5, color: t.mutedStrong)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/* ---- navigating ---- */

class NavHud extends StatelessWidget {
  const NavHud({super.key, required this.top});
  final double top;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final m = MediaQuery.of(context);
    final left = 12 + m.padding.left;
    final btn = m.size.width <= 480 ? 40.0 : 44.0;
    final edge = m.size.width <= 480 ? 10.0 : 16.0;
    final nextWidth = (m.size.width - 24 - btn - edge - 32).clamp(0.0, 420.0);
    return ListenableBuilder(
      listenable: Listenable.merge([app.navigation, app.share]),
      builder: (context, _) {
        final n = app.navigation;
        final p = n.progress;
        final step = n.nextStep;
        if (!n.active || p == null || step == null) return const SizedBox.shrink();
        final eta = DateTime.now().add(Duration(seconds: p.secondsLeft.round()));
        return Stack(
          children: [
            Positioned(
              left: left,
              top: top,
              width: nextWidth,
              child: Semantics(
                liveRegion: true,
                container: true,
                label: 'Navigation',
                child: Panel(
                  color: t.brandFillStrong,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      AppIcon(stepIconName(step), size: 38, color: t.onBrand),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(formatDistance(p.toStep), style: TextStyle(fontSize: 20.8, color: t.onBrand)),
                            Text(step.text, style: TextStyle(fontSize: 16, color: t.onBrand)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            Positioned(
              left: left,
              bottom: m.padding.bottom + 12,
              width: (m.size.width - 24).clamp(0.0, 420.0),
              child: Panel(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(formatClock(eta), style: TextStyle(fontSize: 19.2, color: t.ink)),
                        Muted('${formatDuration(p.secondsLeft)} · ${formatDistance(p.left)}'),
                      ],
                    ),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        AppIconButton(n.voice ? 'sound' : 'mute', label: 'Spoken directions', selected: n.voice, onPressed: n.toggleVoice),
                        AppButton(app.share.sharingEta ? 'Stop sharing' : 'Share ETA', icon: 'share', onPressed: app.share.toggleEta),
                        AppButton('End', icon: 'stop', kind: BtnKind.danger, onPressed: n.userStopped),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

/* ---- map controls ---- */

class MapControls extends StatelessWidget {
  const MapControls({super.key, required this.bottom, required this.right, required this.service});
  final double bottom;
  final double right;
  final MapService service;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Positioned(
      right: right,
      bottom: bottom,
      child: Panel(
        radius: 12,
        padding: const EdgeInsets.all(2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _Ctl('plus', 'Zoom in', () => service.zoomBy(1), t),
            _Ctl('minus', 'Zoom out', () => service.zoomBy(-1), t),
            _Ctl('compass', 'Face north, and flat', service.resetNorth, t),
          ],
        ),
      ),
    );
  }
}

class _Ctl extends StatelessWidget {
  const _Ctl(this.icon, this.label, this.onTap, this.t);
  final String icon;
  final String label;
  final VoidCallback onTap;
  final Tokens t;

  @override
  Widget build(BuildContext context) => Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Semantics(
          container: true,
          button: true,
          label: label,
          excludeSemantics: true,
          onTap: onTap,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onTap,
            child: SizedBox(width: 38, height: 38, child: Center(child: AppIcon(icon, size: 20, color: t.ink))),
          ),
        ),
      );
}

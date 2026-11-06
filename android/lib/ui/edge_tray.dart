// The Edge Tray (docs/edge-tray-spec.md): a floating column of icon buttons at the top right, with an arrow
// tab beside it. The tab slides the column off the screen's edge and brings it back, and the choice is
// remembered. It's here in both looks, drawn as glass in uwuapps and in the phone's colours in Material You.

import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../core/prefs.dart';
import '../theme/tokens.dart';
import '../theme/app_icon.dart';
import 'widgets.dart';

const String _trayKey = 'uwumaps.trayOpen';
const Duration _trayTime = Duration(milliseconds: 340);
const double _staggerMs = 18;

class TrayButton {
  const TrayButton(this.icon, this.label, this.onPressed, {this.selected = false});
  final String icon;
  final String label;
  final VoidCallback onPressed;
  final bool selected;
}

/// Null is the rule between the map's places and the actions on the view.
class EdgeTray extends StatefulWidget {
  const EdgeTray({super.key, required this.buttons, required this.onChanged, this.maxHeight});
  final List<TrayButton?> buttons;
  final ValueChanged<bool> onChanged;

  /// How tall the column may be, when a panel below needs the room. It scrolls past that.
  final double? maxHeight;

  static bool get startsOpen => Prefs.getString(_trayKey) != '0';

  @override
  State<EdgeTray> createState() => EdgeTrayState();
}

class EdgeTrayState extends State<EdgeTray> with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  bool _open = EdgeTray.startsOpen;
  bool _closing = false;

  bool get isOpen => _open;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, value: _open ? 1 : 0);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void toggle() {
    final open = !_open;
    final instant = MediaQuery.of(context).disableAnimations;
    setState(() {
      _open = open;
      _closing = !open;
    });
    Prefs.setString(_trayKey, open ? '1' : '0');
    widget.onChanged(open);
    // Opening takes longer by the stagger, so the last button finishes at its own pace.
    final extra = _staggerMs * (widget.buttons.length - 1);
    final duration = instant ? Duration.zero : (open ? _trayTime + Duration(milliseconds: extra.round()) : _trayTime);
    _c.animateTo(open ? 1 : 0, duration: duration, curve: Curves.linear);
  }

  double get _totalMs => _trayTime.inMilliseconds + _staggerMs * (widget.buttons.length - 1);

  // 1 when in place, 0 when off the edge.
  double _slide() {
    if (_closing) return trayEase.transform(_c.value);
    return trayEase.transform((_c.value * _totalMs / _trayTime.inMilliseconds).clamp(0.0, 1.0));
  }

  double _item(int i) {
    if (_closing) return trayEase.transform(_c.value);
    final at = _c.value * _totalMs - i * _staggerMs;
    return trayEase.transform((at / _trayTime.inMilliseconds).clamp(0.0, 1.0));
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    final safeRight = MediaQuery.of(context).padding.right;
    final btn = width <= 480 ? 40.0 : 44.0;
    final edge = (width <= 480 ? 10.0 : 16.0) + safeRight;
    final t = context.t;
    final shift = btn + 8 + edge;

    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) {
        final slide = _slide();
        return Transform.translate(
          offset: Offset(shift * (1 - slide), 0),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Tab(open: slide, height: btn, label: _open ? 'Hide menu' : 'Show menu', expanded: _open, onTap: toggle),
              const SizedBox(width: 8),
              Padding(
                padding: EdgeInsets.only(right: edge),
                child: IgnorePointer(
                  ignoring: !_open,
                  child: ExcludeSemantics(
                    excluding: !_open,
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxHeight: widget.maxHeight ?? MediaQuery.of(context).size.height - MediaQuery.of(context).padding.top - 30),
                      child: SingleChildScrollView(
                        clipBehavior: Clip.none,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (var i = 0; i < widget.buttons.length; i++) ...[
                              if (i > 0) const SizedBox(height: 8),
                              () {
                                final p = _item(i);
                                final b = widget.buttons[i];
                                return Opacity(
                                  opacity: p.clamp(0.0, 1.0),
                                  child: Transform.translate(
                                    offset: Offset(12 * (1 - p), 0),
                                    child: Transform.scale(
                                      scale: 0.85 + 0.15 * p,
                                      child: b == null
                                          ? Container(width: 24, height: 1, margin: const EdgeInsets.symmetric(vertical: 2), color: mix(t.ink, 0.25, transparentInk))
                                          : _TrayIcon(button: b, size: btn),
                                    ),
                                  ),
                                );
                              }(),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({required this.open, required this.height, required this.label, required this.expanded, required this.onTap});

  /// 1 fully open, 0 flush with the edge.
  final double open;
  final double height;
  final String label;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final radius = BorderRadius.horizontal(left: const Radius.circular(12), right: Radius.circular(12 * open));
    final scheme = Theme.of(context).colorScheme;
    final body = Container(
      width: 24,
      height: height,
      decoration: BoxDecoration(
        color: t.material ? scheme.secondaryContainer : t.panel,
        borderRadius: radius,
        border: t.material ? null : Border.all(color: t.surfaceBorder),
      ),
      alignment: Alignment.center,
      child: Transform.rotate(
        angle: (1 - open) * 3.14159265,
        child: Icon(Icons.chevron_right, size: t.material ? 20 : 18, color: t.material ? scheme.onSecondaryContainer : t.ink),
      ),
    );
    return Tooltip(
      message: label,
      excludeFromSemantics: true,
      child: Semantics(
        container: true,
        button: true,
        expanded: expanded,
        label: label,
        excludeSemantics: true,
        onTap: onTap,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: DecoratedBox(
            decoration: BoxDecoration(borderRadius: radius, boxShadow: t.shadow),
            child: t.material
                ? body
                : ClipRRect(
                    borderRadius: radius,
                    child: BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18), child: body),
                  ),
          ),
        ),
      ),
    );
  }
}

class _TrayIcon extends StatelessWidget {
  const _TrayIcon({required this.button, required this.size});
  final TrayButton button;
  final double size;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final scheme = Theme.of(context).colorScheme;
    final on = button.selected;
    final radius = BorderRadius.circular(t.material ? size * 0.32 : 14);
    final colour = t.material ? (on ? scheme.onPrimaryContainer : scheme.onSecondaryContainer) : (on ? t.onBrand : t.ink);
    final fill = t.material ? (on ? scheme.primaryContainer : scheme.secondaryContainer) : (on ? t.brandFill : t.panel);
    final inner = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: fill, borderRadius: radius, border: t.material ? null : Border.all(color: t.surfaceBorder)),
      alignment: Alignment.center,
      child: AppIcon(button.icon, size: 22, color: colour),
    );
    return Tooltip(
      message: button.label,
      excludeFromSemantics: true,
      child: Semantics(
        container: true,
        button: true,
        selected: on,
        label: button.label,
        excludeSemantics: true,
        onTap: button.onPressed,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: button.onPressed,
          child: DecoratedBox(
            decoration: BoxDecoration(borderRadius: radius, boxShadow: t.shadow),
            child: t.material
                ? inner
                : ClipRRect(
                    borderRadius: radius,
                    child: BackdropFilter(filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18), child: inner),
                  ),
          ),
        ),
      ),
    );
  }
}

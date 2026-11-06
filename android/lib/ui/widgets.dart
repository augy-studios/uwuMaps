// The building blocks. One widget per idea, each drawn two ways: glass, as docs/uwuapps-theme.md has it,
// or with Material's own widgets in Material You.

import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../app.dart' show Toast;
import '../theme/app_icon.dart';
import '../theme/tokens.dart';

const Curve trayEase = Cubic(0.2, 0.8, 0.2, 1);

/// A surface floating over the map.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = EdgeInsets.zero, this.radius = 20, this.color});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (t.material) {
      return Material(
        color: color ?? t.panel,
        elevation: 3,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.black54,
        borderRadius: BorderRadius.circular(radius + 4),
        clipBehavior: Clip.antiAlias,
        child: Padding(padding: padding, child: child),
      );
    }
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(radius), boxShadow: t.shadow),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: Container(
            decoration: BoxDecoration(
              color: color ?? t.panel,
              borderRadius: BorderRadius.circular(radius),
              border: Border.all(color: t.surfaceBorder),
            ),
            padding: padding,
            child: Material(type: MaterialType.transparency, child: child),
          ),
        ),
      ),
    );
  }
}

enum BtnKind { plain, primary, quiet, danger }

class AppButton extends StatelessWidget {
  const AppButton(this.label, {super.key, this.icon, this.onPressed, this.kind = BtnKind.plain});
  final String label;
  final String? icon;
  final VoidCallback? onPressed;
  final BtnKind kind;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final ic = icon == null ? null : AppIcon(icon!, size: 18);
    if (t.material) {
      final text = Text(label);
      switch (kind) {
        case BtnKind.primary:
          return ic == null ? FilledButton(onPressed: onPressed, child: text) : FilledButton.icon(onPressed: onPressed, icon: ic, label: text);
        case BtnKind.danger:
          final style = FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.errorContainer, foregroundColor: Theme.of(context).colorScheme.onErrorContainer);
          return ic == null ? FilledButton(onPressed: onPressed, style: style, child: text) : FilledButton.icon(onPressed: onPressed, style: style, icon: ic, label: text);
        case BtnKind.quiet:
          return ic == null ? OutlinedButton(onPressed: onPressed, child: text) : OutlinedButton.icon(onPressed: onPressed, icon: ic, label: text);
        case BtnKind.plain:
          return ic == null ? FilledButton.tonal(onPressed: onPressed, child: text) : FilledButton.tonalIcon(onPressed: onPressed, icon: ic, label: text);
      }
    }
    final (Color bg, Color fg, Color border) = switch (kind) {
      BtnKind.primary => (t.brandFill, t.onBrand, t.surfaceBorder),
      BtnKind.danger => (mix(t.error, 0.14, transparentInk), t.error, t.surfaceBorder),
      BtnKind.quiet => (Colors.transparent, t.ink, mix(t.ink, 0.25, transparentInk)),
      BtnKind.plain => (t.surfaceStrong, t.ink, t.surfaceBorder),
    };
    return Semantics(
      container: true,
      button: true,
      enabled: onPressed != null,
      label: label,
      excludeSemantics: true,
      onTap: onPressed,
      child: Opacity(
        opacity: onPressed == null ? 0.6 : 1,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onPressed,
          child: Container(
            constraints: const BoxConstraints(minHeight: 38),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: border),
            ),
            child: IconTheme(
              data: IconThemeData(color: fg),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  if (icon != null) ...[AppIcon(icon!, size: 16, color: fg), const SizedBox(width: 6)],
                  Flexible(
                    child: Text(label, style: TextStyle(color: fg, fontSize: 14.4)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A square icon button, with its name read out and shown on a long press.
class AppIconButton extends StatelessWidget {
  const AppIconButton(this.icon, {super.key, required this.label, required this.onPressed, this.small = false, this.selected = false, this.size});
  final String icon;
  final String label;
  final VoidCallback? onPressed;
  final bool small;
  final bool selected;
  final double? size;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final side = size ?? (small ? 34.0 : 42.0);
    if (t.material) {
      final scheme = Theme.of(context).colorScheme;
      return Tooltip(
        message: label,
        excludeFromSemantics: true,
        child: Semantics(
          container: true,
          button: true,
          label: label,
          selected: selected,
          excludeSemantics: true,
          onTap: onPressed,
          child: SizedBox(
            width: side,
            height: side,
            child: IconButton.filledTonal(
              onPressed: onPressed,
              padding: EdgeInsets.zero,
              isSelected: selected,
              style: IconButton.styleFrom(backgroundColor: selected ? scheme.primaryContainer : null, foregroundColor: selected ? scheme.onPrimaryContainer : null),
              icon: AppIcon(icon, size: small ? 18 : 22),
            ),
          ),
        ),
      );
    }
    final fg = selected ? t.onBrand : t.ink;
    return Tooltip(
      message: label,
      excludeFromSemantics: true,
      child: Semantics(
        container: true,
        button: true,
        label: label,
        selected: selected,
        excludeSemantics: true,
        onTap: onPressed,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onPressed,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: side,
            height: side,
            decoration: BoxDecoration(
              color: selected ? t.brandFill : t.surfaceStrong,
              borderRadius: BorderRadius.circular(small ? 12 : 14),
              border: Border.all(color: t.surfaceBorder),
            ),
            alignment: Alignment.center,
            child: AppIcon(icon, size: small ? 16 : 20, color: fg),
          ),
        ),
      ),
    );
  }
}

class Segment<T> {
  const Segment(this.value, this.label, {this.icon, this.wide = false});
  final T value;
  final String label;
  final String? icon;
  final bool wide;
}

/// Pick one. The mode toggle, and how to travel.
class SegmentPicker<T> extends StatelessWidget {
  const SegmentPicker({super.key, required this.segments, required this.value, required this.onChanged, this.label});
  final List<Segment<T>> segments;
  final T value;
  final ValueChanged<T> onChanged;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (t.material) {
      return SizedBox(
        width: double.infinity,
        child: SegmentedButton<T>(
          showSelectedIcon: false,
          segments: [
            for (final s in segments)
              ButtonSegment<T>(
                value: s.value,
                label: Text(s.label, overflow: TextOverflow.ellipsis),
                // Four with icons is too many for a phone's width: their names get cut short.
                icon: s.icon == null || segments.length > 3 ? null : AppIcon(s.icon!, size: 18),
              ),
          ],
          selected: {value},
          onSelectionChanged: (set) => onChanged(set.first),
        ),
      );
    }
    final normal = segments.where((s) => !s.wide).toList();
    final wide = segments.where((s) => s.wide).toList();
    Widget cell(Segment<T> s) {
      final on = s.value == value;
      return Semantics(
        container: true,
        button: true,
        selected: on,
        label: s.label,
        excludeSemantics: true,
        onTap: () => onChanged(s.value),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => onChanged(s.value),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(color: on ? t.brandFill : Colors.transparent, borderRadius: BorderRadius.circular(10)),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (s.icon != null) ...[AppIcon(s.icon!, size: 16, color: on ? t.onBrand : t.mutedStrong), const SizedBox(width: 6)],
                Flexible(
                  child: Text(
                    s.label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13.6, color: on ? t.onBrand : t.mutedStrong),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(14)),
      child: Column(
        children: [
          Row(
            children: [
              for (var i = 0; i < normal.length; i++) ...[if (i > 0) const SizedBox(width: 6), Expanded(child: cell(normal[i]))],
            ],
          ),
          for (final s in wide) ...[const SizedBox(height: 6), cell(s)],
        ],
      ),
    );
  }
}

class AppSwitch extends StatelessWidget {
  const AppSwitch({super.key, required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    if (t.material) return Switch(value: value, onChanged: onChanged);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => onChanged(!value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        width: 42,
        height: 24,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(color: value ? t.brandInk : mix(t.ink, 0.28, transparentInk), borderRadius: BorderRadius.circular(999)),
        child: AnimatedAlign(
          duration: const Duration(milliseconds: 180),
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 18,
            height: 18,
            decoration: BoxDecoration(color: t.bg, shape: BoxShape.circle),
          ),
        ),
      ),
    );
  }
}

/// A row with a name and a switch, the whole row pressable.
class SwitchRow extends StatelessWidget {
  const SwitchRow({super.key, required this.label, required this.value, required this.onChanged, this.sub});
  final String label;
  final String? sub;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Semantics(
      container: true,
      toggled: value,
      label: label,
      excludeSemantics: true,
      onTap: () => onChanged(!value),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onChanged(!value),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.material ? 16 : 12)),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: TextStyle(fontSize: 15.2, color: t.ink)),
                    if (sub != null) Text(sub!, style: TextStyle(fontSize: 12.5, color: t.mutedStrong)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              AppSwitch(value: value, onChanged: onChanged),
            ],
          ),
        ),
      ),
    );
  }
}

class AppField extends StatelessWidget {
  const AppField({super.key, this.controller, this.focusNode, this.hint, this.label, this.onChanged, this.onSubmitted, this.readOnly = false, this.onTap, this.upper = false, this.maxLength});
  final TextEditingController? controller;
  final FocusNode? focusNode;
  final String? hint;
  final String? label;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final bool readOnly;
  final VoidCallback? onTap;
  final bool upper;
  final int? maxLength;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final border = OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: t.material ? BorderSide.none : BorderSide(color: mix(t.ink, 0.18, transparentInk)));
    return NamedField(
      name: label ?? hint ?? '',
      child: TextField(
        controller: controller,
        focusNode: focusNode,
        readOnly: readOnly,
        onTap: onTap,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        maxLength: maxLength,
        textCapitalization: upper ? TextCapitalization.characters : TextCapitalization.none,
        autocorrect: false,
        style: TextStyle(color: t.ink, fontSize: 16),
        decoration: InputDecoration(
          isDense: true,
          counterText: '',
          hint: hint == null ? null : ExcludeSemantics(child: Text(hint!, style: TextStyle(color: t.mutedStrong, fontSize: 16))),
          filled: true,
          fillColor: t.surfaceStrong,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          border: border,
          enabledBorder: border,
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.brandInk, width: 2)),
        ),
      ),
    );
  }
}

/// A text field's one name for a screen reader, which stays when it has text in it.
class NamedField extends StatelessWidget {
  const NamedField({super.key, required this.name, required this.child});
  final String name;
  final Widget child;

  @override
  Widget build(BuildContext context) => MergeSemantics(child: Semantics(label: name, child: child));
}

class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Text(text, style: TextStyle(fontSize: 13.6, color: context.t.muted)),
  );
}

class Muted extends StatelessWidget {
  const Muted(this.text, {super.key, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(text, style: TextStyle(fontSize: 13.6, color: color ?? context.t.mutedStrong));
}

class SheetHead extends StatelessWidget {
  const SheetHead({super.key, required this.title, this.sub, required this.onClose});
  final String title;
  final String? sub;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  title,
                  style: TextStyle(fontSize: t.material ? 20 : 17.6, color: t.brandInk, fontWeight: FontWeight.normal),
                ),
              ),
              if (sub != null && sub!.isNotEmpty) Muted(sub!),
            ],
          ),
        ),
        if (onClose != null) ...[const SizedBox(width: 10), AppIconButton('close', label: 'Close', small: true, onPressed: onClose)],
      ],
    );
  }
}

/// A modal sheet: the glass one from the bottom in uwuapps, Material's own in Material You.
Future<T?> showAppSheet<T>(BuildContext context, {required String title, required WidgetBuilder builder, bool scroll = true}) {
  final t = context.t;
  Widget body(BuildContext c) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      SheetHead(title: title, onClose: () => Navigator.of(c).maybePop()),
      const SizedBox(height: 10),
      Flexible(
        child: scroll ? SingleChildScrollView(child: Builder(builder: builder)) : Builder(builder: builder),
      ),
    ],
  );

  if (t.material) {
    return showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      constraints: const BoxConstraints(maxWidth: 560),
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(18, 0, 18, 18 + MediaQuery.of(c).viewInsets.bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(c).size.height * 0.8),
          child: body(c),
        ),
      ),
    );
  }

  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: true,
    barrierLabel: 'Close',
    barrierColor: const Color(0x590A0F0C),
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (c, _, _) => SafeArea(
      child: Align(
        alignment: MediaQuery.of(c).size.width >= 640 ? Alignment.center : Alignment.bottomCenter,
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, 12, 12, 12 + MediaQuery.of(c).viewInsets.bottom),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: 420, maxHeight: MediaQuery.of(c).size.height * 0.85),
            child: Theme(
              data: Theme.of(context),
              child: Panel(padding: EdgeInsets.all(MediaQuery.of(c).size.width <= 480 ? 12 : 18), child: body(c)),
            ),
          ),
        ),
      ),
    ),
    transitionBuilder: (c, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: trayEase, reverseCurve: Curves.easeOut);
      return FadeTransition(
        opacity: animation,
        child: AnimatedBuilder(
          animation: curved,
          builder: (_, inner) => Transform.translate(
            offset: Offset(0, 14 * (1 - curved.value)),
            child: Transform.scale(scale: 0.97 + 0.03 * curved.value, child: inner),
          ),
          child: child,
        ),
      );
    },
  );
}

/// The message that comes and goes at the bottom of the screen. Above everything, sheets included, so what
/// it says is never hidden behind what asked for it.
class ToastLayer extends StatefulWidget {
  const ToastLayer({super.key, required this.toasts});
  final ValueListenable<Toast?> toasts;

  @override
  State<ToastLayer> createState() => _ToastLayerState();
}

class _ToastLayerState extends State<ToastLayer> {
  Toast? _toast;
  bool _shown = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    widget.toasts.addListener(_changed);
  }

  @override
  void dispose() {
    widget.toasts.removeListener(_changed);
    _timer?.cancel();
    super.dispose();
  }

  void _changed() {
    final next = widget.toasts.value;
    if (next == null) return;
    setState(() {
      _toast = next;
      _shown = true;
    });
    _timer?.cancel();
    _timer = Timer(const Duration(milliseconds: 3600), () {
      if (mounted) setState(() => _shown = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final toast = _toast;
    if (toast == null) return const SizedBox.shrink();
    final t = context.t;
    final m = MediaQuery.of(context);
    final scheme = Theme.of(context).colorScheme;
    final fill = toast.error ? (t.material ? scheme.errorContainer : mix(t.error, 0.18, t.bg)) : (t.material ? scheme.inverseSurface : t.brandFillStrong);
    final ink = toast.error ? (t.material ? scheme.onErrorContainer : t.error) : (t.material ? scheme.onInverseSurface : t.onBrand);
    return Positioned(
      left: 0,
      right: 0,
      bottom: (m.viewInsets.bottom > 0 ? m.viewInsets.bottom : m.padding.bottom) + 20,
      child: IgnorePointer(
        child: AnimatedOpacity(
          opacity: _shown ? 1 : 0,
          duration: const Duration(milliseconds: 180),
          child: Center(
            child: Semantics(
              liveRegion: _shown,
              child: Container(
                constraints: BoxConstraints(maxWidth: math.min(420, m.size.width - 24)),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(14), boxShadow: t.shadow),
                child: Text(_shown ? toast.message : '', style: TextStyle(fontSize: 14.4, color: ink, decoration: TextDecoration.none, fontWeight: FontWeight.normal)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

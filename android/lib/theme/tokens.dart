// The colours every widget reads. In the uwuapps theme they're docs/uwuapps-theme.md's tokens, worked
// out for the chosen swatch and mode. In Material You they come from the phone's colour scheme. Widgets
// never name a colour themselves, so everything reads in every combination.

import 'package:flutter/material.dart';

/// `color-mix(in srgb, a p%, b)`: premultiplied, as CSS does it, so a translucent token stays one.
Color mix(Color a, double p, Color b) {
  final q = 1 - p;
  final alpha = a.a * p + b.a * q;
  if (alpha == 0) return Colors.transparent;
  double channel(double x, double y) => (x * a.a * p + y * b.a * q) / alpha;
  return Color.from(alpha: alpha, red: channel(a.r, b.r), green: channel(a.g, b.g), blue: channel(a.b, b.b));
}

const Color transparentInk = Color(0x00000000);

@immutable
class Tokens extends ThemeExtension<Tokens> {
  const Tokens({
    required this.material,
    required this.bg,
    required this.page,
    required this.surface,
    required this.surfaceStrong,
    required this.surfaceBorder,
    required this.ink,
    required this.muted,
    required this.mutedStrong,
    required this.brandInk,
    required this.onBrand,
    required this.brandFill,
    required this.brandFillStrong,
    required this.panel,
    required this.ok,
    required this.warn,
    required this.busy,
    required this.error,
    required this.shadow,
    required this.dark,
  });

  /// Drawn with Material's own widgets rather than the glass ones.
  final bool material;
  final Color bg;
  final Color page;
  final Color surface;
  final Color surfaceStrong;
  final Color surfaceBorder;
  final Color ink;
  final Color muted;
  final Color mutedStrong;
  final Color brandInk;
  final Color onBrand;
  final Color brandFill;
  final Color brandFillStrong;
  final Color panel;
  final Color ok;
  final Color warn;
  final Color busy;
  final Color error;
  final List<BoxShadow> shadow;
  final bool dark;

  /// The uwuapps theme, for a brand swatch and a mode.
  factory Tokens.uwu(Color brand, {required bool dark}) {
    final bg = dark ? const Color(0xFF0C100E) : const Color(0xFFEEF2F0);
    final surfaceStrong = dark ? const Color(0x1CFFFFFF) : const Color(0xC7FFFFFF);
    final ink = dark ? const Color(0xFFEEF2EF) : const Color(0xFF121815);
    return Tokens(
      material: false,
      dark: dark,
      bg: bg,
      page: mix(brand, 0.10, bg),
      surface: dark ? const Color(0x0FFFFFFF) : const Color(0x8CFFFFFF),
      surfaceStrong: surfaceStrong,
      surfaceBorder: dark ? const Color(0x24FFFFFF) : const Color(0xA6FFFFFF),
      ink: ink,
      muted: dark ? const Color(0xFF9AA7A0) : const Color(0xFF5B665F),
      mutedStrong: mix(ink, 0.70, transparentInk),
      brandInk: dark ? const Color(0xFFBFF5CF) : const Color(0xFF1F6B3D),
      // The same dark ink in both modes: brand swatches are pale whatever the mode.
      onBrand: const Color(0xFF121815),
      brandFill: mix(brand, 0.55, surfaceStrong),
      brandFillStrong: mix(brand, 0.75, surfaceStrong),
      // What a floating panel over the map sits on, since --surface alone is nearly clear in dark mode.
      panel: mix(bg, 0.82, transparentInk),
      ok: dark ? const Color(0xFF4ADE80) : const Color(0xFF0F7234),
      warn: dark ? const Color(0xFFFBBF24) : const Color(0xFFA24B08),
      busy: dark ? const Color(0xFF94A3B8) : const Color(0xFF627288),
      error: dark ? const Color(0xFFFA9696) : const Color(0xFFB91C1C),
      shadow: dark
          ? const [BoxShadow(color: Color(0x80000000), blurRadius: 34, offset: Offset(0, 10))]
          : const [BoxShadow(color: Color(0x1A14281E), blurRadius: 30, offset: Offset(0, 10))],
    );
  }

  factory Tokens.material(ColorScheme c) {
    final dark = c.brightness == Brightness.dark;
    return Tokens(
      material: true,
      dark: dark,
      bg: c.surface,
      page: c.surface,
      surface: c.surfaceContainer,
      surfaceStrong: c.surfaceContainerHighest,
      surfaceBorder: c.outlineVariant,
      ink: c.onSurface,
      muted: c.onSurfaceVariant,
      mutedStrong: c.onSurfaceVariant,
      brandInk: c.primary,
      onBrand: c.onPrimaryContainer,
      brandFill: c.primaryContainer,
      brandFillStrong: c.primaryContainer,
      panel: c.surfaceContainerLow,
      ok: dark ? const Color(0xFF7BDA9A) : const Color(0xFF1B6C3A),
      warn: dark ? const Color(0xFFF2BE6B) : const Color(0xFF8A5100),
      busy: c.tertiary,
      error: c.error,
      shadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 6, offset: Offset(0, 2))],
    );
  }

  @override
  Tokens copyWith() => this;

  @override
  Tokens lerp(ThemeExtension<Tokens>? other, double t) {
    if (other is! Tokens) return this;
    return Tokens(
      material: t < 0.5 ? material : other.material,
      dark: t < 0.5 ? dark : other.dark,
      bg: Color.lerp(bg, other.bg, t)!,
      page: Color.lerp(page, other.page, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceStrong: Color.lerp(surfaceStrong, other.surfaceStrong, t)!,
      surfaceBorder: Color.lerp(surfaceBorder, other.surfaceBorder, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      mutedStrong: Color.lerp(mutedStrong, other.mutedStrong, t)!,
      brandInk: Color.lerp(brandInk, other.brandInk, t)!,
      onBrand: Color.lerp(onBrand, other.onBrand, t)!,
      brandFill: Color.lerp(brandFill, other.brandFill, t)!,
      brandFillStrong: Color.lerp(brandFillStrong, other.brandFillStrong, t)!,
      panel: Color.lerp(panel, other.panel, t)!,
      ok: Color.lerp(ok, other.ok, t)!,
      warn: Color.lerp(warn, other.warn, t)!,
      busy: Color.lerp(busy, other.busy, t)!,
      error: Color.lerp(error, other.error, t)!,
      shadow: t < 0.5 ? shadow : other.shadow,
    );
  }
}

extension TokensOf on BuildContext {
  Tokens get t => Theme.of(this).extension<Tokens>()!;
}

// Which look the app is in. Material You is on by default, with the phone's colours and font, and can
// be turned off in Settings for the usual uwuapps theme (docs/uwuapps-theme.md), which is the one the
// website always has. Each keeps its own mode: Material You follows the phone unless told otherwise,
// and uwuapps defaults to light whatever the phone says, as the theme spec asks.

import 'dart:async';

import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import '../core/device.dart';
import '../core/prefs.dart';
import 'tokens.dart';

class BrandSwatch {
  const BrandSwatch(this.id, this.label, this.color);
  final String id;
  final String label;
  final Color color;
}

const List<BrandSwatch> brandSwatches = [
  BrandSwatch('classic', 'Classic', Color(0xFFCCFFCC)),
  BrandSwatch('not-green-1', 'Not green 1', Color(0xFFFFCCCC)),
  BrandSwatch('not-green-2', 'Not green 2', Color(0xFFCCCCFF)),
  BrandSwatch('not-green-3', 'Not green 3', Color(0xFFFFFFCC)),
  BrandSwatch('not-green-4', 'Not green 4', Color(0xFFFFCCFF)),
  BrandSwatch('not-green-5', 'Not green 5', Color(0xFFCCFFFF)),
  BrandSwatch('really-light-green', 'Really really light green', Color(0xFFFFFFFF)),
];

// The daylight window, as main-site/js/theme.js has it.
const int lightFromHour = 9;
const int lightUntilHour = 18;

const String _kMaterial = 'uwumaps.materialYou';
const String _kPhoneColours = 'uwumaps.phoneColours';
const String _kPhoneFont = 'uwumaps.phoneFont';
const String _kMaterialMode = 'uwumaps.materialMode';
const String _kMaterialSwatch = 'uwumaps.materialSwatch';
const String _kMode = 'uwumaps.mode';
const String _kColor = 'uwumaps.colorTheme';

bool isDaylightHours(DateTime now) => now.hour >= lightFromHour && now.hour < lightUntilHour;

class ThemeController extends ChangeNotifier with WidgetsBindingObserver {
  bool materialYou = true;
  bool phoneColours = true;
  bool phoneFont = true;
  // phone, light, dark or time.
  String materialMode = 'phone';
  String materialSwatch = 'classic';
  // light, dark or time. Stores the preference, never the mode it resolves to.
  String uwuMode = 'light';
  String colorTheme = 'classic';
  String? deviceFont;
  ColorScheme? lightDynamic;
  ColorScheme? darkDynamic;
  Timer? _timer;

  Future<void> init() async {
    materialYou = Prefs.getBool(_kMaterial, true);
    phoneColours = Prefs.getBool(_kPhoneColours, true);
    phoneFont = Prefs.getBool(_kPhoneFont, true);
    materialMode = Prefs.getString(_kMaterialMode) ?? 'phone';
    materialSwatch = Prefs.getString(_kMaterialSwatch) ?? 'classic';
    uwuMode = Prefs.getString(_kMode) ?? 'light';
    colorTheme = Prefs.getString(_kColor) ?? 'classic';
    if (!['light', 'dark', 'time'].contains(uwuMode)) uwuMode = 'light';
    if (!['phone', 'light', 'dark', 'time'].contains(materialMode)) materialMode = 'phone';
    deviceFont = await Device.bodyFont();
    WidgetsBinding.instance.addObserver(this);
    _schedule();
  }

  Brightness get _phone => SchedulerBinding.instance.platformDispatcher.platformBrightness;

  /// What the choice comes to right now.
  bool get isDark {
    final pref = materialYou ? materialMode : uwuMode;
    switch (pref) {
      case 'phone':
        return _phone == Brightness.dark;
      case 'dark':
        return true;
      case 'time':
        return !isDaylightHours(DateTime.now());
      default:
        return false;
    }
  }

  String get modePreference => materialYou ? materialMode : uwuMode;

  Color get brand => brandSwatches.firstWhere((s) => s.id == colorTheme, orElse: () => brandSwatches.first).color;

  Color get materialSeed => brandSwatches.firstWhere((s) => s.id == materialSwatch, orElse: () => brandSwatches.first).color;

  void setMaterialYou(bool on) {
    materialYou = on;
    Prefs.setBool(_kMaterial, on);
    _changed();
  }

  void setPhoneColours(bool on) {
    phoneColours = on;
    Prefs.setBool(_kPhoneColours, on);
    _changed();
  }

  void setPhoneFont(bool on) {
    phoneFont = on;
    Prefs.setBool(_kPhoneFont, on);
    _changed();
  }

  void setMode(String pref) {
    if (materialYou) {
      materialMode = pref;
      Prefs.setString(_kMaterialMode, pref);
    } else {
      uwuMode = pref;
      Prefs.setString(_kMode, pref);
    }
    _changed();
  }

  void setSwatch(String id) {
    if (materialYou) {
      materialSwatch = id;
      Prefs.setString(_kMaterialSwatch, id);
    } else {
      colorTheme = id;
      Prefs.setString(_kColor, id);
    }
    _changed();
  }

  void _changed() {
    _schedule();
    notifyListeners();
  }

  // One timer to the next 09:00 or 18:00 rather than polling, and a look on coming back, since a phone
  // that sleeps through the boundary fires its timer late.
  void _schedule() {
    _timer?.cancel();
    _timer = null;
    if (modePreference != 'time') return;
    final now = DateTime.now();
    DateTime next;
    if (now.hour < lightFromHour) {
      next = DateTime(now.year, now.month, now.day, lightFromHour);
    } else if (now.hour < lightUntilHour) {
      next = DateTime(now.year, now.month, now.day, lightUntilHour);
    } else {
      next = DateTime(now.year, now.month, now.day + 1, lightFromHour);
    }
    _timer = Timer(next.difference(now) + const Duration(seconds: 1), () {
      notifyListeners();
      _schedule();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && modePreference == 'time') {
      notifyListeners();
      _schedule();
    }
  }

  @override
  void didChangePlatformBrightness() {
    if (materialMode == 'phone') notifyListeners();
  }

  /// The uwuapps theme hides the status bar, as the website's app does. Material You shows it, edge to
  /// edge, as Android's own apps do.
  void applySystemBars() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: materialYou ? SystemUiOverlay.values : [SystemUiOverlay.bottom]);
  }

  /// The theme, given the phone's colours where it has them.
  ThemeData build(ColorScheme? light, ColorScheme? dark_) {
    lightDynamic = light;
    darkDynamic = dark_;
    final dark = isDark;
    if (materialYou) {
      final phone = phoneColours ? (dark ? dark_?.harmonized() : light?.harmonized()) : null;
      final scheme = phone ?? ColorScheme.fromSeed(seedColor: materialSeed, brightness: dark ? Brightness.dark : Brightness.light);
      // The phone's font: its own apps' font where Android names it, and otherwise its default.
      final family = phoneFont ? (deviceFont ?? 'sans-serif') : 'Jua';
      return ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        fontFamily: family,
        fontFamilyFallback: const ['sans-serif'],
        scaffoldBackgroundColor: scheme.surface,
        extensions: [Tokens.material(scheme)],
      );
    }
    final tokens = Tokens.uwu(brand, dark: dark);
    final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF1F6B3D), brightness: dark ? Brightness.dark : Brightness.light).copyWith(
      primary: tokens.brandInk,
      surface: tokens.page,
      onSurface: tokens.ink,
      error: tokens.error,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      fontFamily: 'Jua',
      fontFamilyFallback: const ['sans-serif'],
      scaffoldBackgroundColor: tokens.page,
      textSelectionTheme: TextSelectionThemeData(cursorColor: tokens.brandInk, selectionColor: mix(tokens.brandInk, 0.3, transparentInk), selectionHandleColor: tokens.brandInk),
      splashFactory: NoSplash.splashFactory,
      highlightColor: Colors.transparent,
      extensions: [tokens],
    );
  }
}

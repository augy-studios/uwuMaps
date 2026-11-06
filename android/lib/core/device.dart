// The app's own native side (android/app/src/main/kotlin/.../MainActivity.kt): the few things no plugin
// offers. Every call answers a safe default where there's no such thing, as in the browser test build.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'config.dart';

class Device {
  static const MethodChannel _channel = MethodChannel('org.uwuapps.uwumaps/device');
  static final StreamController<Map<String, dynamic>> _installs = StreamController.broadcast();
  static bool _listening = false;

  static Stream<Map<String, dynamic>> get installEvents {
    if (!_listening) {
      _listening = true;
      _channel.setMethodCallHandler((call) async {
        if (call.method == 'installStatus') _installs.add(Map<String, dynamic>.from(call.arguments as Map));
      });
    }
    return _installs.stream;
  }

  static Future<T?> _call<T>(String method, [Object? args]) async {
    if (kIsWeb) return null;
    try {
      return await _channel.invokeMethod<T>(method, args);
    } on MissingPluginException {
      return null;
    } on PlatformException catch (err) {
      debugPrint('Device.$method: ${err.message}');
      return null;
    }
  }

  /// The font family this phone's own apps use for their text, where it can be named.
  static Future<String?> bodyFont() => _call<String>('bodyFont');

  static Future<int?> freeBytes() => _call<int>('freeBytes');

  /// Leaves the app without closing it, as Back does at its first screen.
  static Future<void> moveToBack() => _call<void>('moveToBack');

  static Future<bool> canInstall() async => testBuild || (await _call<bool>('canInstall') ?? false);

  /// A Samsung phone on One UI 6 (Android 14) or later, where Auto Blocker may be on.
  static Future<bool> autoBlockerPossible() async => await _call<bool>('autoBlockerPossible') ?? false;

  /// Security and privacy, where Auto Blocker is.
  static Future<void> openSecuritySettings() => _call<void>('openSecuritySettings');

  static Future<void> openInstallSettings() => _call<void>('openInstallSettings');

  /// What's in a downloaded APK: { package, versionCode }.
  static Future<Map<String, dynamic>?> archiveInfo(String path) async {
    if (testBuild) return const {'package': 'org.uwuapps.uwumaps', 'versionCode': 1 << 30};
    final info = await _call<Map<Object?, Object?>>('archiveInfo', {'path': path});
    return info == null ? null : Map<String, dynamic>.from(info);
  }

  static Future<int> versionCode() async => await _call<int>('versionCode') ?? 0;

  /// Hands an APK to Android's installer. How it went arrives on [installEvents].
  static Future<void> installApk(String path) => _call<void>('installApk', {'path': path});
}

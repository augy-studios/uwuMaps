// Settings on the device, under the site's key names so the two read alike.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class Prefs {
  static late SharedPreferences _p;

  static Future<void> init() async {
    _p = await SharedPreferences.getInstance();
  }

  static T readJson<T>(String key, T fallback) {
    try {
      final raw = _p.getString(key);
      if (raw == null) return fallback;
      final value = jsonDecode(raw);
      return value is T ? value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  static void writeJson(String key, Object? value) {
    _p.setString(key, jsonEncode(value));
  }

  static String? getString(String key) => _p.getString(key);

  static void setString(String key, String value) {
    _p.setString(key, value);
  }

  static void remove(String key) {
    _p.remove(key);
  }

  static bool getBool(String key, bool fallback) => _p.getBool(key) ?? fallback;

  static void setBool(String key, bool value) {
    _p.setBool(key, value);
  }
}

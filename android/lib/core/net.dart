// Being online, and asking the network for things.

import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'config.dart';

class Net {
  static final ValueNotifier<bool> online = ValueNotifier(true);
  static final http.Client client = http.Client();

  static Future<void> init() async {
    void apply(List<ConnectivityResult> r) {
      online.value = !r.contains(ConnectivityResult.none) || r.isEmpty;
    }

    try {
      apply(await Connectivity().checkConnectivity());
      Connectivity().onConnectivityChanged.listen(apply);
    } catch (_) {
      // Reported as online, and each request says for itself if it isn't.
    }
  }

  static Map<String, String> get _ua => kIsWeb ? const {} : const {'User-Agent': userAgent};

  static Future<http.Response> get(Uri url, {Map<String, String>? headers, Duration timeout = const Duration(seconds: 20)}) {
    return client.get(url, headers: {..._ua, ...?headers}).timeout(timeout);
  }

  static Future<http.Response> send(String method, Uri url, Object? body) {
    final request = http.Request(method, url)
      ..headers.addAll({..._ua, 'Content-Type': 'application/json'})
      ..body = jsonEncode(body);
    return client.send(request).then(http.Response.fromStream).timeout(const Duration(seconds: 20));
  }

  static dynamic decode(http.Response res) => jsonDecode(utf8.decode(res.bodyBytes));
}

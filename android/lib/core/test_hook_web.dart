// What Playwright asks the browser test build through window.__uwu, since Flutter draws on a canvas and
// there's no DOM to look at. Only present with --dart-define=UWU_TEST=true.

import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import 'config.dart';

void installTestHook(String Function() state, Future<String> Function(String method, String arg) call) {
  if (!testBuild) return;
  final hook = JSObject();
  hook.setProperty('state'.toJS, (() => state().toJS).toJS);
  hook.setProperty('call'.toJS, ((JSString method, JSString arg) => call(method.toDart, arg.toDart).then((v) => v.toJS).toJS).toJS);
  web.window.setProperty('__uwu'.toJS, hook);
}

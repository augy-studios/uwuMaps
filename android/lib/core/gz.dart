// Gunzip. dart:io's native codec on the phone, and a pure Dart one in the browser test build.

export 'gz_io.dart' if (dart.library.js_interop) 'gz_web.dart';

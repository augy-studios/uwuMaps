// Where a pack's files are kept: on disk on the phone, and in memory in the browser test build.

export 'pack_files_io.dart' if (dart.library.js_interop) 'pack_files_web.dart';

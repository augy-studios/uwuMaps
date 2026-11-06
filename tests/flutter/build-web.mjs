#!/usr/bin/env node
// Builds the Android app's Dart code for the browser, for Playwright. Flutter's web build runs the same
// widgets, theme, router, packs and sharing as the APK; its map is MapLibre GL JS rather than MapLibre
// Native, and what only a phone has (the wallpaper's colours, the installer) is covered on an emulator.
//
//   node tests/flutter/build-web.mjs

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../../android/', import.meta.url));
const origin = `http://127.0.0.1:${process.env.FLUTTER_PORT || 4180}`;
const local = join(homedir(), 'flutter', 'bin', 'flutter.bat');
const flutter = process.env.FLUTTER_ROOT ? join(process.env.FLUTTER_ROOT, 'bin', 'flutter.bat') : (existsSync(local) ? local : 'flutter');

execFileSync(process.execPath, [join(app, 'tool', 'sync-assets.mjs')], { stdio: 'inherit' });
const defines = {
  UWU_TEST: 'true',
  UWU_SITE: origin,
  UWU_API: origin,
  UWU_PACKS: `${origin}/__release`,
  UWU_RELEASES: `${origin}/__releases?page=`,
  UWU_APK_PREFIX: `${origin}/__apk/`,
  UWU_VERSION: '1.0.0',
};
execFileSync(flutter, ['build', 'web', '--no-pub', '--no-web-resources-cdn', '--no-wasm-dry-run', '--source-maps', '--profile', ...Object.entries(defines).map(([k, v]) => `--dart-define=${k}=${v}`)], { cwd: app, stdio: 'inherit', shell: true });

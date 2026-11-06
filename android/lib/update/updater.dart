// Knowing about the app's releases on GitHub, for the update bar and the updater's page (update_page.dart).
// With no website inside the app, a new feature only ever arrives by a new release. The app reads the
// releases directly: GitHub's limit of 60 requests an hour applies per phone, far more than it asks.
//
// In step with SG Bus Timings' main-site/api/_lib/release.js, whose page this follows.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../core/config.dart';
import '../core/net.dart';

const int _pages = 10;

class NoteItem {
  const NoteItem(this.title, this.text);
  final String title;
  final String text;
}

class NoteGroup {
  NoteGroup(this.title);
  final String title;
  final List<NoteItem> items = [];
}

/// A release as the updater wants it.
class AppRelease {
  const AppRelease({required this.version, required this.apk, required this.size, required this.sha256, required this.page, required this.date, required this.summary, required this.notes});
  final String version;
  final String apk;
  final int size;
  final String? sha256;
  final String page;
  final String? date;
  final String summary;
  final List<NoteGroup> notes;
}

/// Whether version a comes after version b, number by number: 1.10.0 after 1.9.0.
bool isNewer(String a, String b) {
  int number(List<String> parts, int i) => i < parts.length ? int.tryParse(parts[i].replaceAll(RegExp(r'\D'), '')) ?? 0 : 0;
  final x = a.split('.');
  final y = b.split('.');
  final n = x.length > y.length ? x.length : y.length;
  for (var i = 0; i < n; i++) {
    final d = number(x, i) - number(y, i);
    if (d != 0) return d > 0;
  }
  return false;
}

String _plain(String s) => s
    .replaceAllMapped(RegExp(r'\*\*(.+?)\*\*'), (m) => m[1]!)
    .replaceAllMapped(RegExp(r'`([^`]+)`'), (m) => m[1]!)
    .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m[1]!)
    .replaceAllMapped(RegExp(r'(^|[\s(])_([^_]+)_(?=[\s).,:;]|$)'), (m) => '${m[1]}${m[2]}')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

/// What's new in a release, from its notes as release/README.md has them written: the first paragraph
/// as the summary, and under "## What's new" each "###" heading as a group of its items, "- **Title**:
/// text" as a title and text. Plain text, the Markdown taken out.
({String summary, List<NoteGroup> notes}) notesOf(String? body) {
  final text = (body ?? '').replaceAll('\r\n', '\n');
  final first = text.trim().split(RegExp(r'\n\s*\n')).first;
  final summary = first.startsWith('#') || first.startsWith('|') ? '' : _plain(first);
  final notes = <NoteGroup>[];
  final at = RegExp(r"^##\s+What.s new\s*$", multiLine: true, caseSensitive: false).firstMatch(text);
  if (at != null) {
    NoteGroup? group;
    final lines = text.substring(at.start).split('\n').skip(1);
    for (final line in lines) {
      if (RegExp(r'^##\s').hasMatch(line)) break;
      final head = RegExp(r'^###\s+(.+)').firstMatch(line);
      if (head != null) {
        group = NoteGroup(_plain(head[1]!));
        notes.add(group);
        continue;
      }
      final item = RegExp(r'^[-*]\s+(.+)').firstMatch(line);
      if (item != null) {
        if (group == null) {
          group = NoteGroup("What's new");
          notes.add(group);
        }
        final titled = RegExp(r'^\*\*(.+?)\*\*\s*[:.]?\s*(.*)$').firstMatch(item[1]!);
        group.items.add(titled != null ? NoteItem(_plain(titled[1]!).replaceFirst(RegExp(r'[:.]$'), ''), _plain(titled[2]!)) : NoteItem('', _plain(item[1]!)));
      } else if (group != null && group.items.isNotEmpty && RegExp(r'^\s+\S').hasMatch(line)) {
        // A line carried on, or a point under the item: part of the item.
        final last = group.items.removeLast();
        group.items.add(NoteItem(last.title, '${last.text} ${_plain(line.replaceFirst(RegExp(r'^\s*[-*]\s+'), ''))}'.trim()));
      }
    }
  }
  return (summary: summary, notes: notes.where((g) => g.items.isNotEmpty).toList());
}

/// A release as the app wants it, or null if it isn't one to offer: a draft, a pre-release, a tag that
/// isn't android-v*, or one published before its APK finished uploading.
AppRelease? asRelease(Map<String, dynamic> rel) {
  final m = RegExp(r'^android-v(\d+(?:\.\d+)*)$').firstMatch((rel['tag_name'] as String?) ?? '');
  if (m == null || rel['draft'] == true || rel['prerelease'] == true) return null;
  final version = m[1]!;
  final assets = ((rel['assets'] as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
  final apk = assets.where((a) => a['name'] == 'uwumaps-$version.apk').firstOrNull ?? assets.where((a) => RegExp(r'\.apk$', caseSensitive: false).hasMatch(a['name'] as String) && !RegExp('watch', caseSensitive: false).hasMatch(a['name'] as String)).firstOrNull;
  if (apk == null || apk['state'] != 'uploaded') return null;
  final digest = (apk['digest'] as String?) ?? '';
  final notes = notesOf(rel['body'] as String?);
  return AppRelease(
    version: version,
    apk: apk['browser_download_url'] as String,
    size: (apk['size'] as num?)?.toInt() ?? -1,
    sha256: RegExp(r'^sha256:[0-9a-f]{64}$', caseSensitive: false).hasMatch(digest) ? digest.substring(7).toLowerCase() : null,
    page: (rel['html_url'] as String?) ?? '',
    date: rel['published_at'] as String?,
    summary: notes.summary,
    notes: notes.notes,
  );
}

class Updater extends ChangeNotifier {
  String version = '';

  /// Every release to offer, newest first.
  List<AppRelease> history = const [];

  /// The newest release if it's newer than this app.
  AppRelease? available;
  bool dismissed = false;
  DateTime? _lastCheck;

  Future<void> init() async {
    version = kIsWeb ? const String.fromEnvironment('UWU_VERSION', defaultValue: '1.0.0') : (await PackageInfo.fromPlatform()).version;
    notifyListeners();
    unawaited(check().catchError((Object _) {}));
  }

  /// Reads every release, from every page of them. Throws if GitHub can't be reached.
  Future<void> check() async {
    _lastCheck = DateTime.now();
    final found = <AppRelease>[];
    for (var page = 1; page <= _pages; page++) {
      final res = await Net.get(Uri.parse('$releasesApi$page'), headers: const {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}, timeout: const Duration(seconds: 15));
      if (res.statusCode != 200) throw Exception('GitHub replied ${res.statusCode}');
      final list = Net.decode(res);
      if (list is! List) break;
      for (final r in list) {
        final release = asRelease(r as Map<String, dynamic>);
        if (release != null) found.add(release);
      }
      // The last page: GitHub names no next one.
      if (!RegExp('rel="next"').hasMatch(res.headers['link'] ?? '')) break;
    }
    found.sort((a, b) => isNewer(a.version, b.version) ? -1 : (isNewer(b.version, a.version) ? 1 : 0));
    history = found;
    available = found.isNotEmpty && isNewer(found.first.version, version) ? found.first : null;
    notifyListeners();
  }

  /// On returning to the app, after an hour.
  void onResume() {
    final last = _lastCheck;
    if (Net.online.value && (last == null || DateTime.now().difference(last).inHours >= 1)) unawaited(check().catchError((Object _) {}));
  }

  void dismiss() {
    dismissed = true;
    notifyListeners();
  }

  /// Where the APK may come from: this repository's releases, and nowhere else.
  static bool isOurs(String url) => url.startsWith(apkPrefix);
}

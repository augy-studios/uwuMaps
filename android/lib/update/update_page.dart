// The updater: a page of its own in Material 3, as SG Bus Timings' UpdateActivity.java and its
// update_activity.xml have it, to the same measures. Its colours come from the phone's wallpaper on Android
// 12 and later, light or dark as the phone is, in either of the app's looks: what's happening at the top,
// and under it a changelog, each release on a timeline with what's new in it from its notes on GitHub, as
// cards by heading. The release you'd get opens by itself, or the one installed when there's nothing newer.
//
// Checks before anything is installed:
// - The APK comes only from this repository's releases on GitHub.
// - Its SHA-256 matches the checksum GitHub publishes for the file, when it has one.
// - It's this app, with a higher versionCode than the one installed.
// Android checks the rest: it only updates an app with an APK signed by the same key.
//
// Samsung's Auto Blocker (One UI 6 and later) is a second gate. Nothing public says whether it's on, and
// Android's installer doesn't name it, so on a Samsung phone an update that fails, is cancelled, or goes
// unanswered gets an explanation and a button to Security settings.

import 'dart:async';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import '../app.dart';
import '../core/config.dart';
import '../core/device.dart';
import 'apk_file.dart';
import 'updater.dart';

const String _appName = 'uwuMaps';
const String _releasesPage = 'https://github.com/augy-studios/uwuMaps/releases';
const Duration _noAnswer = Duration(seconds: 30);
// A group's first few items, the rest under Show all.
const int _firstItems = 4;

Future<void> openUpdatePage(BuildContext context, {required bool checkOnly}) {
  return Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => UpdatePage(checkOnly: checkOnly)));
}

/* ---- the page's theme: the phone's colours, or the app's green's tonal palette before Android 12 ---- */

const ColorScheme _lightGreen = ColorScheme(
  brightness: Brightness.light,
  primary: Color(0xFF3C6939),
  onPrimary: Color(0xFFFFFFFF),
  primaryContainer: Color(0xFFBCF0B4),
  onPrimaryContainer: Color(0xFF002204),
  secondary: Color(0xFF52634F),
  onSecondary: Color(0xFFFFFFFF),
  secondaryContainer: Color(0xFFD6E8CE),
  onSecondaryContainer: Color(0xFF111F0F),
  tertiary: Color(0xFF38656A),
  onTertiary: Color(0xFFFFFFFF),
  tertiaryContainer: Color(0xFFBCEBF0),
  onTertiaryContainer: Color(0xFF002023),
  error: Color(0xFFBA1A1A),
  onError: Color(0xFFFFFFFF),
  errorContainer: Color(0xFFFFDAD6),
  onErrorContainer: Color(0xFF410002),
  surface: Color(0xFFF7FBF1),
  onSurface: Color(0xFF191D17),
  onSurfaceVariant: Color(0xFF424940),
  outline: Color(0xFF72796F),
  outlineVariant: Color(0xFFC2C9BD),
  surfaceContainerLowest: Color(0xFFFFFFFF),
  surfaceContainerLow: Color(0xFFF1F5EB),
  surfaceContainer: Color(0xFFECEFE6),
  surfaceContainerHigh: Color(0xFFE6E9E0),
  surfaceContainerHighest: Color(0xFFE0E4DB),
  surfaceBright: Color(0xFFF7FBF1),
  surfaceDim: Color(0xFFD8DBD2),
  inverseSurface: Color(0xFF2D322C),
  onInverseSurface: Color(0xFFEFF2E9),
  inversePrimary: Color(0xFFA1D39A),
);

const ColorScheme _darkGreen = ColorScheme(
  brightness: Brightness.dark,
  primary: Color(0xFFA1D39A),
  onPrimary: Color(0xFF0A390F),
  primaryContainer: Color(0xFF245024),
  onPrimaryContainer: Color(0xFFBCF0B4),
  secondary: Color(0xFFBACCB3),
  onSecondary: Color(0xFF253423),
  secondaryContainer: Color(0xFF3B4B38),
  onSecondaryContainer: Color(0xFFD6E8CE),
  tertiary: Color(0xFFA0CFD4),
  onTertiary: Color(0xFF00363B),
  tertiaryContainer: Color(0xFF1F4D52),
  onTertiaryContainer: Color(0xFFBCEBF0),
  error: Color(0xFFFFB4AB),
  onError: Color(0xFF690005),
  errorContainer: Color(0xFF93000A),
  onErrorContainer: Color(0xFFFFDAD6),
  surface: Color(0xFF10140F),
  onSurface: Color(0xFFE0E4DB),
  onSurfaceVariant: Color(0xFFC2C9BD),
  outline: Color(0xFF8C9388),
  outlineVariant: Color(0xFF424940),
  surfaceContainerLowest: Color(0xFF0B0F0A),
  surfaceContainerLow: Color(0xFF191D17),
  surfaceContainer: Color(0xFF1D211B),
  surfaceContainerHigh: Color(0xFF272B25),
  surfaceContainerHighest: Color(0xFF323630),
  surfaceBright: Color(0xFF363A34),
  surfaceDim: Color(0xFF10140F),
  inverseSurface: Color(0xFFE0E4DB),
  onInverseSurface: Color(0xFF2D322C),
  inversePrimary: Color(0xFF3C6939),
);

ThemeData _pageTheme() {
  final dark = SchedulerBinding.instance.platformDispatcher.platformBrightness == Brightness.dark;
  final phone = dark ? app.theme.darkDynamic : app.theme.lightDynamic;
  return ThemeData(
    useMaterial3: true,
    colorScheme: phone ?? (dark ? _darkGreen : _lightGreen),
    fontFamily: app.theme.deviceFont ?? 'sans-serif',
    fontFamilyFallback: const ['sans-serif'],
  );
}

/* ---- icons, as SG Bus Timings' update_ic_*.xml ---- */

const Map<String, String> _strokes = {
  'alert': 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  'bell': 'M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0',
  'check': 'm5 12.5 4.5 4.5L19 7.5',
  'download': 'M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  'expand': 'M6,9l6,6l6,-6',
  'eye': 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM9,12a3,3 0 1,0 6,0a3,3 0 1,0 -6,0z',
  'map': 'm9 4-6 2.5v13L9 17l6 2.5 6-2.5v-13L15 6.5zM9 4v13M15 6.5v13',
  'navigate': 'm3 11 18-8-8 18-2-8z',
  'phone': 'M8.7,2.5h6.6a2.2,2.2 0 0 1 2.2,2.2v14.6a2.2,2.2 0 0 1 -2.2,2.2h-6.6a2.2,2.2 0 0 1 -2.2,-2.2v-14.6a2.2,2.2 0 0 1 2.2,-2.2zM11 18h2',
  'settings': 'M9,12a3,3 0 1,0 6,0a3,3 0 1,0 -6,0zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  'star': 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z',
  'sun': 'M8,12a4,4 0 1,0 8,0a4,4 0 1,0 -8,0zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4',
  'terminal': 'M5,4h14a2,2 0 0 1 2,2v12a2,2 0 0 1 -2,2h-14a2,2 0 0 1 -2,-2v-12a2,2 0 0 1 2,-2zm2 5 3 3-3 3M13 15h4',
  'train': 'M8,3h8a3,3 0 0 1 3,3v8a3,3 0 0 1 -3,3h-8a3,3 0 0 1 -3,-3v-8a3,3 0 0 1 3,-3zM5 11h14M9 21l1.5-4M15 21l-1.5-4M8.2,14a0.8,0.8 0 1,0 1.6,0a0.8,0.8 0 1,0 -1.6,0zM14.2,14a0.8,0.8 0 1,0 1.6,0a0.8,0.8 0 1,0 -1.6,0z',
};

const String _github = 'M8,0C3.58,0 0,3.58 0,8c0,3.54 2.29,6.53 5.47,7.59 0.4,0.07 0.55,-0.17 0.55,-0.38 0,-0.19 -0.01,-0.82 -0.01,-1.49 -2.01,0.37 -2.53,-0.49 -2.69,-0.94 -0.09,-0.23 -0.48,-0.94 -0.82,-1.13 -0.28,-0.15 -0.68,-0.52 -0.01,-0.53 0.63,-0.01 1.08,0.58 1.23,0.82 0.72,1.21 1.87,0.87 2.33,0.66 0.07,-0.52 0.28,-0.87 0.51,-1.07 -1.78,-0.2 -3.64,-0.89 -3.64,-3.95 0,-0.87 0.31,-1.59 0.82,-2.15 -0.08,-0.2 -0.36,-1.02 0.08,-2.12 0,0 0.67,-0.21 2.2,0.82 0.64,-0.18 1.32,-0.27 2,-0.27 0.68,0 1.36,0.09 2,0.27 1.53,-1.04 2.2,-0.82 2.2,-0.82 0.44,1.1 0.16,1.92 0.08,2.12 0.51,0.56 0.82,1.27 0.82,2.15 0,3.07 -1.87,3.75 -3.65,3.95 0.29,0.25 0.54,0.73 0.54,1.48 0,1.07 -0.01,1.93 -0.01,2.2 0,0.21 0.15,0.46 0.55,0.38A8.013,8.013 0,0 0,16 8c0,-4.42 -3.58,-8 -8,-8z';

class _Ic extends StatelessWidget {
  const _Ic(this.name, this.size, this.color);
  final String name;
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final hex = '#${color.toARGB32().toRadixString(16).padLeft(8, '0').substring(2)}';
    final svg = name == 'github'
        ? '<svg viewBox="0 0 16 16"><path fill="$hex" fill-rule="evenodd" d="$_github"/></svg>'
        : '<svg viewBox="0 0 24 24"><path fill="none" stroke="$hex" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="${_strokes[name]}"/></svg>';
    return SvgPicture.string(svg, width: size, height: size, excludeFromSemantics: true);
  }
}

// An icon for a group by its heading in the notes.
String _groupIcon(String title) {
  final t = title.toLowerCase();
  if (t.contains('android') || t.contains('wear')) return 'phone';
  if (t.contains('command line') || t.contains('linux') || t.contains('desktop') || t.contains('windows')) return 'terminal';
  if (t.contains('favourite') || t.contains('saved')) return 'star';
  if (t.contains('navigate') || t.contains('direction')) return 'navigate';
  if (t.contains('trip') || t.contains('train') || t.contains('transport')) return 'train';
  if (t.contains('alert') || t.contains('newsfeed')) return 'bell';
  if (t.contains('map') || t.contains('explorer')) return 'map';
  if (t.contains('look') || t.contains('language') || t.contains('theme')) return 'sun';
  if (t.contains('setting') || t.contains('page')) return 'settings';
  if (t.contains('glance')) return 'eye';
  if (t.contains('easier') || t.contains('fix')) return 'check';
  return 'star';
}

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// When a release came out: Today, Yesterday, 3 days ago, or 23 Oct 2026, by Singapore's clock.
String? _dateText(String? iso) {
  if (iso == null || iso.isEmpty) return null;
  final date = DateTime.tryParse(iso);
  if (date == null) return null;
  const sg = Duration(hours: 8);
  int dayNumber(DateTime d) => (d.toUtc().add(sg).millisecondsSinceEpoch / 86400000).floor();
  final days = dayNumber(DateTime.now()) - dayNumber(date);
  if (days <= 0) return 'Today';
  if (days == 1) return 'Yesterday';
  if (days < 7) return '$days days ago';
  final at = date.toUtc().add(sg);
  return '${at.day} ${_months[at.month - 1]} ${at.year}';
}

String _capitalised(String text) => text.isEmpty ? text : '${text[0].toUpperCase()}${text.substring(1)}';

/* ---- the page ---- */

class _Action {
  const _Action(this.label, this.run, {this.icon});
  final String label;
  final VoidCallback run;
  final String? icon;
}

class _Stop implements Exception {
  const _Stop(this.message);
  final String message;
}

class UpdatePage extends StatefulWidget {
  const UpdatePage({super.key, required this.checkOnly});

  /// The Edge Tray's check, rather than the update bar's Update, which has already asked.
  final bool checkOnly;

  @override
  State<UpdatePage> createState() => _UpdatePageState();
}

class _UpdatePageState extends State<UpdatePage> with WidgetsBindingObserver {
  String _title = '';
  String? _text;
  String _statusIcon = 'settings';
  bool _problem = false;
  bool _showProgress = false;
  // From 0 to 100, or -1 while there's no telling.
  int _percent = -1;
  _Action? _primary;
  _Action? _secondary;
  bool _primaryFilled = true;

  bool _working = false;
  bool _cancelled = false;
  bool _askedToAllow = false;
  bool _askedToUnblock = false;
  bool _installing = false;
  bool _autoBlocker = false;
  Timer? _silence;
  // The update to install, once found and wanted: kept while you're in "Install unknown apps", and for
  // "Try again", so neither looks it up again.
  AppRelease? _release;
  StreamSubscription<Map<String, dynamic>>? _installs;
  bool _changelogReady = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _installs = Device.installEvents.listen(_onInstall);
    // Edge to edge, whichever look the app is in.
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.manual, overlays: SystemUiOverlay.values);
    _begin();
  }

  Future<void> _begin() async {
    _autoBlocker = await Device.autoBlockerPossible();
    _start();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _installs?.cancel();
    _silence?.cancel();
    _cancelled = true;
    app.theme.applySystemBars();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    if (_askedToAllow && !_working) {
      // Back from "Install unknown apps".
      _askedToAllow = false;
      Device.canInstall().then((allowed) {
        if (!mounted) return;
        if (allowed) {
          _start();
        } else {
          _showProblem('Not allowed to update', "$_appName wasn't allowed to install apps, so it can't update itself.", _Action('Try again', _askToAllow), _Action('Close', _finish));
        }
      });
    } else if (_askedToUnblock && !_working) {
      // Back from Security settings, with no telling whether Auto Blocker is off now.
      _askedToUnblock = false;
      _show('Ready to try again', 'If Auto Blocker is off now, tap Try again to install ${_which()}.', _Action('Try again', _start), _Action('Not now', _finish));
    } else if (_installing) {
      // Back from the installer's screen: waiting for its answer again.
      _waitForAnswer();
    }
  }

  void _finish() {
    _cancelled = true;
    if (mounted) Navigator.of(context).maybePop();
  }

  String _which() => _release != null ? 'version ${_release!.version}' : 'the update';

  /* ---- steps ---- */

  void _askToAllow() {
    final found = _release != null ? 'Version ${_release!.version} is out. ' : '';
    _show(
      'Allow updates',
      '${found}To update itself, $_appName needs your OK to install apps. Turn on "Allow from this source" on the next screen, then come back.',
      _Action('Continue', () {
        _askedToAllow = true;
        Device.openInstallSettings();
      }),
      _Action('Not now', _finish),
    );
  }

  // Samsung's Auto Blocker, the likeliest reason an update didn't install on a Samsung phone that allows
  // this app to install apps. Nothing public says whether it's on, so this says "probably".
  void _autoBlocked() {
    _installing = false;
    _silence?.cancel();
    _showProblem(
      'Update blocked',
      "${_capitalised(_which())} didn't install. Samsung's Auto Blocker probably stopped it: it only lets apps from the Play Store or Galaxy Store install, even with $_appName allowed to install apps.\n\nTurn it off in Settings > Security and privacy > Auto Blocker, then come back and tap Try again. It switches itself back on after 30 minutes if \"Turn on automatically\" is on; if not, turn it back on there once you've updated.",
      _Action('Open settings', () {
        _askedToUnblock = true;
        Device.openSecuritySettings();
      }),
      _Action('Not now', _finish),
    );
  }

  // Handed to the installer: on a Samsung phone, its silence for this long is taken as Auto Blocker.
  // Elsewhere the page waits as long as it takes.
  void _waitForAnswer() {
    _silence?.cancel();
    if (_autoBlocker) _silence = Timer(_noAnswer, _autoBlocked);
  }

  // The installer's answers.
  void _onInstall(Map<String, dynamic> e) {
    if (!mounted) return;
    final status = e['status'];
    _silence?.cancel();
    if (status == 'pending') return; // Only asking you first: Android's screen is up.
    _installing = false;
    if (status == 'success') {
      _finish(); // Android stops the app to replace it, so this rarely runs.
    } else if (status == 'aborted') {
      // "Cancel" on Android's own screen. Also what a screen that ends without Install answers, as
      // Samsung's does when Auto Blocker stops it.
      if (_autoBlocker) {
        _autoBlocked();
      } else {
        _finish();
      }
    } else {
      final conflict = status == 'conflict';
      final storage = status == 'storage';
      if (_autoBlocker && !conflict && !storage) {
        _autoBlocked();
        return;
      }
      _failed(conflict
          ? "Android wouldn't install the update over this app. Uninstall $_appName, then install it from GitHub."
          : storage
              ? "There isn't room on this phone for the update."
              : "Android couldn't install the update. Try again.");
    }
  }

  // Looks for the update, or carries on with the one already found.
  Future<void> _start() async {
    _cancelled = false;
    _installing = false;
    _silence?.cancel();
    final found = _release;
    _showWorking(found != null ? 'Updating' : 'Checking for updates', found != null ? 'Downloading version ${found.version}…' : (widget.checkOnly ? 'Checking for updates…' : 'Looking for the update…'), -1);
    _working = true;
    try {
      AppRelease? release = found;
      if (found == null) {
        release = await _latest();
        if (!mounted) return;
        setState(() => _changelogReady = true);
      }
      if (release == null) {
        _show("You're up to date", null, _Action('GitHub', () => _browse(_pageOf(app.updater.version)), icon: 'github'), _Action('Close', _finish));
        return;
      }
      final r = release;
      if (found == null && widget.checkOnly) {
        _show('Update available', null, _Action('Update to ${r.version}', () => _update(r), icon: 'download'), _Action('Not now', _finish));
        return;
      }
      if (!await Device.canInstall()) {
        _release = r;
        _askToAllow();
        return;
      }
      final apk = await _download(r);
      if (apk == null) return; // Cancelled.
      await _check(apk);
      if (!mounted) return;
      // Kept on a Samsung phone for Try again after Auto Blocker, which carries on with this version.
      if (_autoBlocker) _release = r;
      _showWorking('Updating', "Opening Android's installer…", -1);
      _installing = true;
      _waitForAnswer();
      await Device.installApk(apk.path);
    } on _Stop catch (p) {
      _failed(p.message);
    } catch (err) {
      debugPrint('Update: $err');
      _failed("Couldn't download the update. Check you're online, then try again.");
    } finally {
      _working = false;
    }
  }

  // "Update" on what a check found: on to downloading it, by way of "Install unknown apps" if this app
  // isn't allowed to install it yet.
  Future<void> _update(AppRelease release) async {
    _release = release;
    if (await Device.canInstall()) {
      _start();
    } else {
      _askToAllow();
    }
  }

  // The newest release if it's newer than this app, or null.
  Future<AppRelease?> _latest() async {
    try {
      await app.updater.check();
    } catch (err) {
      debugPrint('Update check: $err');
      throw const _Stop("Couldn't find out what the newest version is. Try again later.");
    }
    final release = app.updater.available;
    if (release != null && !Updater.isOurs(release.apk)) {
      throw const _Stop("The update isn't on $_appName's GitHub page, so it wasn't downloaded.");
    }
    return release;
  }

  // The APK, in this app's cache, or null if cancelled on the way.
  Future<ApkFile?> _download(AppRelease release) async {
    final label = 'Downloading version ${release.version}…';
    _showWorking('Updating', label, 0);
    final client = http.Client();
    final apk = await ApkFile.create();
    try {
      final req = http.Request('GET', Uri.parse(release.apk))..headers.addAll(kIsWeb ? const {} : const {'User-Agent': userAgent});
      final res = await client.send(req).timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw _Stop("GitHub didn't send the update (${res.statusCode}). Try again later.");
      final total = (res.contentLength ?? 0) > 0 ? res.contentLength! : release.size;
      final digest = _DigestSink();
      final hasher = sha256.startChunkedConversion(digest);
      var done = 0;
      var last = -1;
      await for (final chunk in res.stream) {
        if (_cancelled) {
          await apk.delete();
          return null;
        }
        apk.add(chunk);
        hasher.add(chunk);
        done += chunk.length;
        final percent = total > 0 ? math.min(100, done * 100 ~/ total) : -1;
        if (percent != last) {
          last = percent;
          final sizes = total > 0 ? '\n${_megabytes(done)} of ${_megabytes(total)}' : '';
          _showWorking('Updating', '$label$sizes', percent);
        }
      }
      hasher.close();
      await apk.close();
      if (release.sha256 != null && release.sha256!.toLowerCase() != digest.value.toString()) {
        await apk.delete();
        throw const _Stop("The download doesn't match the file on GitHub. Try again.");
      }
      return apk;
    } catch (_) {
      await apk.delete();
      rethrow;
    } finally {
      client.close();
    }
  }

  static String _megabytes(int bytes) => '${(bytes / 1000000).toStringAsFixed(1)} MB';

  // That the file is this app, and newer than the one installed.
  Future<void> _check(ApkFile apk) async {
    final info = await Device.archiveInfo(apk.path);
    if (info == null || info['package'] != 'org.uwuapps.uwumaps') {
      await apk.delete();
      throw const _Stop("The download isn't $_appName, so it wasn't installed.");
    }
    if ((info['versionCode'] as num).toInt() <= await Device.versionCode()) {
      await apk.delete();
      throw const _Stop("The download isn't newer than this app, so it wasn't installed.");
    }
  }

  /* ---- what's on the page ---- */

  // A step under way: percent from 0 to 100, or -1 while there's no telling.
  void _showWorking(String title, String text, int percent) {
    if (!mounted) return;
    setState(() {
      _title = title;
      _text = text;
      _statusIcon = 'download';
      _problem = false;
      _showProgress = true;
      _percent = percent;
      _primary = null;
      _secondary = _Action('Cancel', _finish);
    });
  }

  // A title, a message (or null for none) and up to two buttons, with nothing under way.
  void _show(String title, String? text, _Action primary, _Action secondary) {
    if (!mounted) return;
    setState(() {
      _title = title;
      _text = text;
      _statusIcon = 'settings';
      _problem = false;
      _showProgress = false;
      _primary = primary;
      _secondary = secondary;
      // GitHub, on the changelog, is a way to read more rather than a step on: outlined, as Close is.
      _primaryFilled = primary.icon != 'github';
    });
  }

  // The same for something that went wrong, its icon on the error colours.
  void _showProblem(String title, String text, _Action primary, _Action secondary) {
    _show(title, text, primary, secondary);
    if (!mounted) return;
    setState(() {
      _statusIcon = 'alert';
      _problem = true;
    });
  }

  void _failed(String message) {
    _installing = false;
    _silence?.cancel();
    _showProblem("Couldn't update", message, _Action('Try again', _start), _Action('Close', _finish));
  }

  void _browse(String url) {
    launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  // A release's page on GitHub, or the list of them.
  String _pageOf(String version) {
    for (final r in app.updater.history) {
      if (r.version == version && r.page.isNotEmpty) return r.page;
    }
    return _releasesPage;
  }

  @override
  Widget build(BuildContext context) {
    final theme = _pageTheme();
    return Theme(data: theme, child: Builder(builder: _page));
  }

  Widget _page(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final pad = MediaQuery.of(context).padding;
    final buttonsHeight = 32 + (_primary != null ? 64.0 + 12 : 12) + 64 + 16 + pad.bottom;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.transparent,
        statusBarIconBrightness: c.brightness == Brightness.dark ? Brightness.light : Brightness.dark,
        systemNavigationBarIconBrightness: c.brightness == Brightness.dark ? Brightness.light : Brightness.dark,
      ),
      child: Scaffold(
        backgroundColor: c.surface,
        body: Stack(
          children: [
            Positioned.fill(
              child: SingleChildScrollView(
                padding: EdgeInsets.fromLTRB(20 + pad.left, 24 + pad.top, 20 + pad.right, buttonsHeight),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        ClipOval(child: Image.asset('assets/app-icon.png', width: 64, height: 64, fit: BoxFit.cover, excludeFromSemantics: true)),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Semantics(header: true, child: Text(_title, style: text.headlineSmall!.copyWith(color: c.onSurface, fontWeight: FontWeight.bold))),
                              const SizedBox(height: 2),
                              Text('$_appName · v${app.updater.version}', style: text.bodyLarge!.copyWith(color: c.onSurfaceVariant)),
                            ],
                          ),
                        ),
                      ],
                    ),
                    if (_text != null) ...[
                      const SizedBox(height: 24),
                      _StatusCard(text: _text!, icon: _statusIcon, problem: _problem, showProgress: _showProgress, percent: _percent),
                    ],
                    const SizedBox(height: 24),
                    if (_changelogReady) const _Changelog(),
                  ],
                ),
              ),
            ),
            // Behind the status bar, so the changelog doesn't scroll up under the clock.
            Positioned(left: 0, right: 0, top: 0, height: pad.top, child: ColoredBox(color: c.surface)),
            // Over the bottom of the page, the changelog fading out under them. The first is the step
            // on, the second the way out.
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [c.surface, c.surface, c.surface.withValues(alpha: 0)]),
                ),
                padding: EdgeInsets.fromLTRB(20 + pad.left, 32, 20 + pad.right, 16 + pad.bottom),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_primary != null) _BigButton(action: _primary!, filled: _primaryFilled),
                    const SizedBox(height: 12),
                    if (_secondary != null) _BigButton(action: _secondary!, filled: false),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _DigestSink implements Sink<Digest> {
  late Digest value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}

class _BigButton extends StatelessWidget {
  const _BigButton({required this.action, required this.filled});
  final _Action action;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    final ink = filled ? c.onPrimary : c.onSurface;
    return Semantics(
      container: true,
      button: true,
      label: action.label,
      excludeSemantics: true,
      onTap: action.run,
      child: SizedBox(
        height: 64,
        child: Material(
          color: filled ? c.primary : c.surfaceContainerLow,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32), side: filled ? BorderSide.none : BorderSide(color: c.outlineVariant)),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: action.run,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (action.icon != null) ...[_Ic(action.icon!, 18, ink), const SizedBox(width: 8)],
                Text(action.label, style: Theme.of(context).textTheme.titleMedium!.copyWith(color: ink)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// The card at the top: a download under way, something for you to do, or a problem.
class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.text, required this.icon, required this.problem, required this.showProgress, required this.percent});
  final String text;
  final String icon;
  final bool problem;
  final bool showProgress;
  final int percent;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: c.surfaceContainerHigh, borderRadius: BorderRadius.circular(28)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: problem ? c.errorContainer : c.primaryContainer, borderRadius: BorderRadius.circular(12)),
                child: _Ic(icon, 22, problem ? c.onErrorContainer : c.onPrimaryContainer),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 40),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Semantics(liveRegion: true, child: Text(text, style: Theme.of(context).textTheme.bodyLarge!.copyWith(color: c.onSurface))),
                  ),
                ),
              ),
            ],
          ),
          if (showProgress) ...[const SizedBox(height: 16), WavyProgress(percent: percent)],
        ],
      ),
    );
  }
}

/* ---- the changelog ---- */

// Each release on a timeline, newest first: the ones newer than this app marked New, this one Installed,
// and "Earlier releases" before the rest. The one you'd get opens by itself, or this one when there's
// nothing newer.
class _Changelog extends StatelessWidget {
  const _Changelog();

  @override
  Widget build(BuildContext context) {
    final history = app.updater.history;
    final installed = app.updater.version;
    var open = -1;
    for (var i = 0; i < history.length && open < 0; i++) {
      if (!isNewer(history[i].version, installed)) open = i;
    }
    if (history.isNotEmpty && isNewer(history.first.version, installed)) open = 0;
    var labelled = false;
    final rows = <Widget>[];
    for (var i = 0; i < history.length; i++) {
      final notes = history[i];
      final isNew = isNewer(notes.version, installed);
      final isInstalled = notes.version == installed;
      if (!isNew && !isInstalled && !labelled) {
        labelled = true;
        rows.add(const _EarlierLabel());
      }
      rows.add(_ReleaseRow(key: ValueKey(notes.version), notes: notes, isNew: isNew, isInstalled: isInstalled, opened: i == open, last: i == history.length - 1));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}

class _EarlierLabel extends StatelessWidget {
  const _EarlierLabel();

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Stack(
      children: [
        Positioned(left: 11, top: 0, bottom: 0, width: 2, child: ColoredBox(color: c.outlineVariant)),
        Padding(
          padding: const EdgeInsets.fromLTRB(24 + 12, 4, 0, 24),
          child: Semantics(header: true, child: Text('Earlier releases', style: Theme.of(context).textTheme.titleSmall!.copyWith(color: c.onSurfaceVariant))),
        ),
      ],
    );
  }
}

class _ReleaseRow extends StatefulWidget {
  const _ReleaseRow({super.key, required this.notes, required this.isNew, required this.isInstalled, required this.opened, required this.last});
  final AppRelease notes;
  final bool isNew;
  final bool isInstalled;
  final bool opened;
  final bool last;

  @override
  State<_ReleaseRow> createState() => _ReleaseRowState();
}

class _ReleaseRowState extends State<_ReleaseRow> {
  late final bool _anything = widget.notes.notes.isNotEmpty || widget.notes.summary.isNotEmpty;
  late bool _open = widget.opened && _anything;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final notes = widget.notes;
    // The release you'd get, or have, as a ring; the rest as a small dot.
    final ring = widget.isNew || widget.isInstalled;
    final size = ring ? 16.0 : 10.0;
    final count = notes.notes.fold<int>(0, (n, g) => n + g.items.length);
    final when = _dateText(notes.date);
    final much = count == 0 ? null : '$count ${count == 1 ? 'change' : 'changes'}';
    final meta = when != null && much != null ? '$when · $much' : (when ?? much ?? '');
    return Stack(
      children: [
        if (!widget.last) Positioned(left: 11, top: 10, bottom: 0, width: 2, child: ColoredBox(color: c.outlineVariant)),
        Positioned(
          left: (24 - size) / 2,
          top: ring ? 7 : 10,
          width: size,
          height: size,
          child: DecoratedBox(
            decoration: BoxDecoration(shape: BoxShape.circle, color: ring ? c.surface : c.outline, border: ring ? Border.all(color: c.primary, width: 3) : null),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(left: 24, bottom: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Semantics(
                container: true,
                button: true,
                label: 'Version ${notes.version}${ring ? (widget.isNew ? ', new' : ', installed') : ''}${meta.isEmpty ? '' : ', $meta'}${_open ? ", what's new shown" : ", tap for what's new"}',
                excludeSemantics: true,
                onTap: _anything ? () => setState(() => _open = !_open) : null,
                child: InkWell(
                  onTap: _anything ? () => setState(() => _open = !_open) : null,
                  child: Padding(
                    padding: const EdgeInsets.only(left: 12, right: 4),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Text('v${notes.version}', style: text.titleLarge!.copyWith(color: c.onSurface, fontWeight: FontWeight.bold)),
                                  if (ring) ...[
                                    const SizedBox(width: 10),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                                      decoration: BoxDecoration(color: widget.isNew ? c.primary : c.primaryContainer, borderRadius: BorderRadius.circular(16)),
                                      child: Text(widget.isNew ? 'New' : 'Installed', style: text.labelLarge!.copyWith(color: widget.isNew ? c.onPrimary : c.onPrimaryContainer)),
                                    ),
                                  ],
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(meta, style: text.bodyMedium!.copyWith(color: c.onSurfaceVariant)),
                            ],
                          ),
                        ),
                        if (_anything) ...[
                          const SizedBox(width: 8),
                          AnimatedRotation(turns: _open ? 0.5 : 0, duration: const Duration(milliseconds: 200), child: _Ic('expand', 24, c.onSurfaceVariant)),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              AnimatedSize(
                duration: const Duration(milliseconds: 200),
                alignment: Alignment.topCenter,
                curve: Curves.easeInOut,
                child: !_open
                    ? const SizedBox(width: double.infinity)
                    : Padding(
                        padding: const EdgeInsets.only(left: 12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (notes.summary.isNotEmpty) ...[
                              const SizedBox(height: 12),
                              Text(notes.summary, style: text.bodyMedium!.copyWith(color: c.onSurfaceVariant)),
                            ],
                            for (var g = 0; g < notes.notes.length; g++) _GroupCard(group: notes.notes[g], index: g),
                          ],
                        ),
                      ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// A group's card, its colours by its place: primary, tertiary, then secondary, round again.
class _GroupCard extends StatefulWidget {
  const _GroupCard({required this.group, required this.index});
  final NoteGroup group;
  final int index;

  @override
  State<_GroupCard> createState() => _GroupCardState();
}

class _GroupCardState extends State<_GroupCard> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final group = widget.group;
    final tones = [
      (c.primaryContainer, c.onPrimaryContainer, c.primary),
      (c.tertiaryContainer, c.onTertiaryContainer, c.tertiary),
      (c.secondaryContainer, c.onSecondaryContainer, c.secondary),
    ];
    final tone = tones[widget.index % tones.length];
    final shown = _all ? group.items : group.items.take(_firstItems).toList();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: ShapeDecoration(
          color: c.surfaceContainerLow,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24), side: BorderSide(color: c.outlineVariant)),
        ),
        child: AnimatedSize(
          duration: const Duration(milliseconds: 200),
          alignment: Alignment.topCenter,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                color: c.surfaceContainerHigh,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Row(
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(color: tone.$1, borderRadius: BorderRadius.circular(10)),
                      child: _Ic(_groupIcon(group.title), 20, tone.$2),
                    ),
                    const SizedBox(width: 14),
                    Expanded(child: Text(group.title, style: text.titleMedium!.copyWith(color: c.onSurface, fontWeight: FontWeight.bold))),
                    const SizedBox(width: 8),
                    Container(
                      constraints: const BoxConstraints(minWidth: 32),
                      alignment: Alignment.center,
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(color: c.surfaceContainerHighest, borderRadius: BorderRadius.circular(14)),
                      child: Text('${group.items.length}', style: text.labelLarge!.copyWith(color: c.onSurfaceVariant)),
                    ),
                  ],
                ),
              ),
              for (final it in shown) ...[
                ColoredBox(color: c.outlineVariant, child: const SizedBox(height: 1, width: double.infinity)),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 20, 14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Container(width: 8, height: 8, decoration: BoxDecoration(color: tone.$3, shape: BoxShape.circle)),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(it.title.isEmpty ? _capitalised(it.text) : it.title, style: text.titleSmall!.copyWith(color: c.onSurface)),
                            if (it.title.isNotEmpty && it.text.isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(_capitalised(it.text), style: text.bodyMedium!.copyWith(color: c.onSurfaceVariant)),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
              if (group.items.length > _firstItems && !_all)
                Semantics(
                  container: true,
                  button: true,
                  label: 'Show all (${group.items.length})',
                  excludeSemantics: true,
                  onTap: () => setState(() => _all = true),
                  child: InkWell(
                    onTap: () => setState(() => _all = true),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                      child: Row(
                        children: [
                          Text('Show all (${group.items.length})', style: text.labelLarge!.copyWith(color: c.primary)),
                          const SizedBox(width: 6),
                          _Ic('expand', 20, c.primary),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/* ---- the wavy progress bar ---- */

/// Material 3 Expressive's wavy progress, as SG Bus Timings' WavyProgressView draws it: the part done as a
/// wave in the theme's primary colour, drifting, then a gap and the rest of the way flat in its secondary
/// container colour, with a dot at the end. With no telling how far it's got, a wavy stretch sweeps across
/// instead. A 4 dp line, waves 40 dp long and 3 dp high (half as long while sweeping), flat near the start
/// and the end. With animations off it keeps still.
class WavyProgress extends StatefulWidget {
  const WavyProgress({super.key, required this.percent});

  /// From 0 to 100, or -1 while there's no telling.
  final int percent;

  @override
  State<WavyProgress> createState() => _WavyProgressState();
}

class _WavyProgressState extends State<WavyProgress> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  double _phase = 0;
  double _sweep = 0;
  double _progress = 0;
  double _target = 0;
  Duration _last = Duration.zero;

  @override
  void initState() {
    super.initState();
    _target = widget.percent < 0 ? 0 : widget.percent / 100;
    _progress = _target;
    _ticker = createTicker(_tick);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = MediaQuery.of(context).disableAnimations;
    if (still && _ticker.isActive) _ticker.stop();
    if (!still && !_ticker.isActive) _ticker.start();
  }

  @override
  void didUpdateWidget(WavyProgress old) {
    super.didUpdateWidget(old);
    if ((old.percent < 0) != (widget.percent < 0) && widget.percent >= 0) _progress = 0;
    _target = widget.percent < 0 ? 0 : widget.percent / 100;
    if (!_ticker.isActive) _progress = _target;
  }

  void _tick(Duration now) {
    final ms = now.inMilliseconds;
    setState(() {
      // How long a wave takes to drift by its own length, and the sweep to cross once.
      _phase = 2 * math.pi * (ms % 1000) / 1000;
      _sweep = (ms % 1800) / 1800;
      // A fifth of the way there every 30 ms or so, whatever the frame rate.
      final step = 1 - math.pow(0.8, (now - _last).inMilliseconds / 30);
      _progress += (_target - _progress) * math.min(1, step);
      if ((_target - _progress).abs() < 0.001) _progress = _target;
      _last = now;
    });
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = Theme.of(context).colorScheme;
    return Semantics(
      label: 'Progress',
      value: widget.percent < 0 ? null : '${widget.percent}%',
      child: SizedBox(
        height: 10,
        width: double.infinity,
        child: CustomPaint(painter: _WavyPainter(indeterminate: widget.percent < 0, progress: _progress, phase: _phase, sweep: _sweep, active: c.primary, track: c.secondaryContainer)),
      ),
    );
  }
}

class _WavyPainter extends CustomPainter {
  _WavyPainter({required this.indeterminate, required this.progress, required this.phase, required this.sweep, required this.active, required this.track});
  final bool indeterminate;
  final double progress;
  final double phase;
  final double sweep;
  final Color active;
  final Color track;

  static const double _thickness = 4;
  static const double _amplitude = 3;
  static const double _wavelength = 40;
  static const double _gap = 4;

  Paint _stroke(Color colour) => Paint()
    ..color = colour
    ..style = PaintingStyle.stroke
    ..strokeWidth = _thickness
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round;

  void _wave(Canvas canvas, double from, double to, double cy, double amplitude, double wavelength, Paint paint) {
    final path = Path();
    final step = math.max(1.0, wavelength / 24);
    for (var x = from;; x = math.min(to, x + step)) {
      final y = cy + amplitude * math.sin(2 * math.pi * x / wavelength - phase);
      if (x == from) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
      if (x >= to) break;
    }
    canvas.drawPath(path, paint);
  }

  @override
  void paint(Canvas canvas, Size size) {
    const half = _thickness / 2;
    final left = half;
    final right = size.width - half;
    final cy = size.height / 2;
    if (right <= left) return;
    final width = right - left;
    final activePaint = _stroke(active);
    final trackPaint = _stroke(track);

    if (indeterminate) {
      // A stretch 40% as long as the bar, its front easing in from the left and out past the right, with
      // the track either side of it.
      final eased = 0.5 - math.cos(math.pi * sweep) / 2;
      final head = left + (width * 1.4) * eased;
      final tail = head - width * 0.4;
      final from = math.max(left, tail);
      final to = math.min(right, head);
      if (to > from) _wave(canvas, from, to, cy, _amplitude, _wavelength / 2, activePaint);
      if (from - _gap - _thickness > left) canvas.drawLine(Offset(left, cy), Offset(from - _gap - _thickness, cy), trackPaint);
      if (to + _gap + _thickness < right) canvas.drawLine(Offset(to + _gap + _thickness, cy), Offset(right, cy), trackPaint);
      return;
    }

    final end = left + width * progress;
    // Flat at the very start and as it finishes, as Material's does.
    final amplitude = _amplitude * math.min(progress / 0.1, (1 - progress) / 0.05).clamp(0.0, 1.0);
    if (end > left) _wave(canvas, left, end, cy, amplitude, _wavelength, activePaint);
    final trackFrom = progress > 0 ? end + _gap + _thickness : left;
    if (trackFrom < right) canvas.drawLine(Offset(trackFrom, cy), Offset(right, cy), trackPaint);
    // The stop dot at the end, till the wave reaches it.
    if (progress < 1) canvas.drawCircle(Offset(right, cy), half, Paint()..color = active);
  }

  @override
  bool shouldRepaint(_WavyPainter old) => true;
}

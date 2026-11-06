// What a browser can't show: the phone's own colours and font reaching the theme, and the parts with no
// screen of their own.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uwumaps/core/format.dart';
import 'package:uwumaps/core/models.dart';
import 'package:uwumaps/core/prefs.dart';
import 'package:uwumaps/nearby/binarypack.dart';
import 'package:uwumaps/share/links.dart';
import 'package:uwumaps/theme/theme_controller.dart';
import 'package:uwumaps/theme/tokens.dart';
import 'package:uwumaps/update/updater.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('theme', () {
    final phoneLight = ColorScheme.fromSeed(seedColor: const Color(0xFFB00020));
    final phoneDark = ColorScheme.fromSeed(seedColor: const Color(0xFFB00020), brightness: Brightness.dark);

    Future<ThemeController> controller([Map<String, Object> saved = const {}]) async {
      SharedPreferences.setMockInitialValues(saved);
      await Prefs.init();
      final c = ThemeController();
      await c.init();
      return c;
    }

    test('Material You is on by default, with the phone\'s colours and font', () async {
      final c = await controller();
      c.deviceFont = 'Phone Sans';
      expect(c.materialYou, isTrue);
      final theme = c.build(phoneLight, phoneDark);
      expect(theme.extension<Tokens>()!.material, isTrue);
      expect(theme.textTheme.bodyMedium!.fontFamily, 'Phone Sans');
      // Harmonised, so only the error colour may move: the primary is the phone's.
      expect(theme.colorScheme.primary, phoneLight.primary);
    });

    test('with no named font it uses the phone\'s default, and never Roboto or Jua', () async {
      final c = await controller();
      final family = c.build(phoneLight, phoneDark).textTheme.bodyMedium!.fontFamily;
      expect(family, 'sans-serif');
    });

    test('before Android 12 it falls back to the seed', () async {
      final c = await controller();
      final theme = c.build(null, null);
      expect(theme.extension<Tokens>()!.material, isTrue);
      expect(theme.colorScheme.primary, isNot(phoneLight.primary));
    });

    test('its colours and font can each be turned off', () async {
      final c = await controller({'uwumaps.phoneColours': false, 'uwumaps.phoneFont': false});
      final theme = c.build(phoneLight, phoneDark);
      expect(theme.colorScheme.primary, isNot(phoneLight.primary));
      expect(theme.textTheme.bodyMedium!.fontFamily, 'Jua');
    });

    test('off, it is the uwuapps theme, in Jua, whatever the phone says', () async {
      final c = await controller({'uwumaps.materialYou': false});
      final theme = c.build(phoneLight, phoneDark);
      final t = theme.extension<Tokens>()!;
      expect(t.material, isFalse);
      expect(theme.textTheme.bodyMedium!.fontFamily, 'Jua');
      expect(c.isDark, isFalse);
      expect(t.ink, const Color(0xFF121815));
      expect(t.brandInk, const Color(0xFF1F6B3D));
      expect(t.onBrand, const Color(0xFF121815));
    });

    test('the uwuapps tokens are the theme spec\'s, in dark too', () async {
      final t = Tokens.uwu(const Color(0xFFCCFFCC), dark: true);
      expect(t.bg, const Color(0xFF0C100E));
      expect(t.ink, const Color(0xFFEEF2EF));
      expect(t.brandInk, const Color(0xFFBFF5CF));
      // color-mix(in srgb, #ccffcc 10%, #0c100e)
      expect((t.page.r * 255).round(), 31);
      expect((t.page.g * 255).round(), 40);
      expect((t.page.b * 255).round(), 33);
    });

    test('time-based keeps the preference and resolves by the clock', () async {
      final c = await controller({'uwumaps.materialYou': false, 'uwumaps.mode': 'time'});
      expect(c.modePreference, 'time');
      expect(c.isDark, !isDaylightHours(DateTime.now()));
      expect(isDaylightHours(DateTime(2026, 1, 1, 8, 59)), isFalse);
      expect(isDaylightHours(DateTime(2026, 1, 1, 9)), isTrue);
      expect(isDaylightHours(DateTime(2026, 1, 1, 17, 59)), isTrue);
      expect(isDaylightHours(DateTime(2026, 1, 1, 18)), isFalse);
    });

    test('colour-mix keeps translucency, as CSS does', () {
      final m = mix(const Color(0xFF121815), 0.7, transparentInk);
      expect(m.a, closeTo(0.7, 0.001));
      expect(m.r, closeTo(0x12 / 255, 0.001));
    });
  });

  group('formats, as the website writes them', () {
    test('distances, times and sizes', () {
      expect(formatDistance(3), '10 m');
      expect(formatDistance(949), '950 m');
      expect(formatDistance(950), '0.9 km'); // 0.95 is a little under, in binary: the website says the same.
      expect(formatDistance(1500), '1.5 km');
      expect(formatDistance(123456), '123 km');
      expect(formatDuration(10), '1 min');
      expect(formatDuration(3600), '1 h');
      expect(formatDuration(3660), '1 h 1 min');
      expect(formatBytes(1500000000), '1.5 GB');
    });

    test('a place id reads the same as the website\'s', () {
      expect(coordText(103.85), '103.85');
      expect(coordText(1), '1');
      expect(coordText(1.123456), '1.12346');
    });
  });

  group('links', () {
    test('a self link round trips, and matches the website\'s encoding', () {
      final payload = <String, Object?>{'kind': 'place', 'data': placeOf(const _At(1.3, 103.8), 'Café 東京')};
      final link = selfLink(payload);
      expect(link.contains('='), isTrue);
      expect(link.endsWith('='), isFalse);
      final target = parseLink(Uri.parse(link));
      expect(target, isA<SelfLink>());
      expect(((target! as SelfLink).payload['data'] as Map)['label'], 'Café 東京');
    });

    test('nonsense in a link is refused', () {
      String encode(Object v) => base64Url.encode(utf8.encode(jsonEncode(v))).replaceAll('=', '');
      expect(parseLink(Uri.parse('https://maps.uwuapps.org/#s=${encode({'kind': 'place', 'data': {'label': 'x', 'lat': 999, 'lng': 0}})}')), isNull);
      expect(parseLink(Uri.parse('https://maps.uwuapps.org/#s=${encode({'kind': 'virus', 'data': {}})}')), isNull);
      expect(parseLink(Uri.parse('https://maps.uwuapps.org/#s=%%%')), isNull);
      expect(parseLink(Uri.parse('https://example.com/go/abcde12345')), isNull);
    });

    test('short links, join links and the uwu scheme', () {
      expect(parseLink(Uri.parse('https://maps.uwuapps.org/go/abcde12345')), isA<ShortLink>());
      expect(parseLink(Uri.parse('https://maps.uwuapps.org/#share/abcde12345')), isA<ShortLink>());
      expect(parseLink(Uri.parse('uwu://uwumaps/#join=BCDFGH')), isA<JoinLink>());
      expect(parseLink(Uri.parse('uwu://sgbus/go/abcde12345')), isNull);
    });
  });

  group('BinaryPack', () {
    test('round trips every kind of value', () {
      final value = <String, Object?>{
        'a': 1,
        'neg': -5,
        'big': 70000,
        'negbig': -70000,
        'f': 103.8565,
        's': 'hello',
        'long': 'x' * 300,
        'n': null,
        't': true,
        'list': [1, 'two', 3.5],
        'raw': Uint8List.fromList([1, 2, 3]),
        'nested': {'k': 'v'},
      };
      final back = unpackMessage(packMessage(value))! as Map<String, Object?>;
      expect(back['a'], 1);
      expect(back['neg'], -5);
      expect(back['big'], 70000);
      expect(back['negbig'], -70000);
      expect(back['f'], 103.8565);
      expect(back['long'], 'x' * 300);
      expect(back['n'], isNull);
      expect(back['t'], true);
      expect(back['list'], [1, 'two', 3.5]);
      expect(back['raw'], [1, 2, 3]);
      expect(back['nested'], {'k': 'v'});
    });

    test('reads the bytes the website\'s PeerJS sends for {type:"hello",v:1}', () {
      // binarypack.pack({type:"hello",v:1}) from the vendored library.
      final bytes = Uint8List.fromList([0x82, 0xb4, ...utf8.encode('type'), 0xb5, ...utf8.encode('hello'), 0xb1, ...utf8.encode('v'), 0x01]);
      expect(unpackMessage(bytes), {'type': 'hello', 'v': 1});
      expect(packMessage({'type': 'hello', 'v': 1}), bytes);
    });

    test('a long message goes in chunks and comes back whole', () {
      final message = {'type': 'state', 'payload': 'y' * 40000};
      final frames = framesFor(message);
      expect(frames.length, greaterThan(1));
      final chunks = Chunks();
      Uint8List? whole;
      for (final f in frames) {
        whole = chunks.add((unpackMessage(f)! as Map).cast<String, Object?>());
      }
      expect(unpackMessage(whole!), message);
    });
  });

  group('releases', () {
    test('versions compare number by number', () {
      expect(isNewer('1.10.0', '1.9.0'), isTrue);
      expect(isNewer('1.0.0', '1.0.0'), isFalse);
      expect(isNewer('1.0', '1.0.0'), isFalse);
      expect(isNewer('2', '1.9.9'), isTrue);
    });

    Map<String, dynamic> release(String tag, {bool draft = false, bool pre = false, String state = 'uploaded', String name = 'uwumaps-1.1.0.apk'}) => {
          'tag_name': tag,
          'draft': draft,
          'prerelease': pre,
          'html_url': 'https://github.com/x',
          'published_at': '2026-11-01T00:00:00Z',
          'body': '',
          'assets': [
            {'name': name, 'state': state, 'size': 10, 'browser_download_url': 'https://github.com/x/$name', 'digest': 'sha256:${'a' * 64}'},
          ],
        };

    test('only what a phone can install is offered', () {
      expect(asRelease(release('android-v1.1.0'))!.version, '1.1.0');
      expect(asRelease(release('android-v1.1.0'))!.sha256, 'a' * 64);
      expect(asRelease(release('offline-packs')), isNull);
      expect(asRelease(release('android-v1.1.0', draft: true)), isNull);
      expect(asRelease(release('android-v1.1.0', pre: true)), isNull);
      expect(asRelease(release('android-v1.1.0', state: 'starter')), isNull);
      expect(asRelease(release('android-v1.1.0', name: 'uwumaps-1.1.0-watch.apk')), isNull);
    });

    test('notes come apart as SG Bus Timings\' do', () {
      const body = '''The first **uwuMaps** app for Android, with `offline` maps.

## Download

| Device | File |

## What's new

### Android app
- **Material You**: your phone's colours and font.
- **Updates**: from GitHub,
  with a checksum.
- A plain item

### Everywhere
- **Offline maps.** No connection needed.

## What's fixed
- **Not this**: it's another section.
''';
      final n = notesOf(body);
      expect(n.summary, 'The first uwuMaps app for Android, with offline maps.');
      expect(n.notes.map((g) => g.title), ['Android app', 'Everywhere']);
      expect(n.notes[0].items[0].title, 'Material You');
      expect(n.notes[0].items[0].text, "your phone's colours and font.");
      expect(n.notes[0].items[1].text, 'from GitHub, with a checksum.');
      expect(n.notes[0].items[2].title, '');
      expect(n.notes[0].items[2].text, 'A plain item');
      expect(n.notes[1].items[0].title, 'Offline maps');
      expect(n.notes[1].items[0].text, 'No connection needed.');
    });
  });
}

class _At extends LatLon {
  const _At(super.lat, super.lon);
}

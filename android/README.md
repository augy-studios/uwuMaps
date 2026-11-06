# uwuMaps for Android

A native Android app in [Flutter](https://flutter.dev): Dart for everything `main-site/js/` does on the website,
and [MapLibre Native](https://maplibre.org) for the map. No WebView. Shared as a signed APK from GitHub Releases
(`release/README.md`), not through Google Play.

`docs/android-app-spec.md` describes an app wrapping the site in Capacitor. This follows it for signing, releases,
permissions, icons, the updater and the look of things, and departs from it on purpose in one way: **the site isn't
inside the app**. A site deploy doesn't reach the app, so a change to `main-site/js/` needs the same change here and a
new APK.

## What's what

| Folder | What | The website's |
|---|---|---|
| `lib/map/` | The style, the map, and a small server on 127.0.0.1 that hands MapLibre its tiles, icons and fonts | `js/map.js`, `js/buildings.js` |
| `lib/packs/` | Offline packs, read straight from the GitHub release with range requests, including for walking in Singapore with no saved map (`pack_published.dart`) | `js/packs.js`, `js/pack-read.js`, `js/pack-list.js` |
| `lib/routing/` | The offline router, in its own isolate | `js/route-core.js`, `js/route-client.js` |
| `lib/search/` | Search: saved, transport, packs, then Photon | `js/search.js` |
| `lib/transit/` | Public transport, live vehicles, a station's doors | `js/transit.js`, `js/mrt-doors.js` |
| `lib/places/` | Saved places and sync | `js/places.js` |
| `lib/nav/` | Planning a route, and following it | `js/directions.js`, `js/nav.js` |
| `lib/share/` | Share links, live ETAs, opening links | `js/share.js` |
| `lib/nearby/` | PeerJS's protocol and BinaryPack in Dart, over flutter_webrtc | `js/p2p.js`, `js/nearby.js` |
| `lib/theme/` | Material You and the uwuapps theme | `js/theme.js`, `js/icons.js` |
| `lib/ui/` | The screen, the panels, the sheets and the Edge Tray | `index.html`, `style.css`, `js/tray.js` |
| `lib/update/` | The updater, a port of SG Bus Timings' `UpdateActivity.java` to the same measures | |
| `android/` | The Gradle project, and `MainActivity.kt` for what Dart can't do itself | |

**What goes to the site, and what doesn't.** A web page is held back by CORS and Vercel's 4.5 MB limit. An app isn't, so
packs come straight from the `offline-packs` release, and Overture's catalogue, OpenFreeMap and the app's own releases
from their sources. Only what really runs on a server uses `maps.uwuapps.org`: short share links, ETAs, sync, and
Malaysia's live feed.

## The two looks

**Material You** is on by default, and only exists here: the website is always uwuapps. It takes the wallpaper's colours
on Android 12 and later (a seed colour before that) and the phone's font, and uses Material's own widgets. **Settings**
turns it off, or turns off the colours or the font alone. Its mode defaults to following the phone.

**uwuapps** is `docs/uwuapps-theme.md`: glass, Jua, seven brand colours, and light, dark or time-based, defaulting to light
whatever the phone says. Every widget reads colours from `Tokens` (`lib/theme/tokens.dart`), so both looks and all 14
combinations come from one set of names. `lib/ui/widgets.dart` draws each building block both ways.

The **Edge Tray** (`docs/edge-tray-spec.md`) is in both. The **updater** is always Material 3 in the phone's colours, light
or dark as the phone is, as SG Bus Timings' is, whichever look the app is in.

## Permissions

Each is asked for at the moment it's used, never at launch.

| Permission | When |
|---|---|
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | **My location**, a route from where you are, or navigation |
| `CAMERA` | **Scan a code** |
| `REQUEST_INSTALL_PACKAGES` | The first update. Not allowed on Google Play: drop it for a Play build. |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Never asked |

flutter_webrtc's microphone, Bluetooth and overlay permissions are removed in the manifest, as Nearby only sends data.

## Building

```powershell
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

It copies the map's assets and the transport data from `main-site/` (`tool/sync-assets.mjs`), builds, signs, checks the
signature against `main-site/.well-known/assetlinks.json`, and copies the APK to `release/<version>/`. The first run makes
the signing key and writes its fingerprint into `assetlinks.json`.

`android.keystore` and `keystore.properties` are never committed. **Back them up**: losing them means no installed phone
can ever update.

To work on it: `node tool/sync-assets.mjs`, then `flutter run`. The icons come from `tool/make-icons.mjs`.

## Testing

```sh
flutter test                                    # Router, packs, theme, links, BinaryPack, release notes
node ../tests/flutter/compare-router.mjs        # The Dart ports' answers against the website's JavaScript
node ../tests/flutter/build-web.mjs             # The same Dart, built for the browser
cd ../tests/flutter
npx playwright test --config playwright.config.mjs
```

Playwright runs the app's real Dart in Chromium, against the fixture pack and the real API routes
(`tests/flutter/serve.mjs`). Flutter draws on a canvas, so tests find controls through the semantics tree, what TalkBack
reads, and ask for state through `window.__uwu`, which only exists in that build. Its map is MapLibre GL JS rather than
MapLibre Native, and it has no wallpaper or installer, so check those on a phone or emulator:

- [ ] The map draws, with 3D buildings, online and from a saved pack in airplane mode
- [ ] Material You takes the wallpaper's colours and the phone's font, and follows dark mode
- [ ] Back closes what's open, then leaves without closing
- [ ] **Check for updates** says newest; with a newer release, the bar offers it and it installs
- [ ] A location permission refused, and refused for good, says what to do
- [ ] A `https://maps.uwuapps.org/go/...` link and a `uwu://maps/` link open in the app

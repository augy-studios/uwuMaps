// Where the app reaches. A native app has no same-origin or CORS rules, so offline packs, Overture's
// catalogue and the app's own releases are read straight from their sources. Only what truly runs on
// a server (share links, saved places sync and the Malaysian live feed) goes to the site.
//
// The dart-defines are for the browser test build, which runs against tests' stand-in server.

const String siteOrigin = String.fromEnvironment('UWU_SITE', defaultValue: 'https://maps.uwuapps.org');
const String apiOrigin = String.fromEnvironment('UWU_API', defaultValue: 'https://maps.uwuapps.org');
const String packsRelease = String.fromEnvironment('UWU_PACKS', defaultValue: 'https://github.com/augy-studios/uwuMaps/releases/download/offline-packs');
const String releasesApi = String.fromEnvironment('UWU_RELEASES', defaultValue: 'https://api.github.com/repos/augy-studios/uwuMaps/releases?per_page=100&page=');
const String apkPrefix = String.fromEnvironment('UWU_APK_PREFIX', defaultValue: 'https://github.com/augy-studios/uwuMaps/releases/download/');

/// The browser test build: exposes a test hook and the semantics tree.
const bool testBuild = bool.fromEnvironment('UWU_TEST');

const String userAgent = 'uwuMaps-Android/1.0 (+https://maps.uwuapps.org)';

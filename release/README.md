# Releases

The Android app built here, each version in a folder of its own:

```text
release/1.0.0/
  uwumaps-1.0.0.apk     Android     android\build-apk.ps1
```

The APKs are committed alongside the code they were built from. Nothing else belongs here: `.gitignore`
keeps out anything a tool copies in.

Share them through a **GitHub Release**, where anyone can download them from
<https://github.com/augy-studios/uwuMaps/releases>.

## Build it

In PowerShell, from the project root:

```powershell
powershell -ExecutionPolicy Bypass -File android\build-apk.ps1
```

For a new version, raise `version:` in `android/pubspec.yaml` first, both numbers: `1.0.1+2` is
versionName 1.0.1 and versionCode 2. A phone only takes a higher versionCode.

## Put it on GitHub

1. Commit and push your changes, the new APK included, so the release points at the code it was built from.
2. Open <https://github.com/augy-studios/uwuMaps/releases/new>.
3. **Choose a tag**: type a new one, such as `android-v1.0.0`, and pick **Create new tag: android-v1.0.0 on
   publish**. Leave the target as `main`. Keep to `android-v<version>`: it's how the app's updater finds its
   releases.
4. **Release title**: `uwuMaps 1.0.0`.
5. **Describe this release**: paste `announcement/release-notes-<version>.md`. The app's updater reads these
   notes for its changelog, so keep to the format: the first paragraph is the summary, and under `## What's
   new` each `###` heading is a card of `- **Title**: text` items.
6. Drag in the APK from `release\<version>\`, into the box that says **Attach binaries by dropping them here
   or selecting them**. Wait for it to finish uploading.
7. Tick **Set as the latest release**, then **Publish release**.
8. Post `announcement/announcement-<version>.md`, from a code block so the emoji and line breaks survive.

`https://github.com/augy-studios/uwuMaps/releases/latest` always points at the newest one: a good link to
share. The `offline-packs` release is a pre-release, so it's never that one, and the updater skips it.

## How phones hear about it

The app reads the releases straight from GitHub when it opens, and again on coming back after an hour, and
offers a newer version in the bar at the top. The bar's **Update** downloads the APK in the app, checks it
against GitHub's checksum and hands it to Android's installer (`android/lib/update/update_page.dart`). It
skips drafts, pre-releases, tags that don't start `android-v`, and releases whose APK hasn't finished uploading.

## Before you share it

- **Deploy the site first**, with `main-site/.well-known/assetlinks.json` naming the app's key, or links open
  in the browser rather than the app.
- **The repository has to be public** for others to download it.
- **Never upload `android.keystore` or `keystore.properties`.** Only the APK.
- **Back up both of those somewhere safe.** Without them, no installed phone can ever update: everybody would
  have to uninstall and reinstall, and `assetlinks.json` would change.
- **Google's developer verification**: register `org.uwuapps.uwumaps` with the key's SHA-256 on the Android
  Developer Console, or Play Protect warns and, as it rolls out, blocks installs.

## If something goes wrong

| What happens | What to do |
|---|---|
| "App not installed" on the phone | A copy signed with a different key is installed, such as a debug build. Uninstall uwuMaps, then install again. |
| "App not installed as package appears to be invalid" | The download didn't finish. Download it again. |
| Play Protect asks to scan the app | **More details** > **Install without scanning**, and see "Google's developer verification" above. |
| On a Samsung phone, an update stops with "Update blocked" | Samsung's Auto Blocker. The page says how to turn it off for the update. |
| You uploaded the wrong file | On the release, **Edit**, delete the file with the bin icon, attach the right one, **Update release**. The app checks the file is newer and matches GitHub's checksum, so phones won't install a mismatch. |
| No update bar in the app | The tag doesn't start `android-v`, or the release is a draft or pre-release. `https://api.github.com/repos/augy-studios/uwuMaps/releases` shows what phones see. |

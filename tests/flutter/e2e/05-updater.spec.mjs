import { test, expect } from '@playwright/test';
import { button, openApp, said, state } from './helpers.mjs';

// The updater page, against a stand-in for GitHub's releases, in each of its states. The screenshots are
// to set beside SG Bus Timings' docs-site/public/screenshots/web/android-update*.png.

const notes = (changes) => `Colourful 3D maps in your pocket, and directions that work with no connection.

## Download

| Device | File |
|---|---|
| Android 7.0 or newer | \`uwumaps-1.1.0.apk\` |

## What's new

### Android app
- **Material You**: the whole app in your phone's colours and font, light or dark as your phone is.

### Maps
${Array.from({ length: changes }, (_, i) => `- **Change ${i + 1}**: something that got better, in a sentence or two, for you.`).join('\n')}

### Directions
- **Faster routes**: long drives come back sooner.

## What's fixed
- **Not in the changelog**: this section isn't shown.
`;

function release(version, sha, { body = notes(2), daysAgo = 1 } = {}) {
  return {
    tag_name: `android-v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/augy-studios/uwuMaps/releases/tag/android-v${version}`,
    published_at: new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/\.\d+Z/, 'Z'),
    body,
    assets: [{ name: `uwumaps-${version}.apk`, state: 'uploaded', size: 2500000, browser_download_url: `http://127.0.0.1:4180/__apk/uwumaps-${version}.apk`, digest: `sha256:${sha}` }],
  };
}

async function setReleases(request, list) {
  await request.post('http://127.0.0.1:4180/__test/releases', { data: list });
}

const packRelease = { tag_name: 'offline-packs', draft: false, prerelease: true, assets: [], body: '' };

test.beforeEach(async ({ request }) => {
  await setReleases(request, []);
});

test('with nothing newer: You\'re up to date, the installed release open, GitHub and Close', async ({ page, request }, info) => {
  await setReleases(request, [packRelease, release('1.0.0', 'a'.repeat(64), { daysAgo: 3 }), release('0.9.0', 'b'.repeat(64), { daysAgo: 20 })]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);
  await button(page, 'Check for updates').click();
  await expect(page.getByRole('heading', { name: "You're up to date" })).toBeVisible();
  await expect(said(page, 'uwuMaps · v1.0.0')).toBeVisible();
  await expect(button(page, /^Version 1\.0\.0, installed, 3 days ago · 4 changes, what's new shown$/, false)).toBeVisible();
  await expect(said(page, 'Earlier releases')).toBeVisible();
  await expect(button(page, 'GitHub')).toBeVisible();
  await expect(button(page, 'Close')).toBeVisible();
  // What's in "What's fixed" and "Download" isn't a change.
  await expect(page.getByText('Not in the changelog')).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('up-to-date-dark.png') });
  await button(page, 'Close').click();
  await expect(button(page, 'Check for updates')).toBeVisible();
});

test('with one newer: the bar offers it, the page asks, and it downloads with the wave', async ({ page, request }, info) => {
  const { sha256 } = await (await request.get('http://127.0.0.1:4180/__test/apk')).json();
  await setReleases(request, [release('1.1.0', sha256, { body: notes(5) }), release('1.0.0', 'a'.repeat(64), { daysAgo: 8 })]);
  await openApp(page);
  await expect.poll(async () => (await state(page)).updateAvailable, { timeout: 15000 }).toBe('1.1.0');
  await expect(said(page, 'Version 1.1.0 of the uwuMaps app is out.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('bar.png') });
  // The tray moves down out of the bar's way, and Not now hides it for now.
  await button(page, 'Not now').click();
  await expect(page.getByText('Version 1.1.0 of the uwuMaps app is out.')).toHaveCount(0);

  await button(page, 'Check for updates').click();
  await expect(page.getByRole('heading', { name: 'Update available' })).toBeVisible();
  await expect(button(page, /^Version 1\.1\.0, new, Yesterday · 7 changes/, false)).toBeVisible();
  await expect(said(page, 'Colourful 3D maps in your pocket')).toBeVisible();
  await expect(button(page, 'Update to 1.1.0')).toBeVisible();
  await expect(button(page, 'Not now')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('available-light.png') });

  // A group's first four, the rest under Show all.
  await expect(button(page, 'Show all (5)')).toBeVisible();
  await button(page, 'Show all (5)').click();
  await expect(said(page, 'Change 5')).toBeVisible();
  await expect(button(page, 'Show all (5)')).toHaveCount(0);

  // A release opens and closes.
  await button(page, /^Version 1\.1\.0/, false).click();
  await expect(page.getByText('Colourful 3D maps in your pocket')).toHaveCount(0);
  await button(page, /^Version 1\.1\.0/, false).click();
  await expect(said(page, 'Colourful 3D maps in your pocket')).toBeVisible();

  // Slowly, to see it part way.
  await page.route('**/__apk/**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await button(page, 'Update to 1.1.0').click();
  await expect(page.getByRole('heading', { name: 'Updating' })).toBeVisible();
  await expect(said(page, /Downloading version 1\.1\.0…/)).toBeVisible();
  await expect(button(page, 'Cancel')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: info.outputPath('downloading.png') });
  // Through to handing it to the installer, the checksum having matched.
  await expect(said(page, "Opening Android's installer…")).toBeVisible({ timeout: 20000 });
});

test('the update bar\'s Update goes straight to downloading', async ({ page, request }) => {
  const { sha256 } = await (await request.get('http://127.0.0.1:4180/__test/apk')).json();
  await setReleases(request, [release('1.1.0', sha256)]);
  await openApp(page);
  await expect(said(page, 'Version 1.1.0 of the uwuMaps app is out.')).toBeVisible();
  await button(page, 'Update').click();
  await expect(said(page, /Looking for the update…|Downloading version 1\.1\.0…|Opening Android's installer…/)).toBeVisible();
  await expect(said(page, "Opening Android's installer…")).toBeVisible({ timeout: 20000 });
});

test('a download that doesn\'t match its checksum is refused, and Try again goes again', async ({ page, request }, info) => {
  await setReleases(request, [release('1.1.0', 'c'.repeat(64))]);
  await openApp(page);
  await button(page, 'Check for updates').click();
  await button(page, 'Update to 1.1.0').click();
  await expect(page.getByRole('heading', { name: "Couldn't update" })).toBeVisible();
  await expect(said(page, "The download doesn't match the file on GitHub. Try again.")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('problem.png') });
  await expect(button(page, 'Try again')).toBeVisible();
  await expect(button(page, 'Close')).toBeVisible();
});

test('an APK from anywhere but this repository isn\'t downloaded', async ({ page, request }) => {
  const r = release('1.1.0', 'c'.repeat(64));
  r.assets[0].browser_download_url = 'https://example.com/evil.apk';
  await setReleases(request, [r]);
  await openApp(page);
  await button(page, 'Check for updates').click();
  await expect(said(page, "The update isn't on uwuMaps's GitHub page, so it wasn't downloaded.")).toBeVisible();
});

test('GitHub being unreachable is said plainly', async ({ page }) => {
  await page.route('**/__releases**', (route) => route.fulfill({ status: 403, body: 'rate limited' }));
  await openApp(page);
  await button(page, 'Check for updates').click();
  await expect(said(page, "Couldn't find out what the newest version is. Try again later.")).toBeVisible();
});

test('it follows the phone\'s light or dark, not the app\'s look', async ({ page, request }, info) => {
  await setReleases(request, [release('1.0.0', 'a'.repeat(64))]);
  await openApp(page, { settings: { 'uwumaps.materialYou': false } });
  expect((await state(page)).tokensMaterial).toBe(false);
  await button(page, 'Check for updates').click();
  await expect(page.getByRole('heading', { name: "You're up to date" })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('from-uwu-theme.png') });
});

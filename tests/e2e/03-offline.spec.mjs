// Offline, for real: a pack downloaded through the API, then the network cut, then everything the app
// promises tried with none. The pack is real Singapore data (tests/build-fixture.mjs).
import { expect, test } from '@playwright/test';
import { collectErrors, downloadSingapore, jumpTo, openApp, quietThirdParties, rendered, waitForMapIdle, waitForServiceWorker } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let context;
let page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    geolocation: { latitude: 1.3048, longitude: 103.8318 },
    permissions: ['geolocation'],
  });
  await quietThirdParties(context);
  page = await context.newPage();
});

test.afterAll(async () => context.close());

test('a first install asks for nothing, and the worker takes over on the next load', async () => {
  await openApp(page);
  await expect(page.locator('.update-notice')).toHaveCount(0);
  await waitForServiceWorker(page);
  await expect(page.locator('.update-notice')).toHaveCount(0);
});

// What an installed app does on every launch. A redirected page in the shell fails all of these with
// ERR_FAILED, and only for somebody the worker already controls.
test('the worker answers a launch, a reload and a share link with the page, none of it redirected', async () => {
  const shell = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.startsWith('uwumaps-shell-'));
    const cache = await caches.open(name);
    const all = await cache.keys();
    const responses = await Promise.all(all.map((k) => cache.match(k)));
    return { count: all.length, redirected: responses.filter((r) => r.redirected).map((r) => r.url), index: Boolean(await cache.match('/index.html')) };
  });
  expect(shell.count).toBeGreaterThan(30);
  expect(shell.redirected).toEqual([]);
  expect(shell.index).toBe(false);
  for (const path of ['/', '/?source=pwa', '/go/abcd1234']) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(200);
    expect(res.fromServiceWorker(), path).toBe(true);
    await page.waitForFunction(() => document.querySelector('#map canvas'));
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  // Not one of the app's addresses: the network's to answer, as a 404 rather than the app.
  const other = await page.goto('/no-such-page');
  expect(other.status()).toBe(404);
  await page.goto('/');
  await page.waitForFunction(() => document.querySelector('#map canvas'));
});

test('the catalogue lists regions, and says which are not built yet', async () => {
  await page.click('#packsBtn');
  await expect(page.locator('#packsList .pack')).toHaveCount(25);
  await expect(page.locator('[data-pack="japan"] .pack-sub')).toHaveText('Not ready yet');
  await expect(page.locator('[data-pack="singapore"]').getByRole('button', { name: 'Download' })).toBeVisible();
  await page.click('[data-close-modal="packsModal"]');
});

test('a pack downloads through the API into the cache, in pieces', async () => {
  const pieces = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/mappack?id=')) pieces.push(r.status());
  });
  await downloadSingapore(page);
  expect(pieces.length).toBeGreaterThan(2);
  expect(new Set(pieces)).toEqual(new Set([200]));
  const meta = await page.evaluate(async () => {
    const { readPackMeta } = await import('/js/pack-read.js');
    return readPackMeta('singapore');
  });
  expect(meta.complete).toBe(true);
  expect(meta.bounds).toEqual([103.59, 1.15, 104.1, 1.48]);
});

test('with no connection: the app still opens, says so, and draws the map and buildings', async () => {
  const errors = collectErrors(page);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await waitForMapIdle(page);
  await expect(page.locator('.update-notice')).toContainText("You're offline");

  await jumpTo(page, { center: [103.8565, 1.2835], zoom: 15.3, pitch: 58, bearing: -20 });
  const fromBase = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    const ids = map.getStyle().layers.filter((l) => l.source === 'openmaptiles').map((l) => l.id);
    return map.queryRenderedFeatures({ layers: ids }).length;
  });
  expect(fromBase).toBeGreaterThan(50);
  await expect.poll(() => rendered(page, ['buildings-walls', 'parts-walls']), { timeout: 60000 }).toBeGreaterThan(50);
  await page.screenshot({ path: 'test-results/offline-3d.png' });
  expect(errors).toEqual([]);
});

test('with no connection: the slimmed buildings keep their colours and heights', async () => {
  const sample = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const features = getMap().queryRenderedFeatures({ layers: ['buildings-walls', 'parts-walls'] });
    return {
      total: features.length,
      colours: features.filter((f) => f.properties.facade_color || f.properties.roof_color).length,
      heights: features.filter((f) => Number(f.properties.height) > 0).length,
      dropped: features.filter((f) => f.properties.sources || f.properties.version != null || f.properties.id).length,
    };
  });
  expect(sample.colours, JSON.stringify(sample)).toBeGreaterThan(0);
  expect(sample.heights, JSON.stringify(sample)).toBeGreaterThan(0);
  expect(sample.dropped, JSON.stringify(sample)).toBe(0);
});

test('with no connection: public transport layers still draw', async () => {
  await jumpTo(page, { center: [103.8519, 1.2835], zoom: 16.5, pitch: 0, bearing: 0 });
  await expect.poll(() => rendered(page, ['sg-stations']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['sg-stops']), { timeout: 30000 }).toBeGreaterThan(0);
  await page.click('#layersBtn');
  await expect(page.locator('#layersLiveNote')).toHaveText('Live vehicles need a connection.');
  await page.click('[data-close-modal="layersModal"]');
});

test('with no connection: search finds places, streets, stations and bus stops', async () => {
  const search = async (q, expected) => {
    await page.fill('#searchInput', q);
    await page.press('#searchInput', 'Enter');
    await expect(page.locator('#searchResults')).toContainText(expected, { timeout: 30000 });
  };
  await search('Orchard Road', 'Orchard Road');
  await search('Bishan', 'Bishan');
  await search('marina bay sands', 'Marina Bay Sands');
  await search('01012', 'Hotel Grand Pacific');
  // Words in a different order, and letters in a different case, still find it.
  await search('sands MARINA', 'Marina Bay Sands');

  await page.fill('#searchInput', 'Raffles Place');
  await page.press('#searchInput', 'Enter');
  await page.locator('#searchResults button').first().click();
  await expect(page.locator('#placeCard')).not.toHaveClass(/hidden/);
  await expect(page.locator('#placeName')).toContainText('Raffles Place');
  await page.click('#placeClose');
});

for (const [mode, label] of [['foot', 'Walk'], ['bike', 'Cycle'], ['car', 'Drive']]) {
  test(`with no connection: directions by ${mode} come from the pack, with street names`, async () => {
    await page.evaluate(async (m) => {
      const { openDirections } = await import('/js/directions.js');
      openDirections({ from: { name: 'Orchard', lat: 1.3048, lon: 103.8318 }, to: { name: 'Marina', lat: 1.2834, lon: 103.8607 }, mode: m });
    }, mode);
    await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
    await expect(page.locator(`#travelModes [data-travel="${mode}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`#travelModes [data-travel="${mode}"]`)).toContainText(label);
    const steps = await page.locator('#routeSteps li').allTextContents();
    expect(steps.length).toBeGreaterThan(3);
    expect(steps[steps.length - 1]).toContain('You have arrived');
    expect(steps.join(' ')).toMatch(/(Road|Street|Avenue|Boulevard|Drive|Way)/);
    await expect(page.locator('#routeTime')).toHaveText(/\d+ (min|h)/);
    await page.click('#directionsClose');
  });
}

test('with no connection: a place outside any saved map says what to do', async () => {
  await page.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: { name: 'Paris', lat: 48.85, lon: 2.35 }, to: { name: 'Lyon', lat: 45.76, lon: 4.83 }, mode: 'car' });
  });
  await expect(page.locator('#routeStatus')).toContainText('Save this area in Offline maps');
  await page.click('#directionsClose');
});

test('with no connection: a shared short link says it needs a connection, rather than failing to load', async () => {
  await page.goto('/go/abcdefghij');
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await expect(page.locator('#toast')).toContainText('needs a connection');
});

test('with no connection: a link holding its own place opens, and a QR code can be made', async () => {
  const payload = { kind: 'place', data: { label: 'Merlion', lat: 1.2868, lng: 103.8545 } };
  const hash = await page.evaluate((p) => btoa(JSON.stringify(p)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), payload);
  await page.goto(`/#s=${hash}`);
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await expect(page.locator('#placeName')).toHaveText('Merlion', { timeout: 30000 });

  await page.click('#placeShare');
  await expect(page.locator('#shareNote')).toContainText("You're offline");
  expect(await page.inputValue('#shareLink')).toContain('/#s=');
  await page.click('#shareNearby');
  await expect(page.locator('#nearbyBody .qr-wrap svg')).toBeVisible();
  await page.click('#nearbyStart');
  await expect(page.locator('#nearbyStatus')).toContainText('needs a connection');
  await page.click('[data-close-modal="nearbyModal"]');
});

test('with no connection: places can be saved, and stay', async () => {
  await page.click('#placeSave');
  await expect(page.locator('#placeSaveLabel')).toHaveText('Saved');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await page.click('#savedBtn');
  await expect(page.locator('#savedList .saved-open')).toContainText(['Merlion']);
  await page.click('[data-close-modal="savedModal"]');
});

test('back online: the offline bar goes, and a pack can be removed', async () => {
  await context.setOffline(false);
  await expect(page.locator('.update-notice')).toHaveCount(0);
  await page.click('#packsBtn');
  const row = page.locator('[data-pack="singapore"]');
  await expect(row.locator('.pack-sub')).toContainText('Saved');
  await row.locator('[data-pack-remove]').click();
  await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();
  expect(await page.evaluate(() => caches.has('uwumaps-pack-singapore'))).toBe(false);
});

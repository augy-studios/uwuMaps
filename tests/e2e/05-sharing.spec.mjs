// Share links, the map picture, live ETAs, lists, saved places sync and sending to a device nearby.
import { expect, test } from '@playwright/test';
import { collectErrors, openApp, quietThirdParties } from './helpers.mjs';

test.beforeEach(async ({ context }) => quietThirdParties(context));

const openPlace = (page, place) => page.evaluate(async (p) => {
  const { showPlace } = await import('/js/places.js');
  showPlace(p);
}, place);

test('a place: makes a short link with a map picture, the same every time, and the link opens it', async ({ page, browser }) => {
  await openApp(page);
  await openPlace(page, { name: 'Merlion Park', lat: 1.2868, lon: 103.8545 });
  await page.click('#placeShare');
  await expect(page.locator('#shareLink')).toHaveValue(/\/go\/[a-z0-9]{10}$/);
  const link = await page.inputValue('#shareLink');
  await expect(page.locator('#shareMap')).toBeVisible({ timeout: 30000 });
  expect(await page.locator('#shareMap').evaluate((img) => img.naturalWidth)).toBe(1024);
  await page.click('[data-close-modal="shareModal"]');

  await page.click('#placeShare');
  await expect(page.locator('#shareLink')).toHaveValue(link);
  await page.click('[data-close-modal="shareModal"]');

  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(other);
  const p = await other.newPage();
  await p.goto(new URL(link).pathname);
  await expect(p.locator('#placeName')).toHaveText('Merlion Park', { timeout: 30000 });
  await other.close();
});

test('the page behind a link gives chat apps a title and picture', async ({ page, request }) => {
  await openApp(page);
  await openPlace(page, { name: 'Gardens by the Bay', lat: 1.2816, lon: 103.8636 });
  await page.click('#placeShare');
  await expect(page.locator('#shareLink')).toHaveValue(/\/go\//);
  const path = new URL(await page.inputValue('#shareLink')).pathname;
  const html = await (await request.get(path, { headers: { 'x-forwarded-host': 'maps.uwuapps.org' } })).text();
  expect(html).toContain('<meta property="og:title" content="Gardens by the Bay">');
  expect(html).toMatch(/og:image" content="https:\/\/maps\.uwuapps\.org\/api\/share-map\?id=[a-z0-9]{10}"/);
  expect(html).toContain('summary_large_image');
  const png = await request.get(`/api/share-map?id=${path.split('/').pop()}`);
  expect(png.headers()['content-type']).toBe('image/png');

  const missing = await request.get('/go/zzzzzzzzzz');
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('Open in uwuMaps');
});

test('API routes refuse what they should', async ({ request }) => {
  const post = (data) => request.post('/api/share', { data });
  expect((await post({ kind: 'nope', data: {} })).status()).toBe(400);
  expect((await post({ kind: 'place', data: { label: 'x', lat: 999, lng: 0 } })).status()).toBe(400);
  expect((await post({ kind: 'place', data: { lat: 1, lng: 1 } })).status()).toBe(400);
  expect((await post({ kind: 'list', data: { name: 'x', places: [] } })).status()).toBe(400);
  expect((await request.get('/api/share?id=../../etc')).status()).toBe(400);
  expect((await request.patch('/api/share', { data: { id: 'abcdefghij', secret: 'wrong', data: { to: { label: 'x', lat: 1, lng: 1 }, arriveAt: Date.now(), mode: 'car' } } })).status()).toBe(404);
  expect((await request.get('/api/mappack?id=not-a-pack&archive=base&part=0&v=1')).status()).toBe(404);
  expect((await request.get('/api/mappack?id=singapore&archive=secrets&part=0&v=1')).status()).toBe(400);
  expect((await request.get('/api/my-live?feed=anything')).status()).toBe(404);
  expect((await request.post('/api/sync', { data: { code: 'short', places: {} } })).status()).toBe(400);
});

test('directions: a short link opens the same route for somebody else', async ({ page, browser }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: { name: 'Orchard', lat: 1.3048, lon: 103.8318 }, to: { name: 'Somerset', lat: 1.3006, lon: 103.8389 }, mode: 'foot' });
  });
  await expect(page.locator('#routeResult')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await page.click('#routeShare');
  await expect(page.locator('#shareLink')).toHaveValue(/\/trip\/[a-z0-9]{10}$/);
  await expect(page.locator('#shareWhat')).toHaveText('Orchard to Somerset');
  const path = new URL(await page.inputValue('#shareLink')).pathname;

  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(other);
  const p = await other.newPage();
  await p.goto(path);
  await expect(p.locator('#directionsPanel')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await expect(p.locator('#routeFrom')).toHaveValue('Orchard');
  await expect(p.locator('#routeTo')).toHaveValue('Somerset');
  await expect(p.locator('#travelModes [data-travel="foot"]')).toHaveAttribute('aria-pressed', 'true');
  await other.close();
});

test('a list: shared, opened elsewhere, and saved there under its name', async ({ page, browser }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const { savePlace } = await import('/js/places.js');
    savePlace({ name: 'Tokyo Tower', lat: 35.6586, lon: 139.7454 }, 'Tokyo trip');
    savePlace({ name: 'Senso-ji', lat: 35.7148, lon: 139.7967 }, 'Tokyo trip');
    savePlace({ name: 'Home', lat: 1.35, lon: 103.85 });
  });
  await page.click('#savedBtn');
  await expect(page.locator('#savedList .saved-open')).toHaveCount(3);
  await page.locator('[data-share-list="Tokyo trip"]').click();
  await expect(page.locator('#shareWhat')).toHaveText('Tokyo trip (2 places)');
  await expect(page.locator('#shareLink')).toHaveValue(/\/list\/[a-z0-9]{10}$/);
  const path = new URL(await page.inputValue('#shareLink')).pathname;

  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(other);
  const p = await other.newPage();
  await p.goto(path);
  await expect(p.locator('#listTitle')).toHaveText('Tokyo trip', { timeout: 30000 });
  await expect(p.locator('#listPlaces .saved-open')).toHaveCount(2);
  await p.click('#listSaveAll');
  await p.click('#savedBtn');
  await expect(p.locator('#savedList .pack-group')).toHaveText(['Tokyo trip']);
  await expect(p.locator('#savedList .saved-open')).toHaveText(['Senso-ji', 'Tokyo Tower']);
  await other.close();
});

test('a live ETA: follows along, and ends when the trip does', async ({ browser }) => {
  const sharer = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    geolocation: { latitude: 1.3048, longitude: 103.8318 },
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
  });
  await quietThirdParties(sharer);
  const page = await sharer.newPage();
  await openApp(page);
  await page.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: 'here', to: { name: 'Somerset', lat: 1.3006, lon: 103.8389 }, mode: 'car' });
  });
  await expect(page.locator('#routeResult')).not.toHaveClass(/hidden/, { timeout: 30000 });
  await page.click('#routeStart');
  await expect(page.locator('#navHud')).not.toHaveClass(/hidden/);

  const made = page.waitForResponse((r) => r.url().endsWith('/api/share') && r.request().method() === 'POST');
  await page.click('#navShareEta');
  const body = await (await made).json();
  expect(body.path).toMatch(/^\/eta\/[a-z0-9]{10}$/);
  expect(body.secret).toBeTruthy();
  await expect(page.locator('#navShareLabel')).toHaveText('Stop sharing');

  const friend = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(friend);
  const f = await friend.newPage();
  await f.goto(body.path);
  await expect(f.locator('#etaTitle')).toContainText('heading to Somerset', { timeout: 30000 });
  await expect(f.locator('#etaDetail')).toContainText('Arriving around');

  // An update reaches them, and only the sharer can make one.
  expect((await f.request.patch('/api/share', { data: { id: body.path.split('/').pop(), secret: 'guess', data: { to: { label: 'x', lat: 1, lng: 1 }, arriveAt: Date.now(), mode: 'car' } } })).status()).toBe(404);

  await page.click('#navShareEta');
  await expect(page.locator('#navShareLabel')).toHaveText('Share ETA');
  await expect(f.locator('#etaTitle')).toContainText('stopped sharing', { timeout: 30000 });
  await page.click('#navStop');
  await friend.close();
  await sharer.close();
});

test('sync: two devices with a code end up with the same places, deletions included', async ({ browser }) => {
  const a = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const b = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(a);
  await quietThirdParties(b);
  const pa = await a.newPage();
  const pb = await b.newPage();
  const errors = collectErrors(pa);
  await openApp(pa);
  await openApp(pb);

  await pa.evaluate(async () => {
    const { savePlace } = await import('/js/places.js');
    savePlace({ name: 'From A', lat: 1.3, lon: 103.8 });
  });
  await pa.click('#savedBtn');
  await pa.click('#syncNew');
  await expect(pa.locator('#syncSection')).toContainText('Synced at', { timeout: 20000 });
  const code = (await pa.locator('.code-big').textContent()).replace(/\s/g, '');
  expect(code).toHaveLength(12);

  await pb.evaluate(async () => {
    const { savePlace } = await import('/js/places.js');
    savePlace({ name: 'From B', lat: 1.31, lon: 103.81 });
  });
  await pb.click('#savedBtn');
  await pb.fill('#syncJoinCode', 'nope');
  await pb.click('#syncJoin');
  await expect(pb.locator('#syncSection')).toContainText('12 letters');
  await pb.fill('#syncJoinCode', code.toLowerCase());
  await pb.click('#syncJoin');
  await expect(pb.locator('#syncSection')).toContainText('Synced at', { timeout: 20000 });
  await expect(pb.locator('#savedList .saved-open')).toHaveText(['From A', 'From B']);

  await pa.click('#syncRun');
  await expect(pa.locator('#savedList .saved-open')).toHaveText(['From A', 'From B'], { timeout: 20000 });

  await pb.locator('[data-forget="1.3,103.8"]').click();
  await expect(pb.locator('#savedList .saved-open')).toHaveText(['From B']);
  await pb.click('#syncRun');
  await expect(pb.locator('#syncSection')).toContainText('Synced at');
  await pb.waitForTimeout(500);
  await pa.click('#syncRun');
  await expect(pa.locator('#savedList .saved-open')).toHaveText(['From B'], { timeout: 20000 });
  expect(errors).toEqual([]);
  await a.close();
  await b.close();
});

test('nearby: a QR code for what is being sent, and clear words about a code that is wrong', async ({ page }) => {
  await openApp(page);
  await openPlace(page, { name: 'Merlion Park', lat: 1.2868, lon: 103.8545 });
  await page.click('#placeShare');
  await page.click('#shareNearby');
  const qr = page.locator('#nearbyBody .qr-wrap svg').first();
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  const sheet = await page.locator('#nearbyModal .modal').boundingBox();
  // Centred on its sheet, as the pairing spec asks.
  expect(Math.abs((box.x + box.width / 2) - (sheet.x + sheet.width / 2))).toBeLessThan(2);
  await page.fill('#nearbyCode', 'abc');
  await page.click('#nearbyJoin');
  await expect(page.locator('#nearbyStatus')).toContainText('6 letters');
});

test('nearby: a place goes from one browser to another by code, over the real broker', async ({ browser }) => {
  // Over the public broker and a real WebRTC channel, on this one machine.
  const a = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const b = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(a);
  await quietThirdParties(b);
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openApp(pa);
  await openApp(pb);
  await openPlace(pa, { name: 'Marina Barrage', lat: 1.2806, lon: 103.8707 });
  await pa.click('#placeShare');
  await pa.click('#shareNearby');
  await pa.click('#nearbyStart');
  await expect(pa.locator('#nearbyStatus')).toContainText('Waiting for the other device', { timeout: 30000 });
  const code = await pa.locator('#nearbyHost .code-big').textContent();
  expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXYZ23456789]{6}$/);

  await pb.goto(`/#join=${code}`);
  await expect(pb.locator('#placeName')).toHaveText('Marina Barrage', { timeout: 45000 });
  await a.close();
  await b.close();
});

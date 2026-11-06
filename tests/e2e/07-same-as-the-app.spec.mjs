// What the Android app does that the site has to do too: following you, the compass, your speed, the tilt
// handle, Check for updates and scanning a code, and walking through void decks without a saved map.
import { test, expect } from '@playwright/test';
import { collectErrors, openApp, waitForMapIdle } from './helpers.mjs';

// Chromium asks before reporting which way a device is facing, as iPhones do.
test.use({ permissions: ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'] });

const camera = (page) => page.evaluate(async () => {
  const { getMap } = await import('/js/map.js');
  const m = getMap();
  const c = m.getCenter();
  return { lat: c.lat, lon: c.lng, zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing(), touchPitch: m.touchPitch.isEnabled() };
});

const locateAndFollow = async (page) => {
  await page.locator('#locateBtn').click();
  await expect(page.locator('#locateBtn')).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
};

test('My location stays on you as you move, until the map is dragged away', async ({ page, context }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await locateAndFollow(page);

  await context.setGeolocation({ latitude: 1.3100, longitude: 103.8400, accuracy: 8 });
  await expect.poll(async () => {
    const c = await camera(page);
    return Math.abs(c.lat - 1.31) < 1e-4 && Math.abs(c.lon - 103.84) < 1e-4;
  }, { timeout: 15000 }).toBe(true);

  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#locateBtn')).toHaveAttribute('aria-pressed', 'false');

  const after = await camera(page);
  await context.setGeolocation({ latitude: 1.3200, longitude: 103.8500, accuracy: 8 });
  await page.waitForTimeout(1500);
  const still = await camera(page);
  expect(Math.abs(still.lat - after.lat)).toBeLessThan(1e-3);
  expect(errors).toEqual([]);
});

test('flying somewhere else lets go of following', async ({ page }) => {
  await openApp(page);
  await locateAndFollow(page);
  await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    getMap().flyTo({ center: [103.86, 1.29], duration: 100 });
  });
  await expect(page.locator('#locateBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('the compass turns the map the way you are facing, and a second press faces north and flat', async ({ page }) => {
  await openApp(page);
  const compass = page.locator('#compassBtn');
  await expect(compass).toHaveAttribute('aria-pressed', 'false');
  await expect(compass).toHaveAttribute('aria-label', 'Point the map the way you are facing');
  await compass.click();
  await expect(compass).toHaveAttribute('aria-pressed', 'true');
  await expect(compass).toHaveAttribute('aria-label', 'Face north, and flat');

  // A compass reading 90 degrees, the way Android's browsers report one: alpha runs the other way.
  await page.evaluate(() => {
    window.__compass = setInterval(() => window.dispatchEvent(Object.assign(new Event('deviceorientationabsolute'), { alpha: 270, absolute: true })), 50);
  });
  await expect.poll(async () => Math.abs((await camera(page)).bearing - 90), { timeout: 15000 }).toBeLessThan(5);
  await page.evaluate(() => clearInterval(window.__compass));

  await compass.click();
  await expect(compass).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => {
    const c = await camera(page);
    return Math.abs(c.bearing) < 1 && c.pitch < 1;
  }).toBe(true);
});

test('a device with no compass says so', async ({ page }) => {
  await openApp(page);
  await page.locator('#compassBtn').click();
  await expect(page.locator('#toast')).toContainText("can't tell which way it's facing", { timeout: 6000 });
  await expect(page.locator('#compassBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('refusing the compass says what it needs, and leaves the map alone', async ({ page, context }) => {
  await openApp(page);
  await context.clearPermissions();
  await page.locator('#compassBtn').click();
  await expect(page.locator('#toast')).toContainText('Allow motion and orientation access');
  await expect(page.locator('#compassBtn')).toHaveAttribute('aria-pressed', 'false');
});

test('your speed shows once faster than a walk, stays while slowing, and goes when stale', async ({ page }) => {
  // Playwright's own location has no speed, so these fixes come straight from here.
  await page.addInitScript(() => {
    navigator.geolocation.watchPosition = (ok) => {
      window.__fix = (speed) => ok({ coords: { latitude: 1.305, longitude: 103.832, accuracy: 8, heading: null, speed } });
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
  });
  await openApp(page);
  await locateAndFollow(page);
  const fix = (speed) => page.evaluate((v) => window.__fix(v), speed);
  const badge = page.locator('#speedBadge');
  await fix(1.4);
  await expect(badge).toBeHidden();
  await fix(5);
  await expect(badge).toHaveText('18 km/h');
  await fix(2);
  await expect(badge).toHaveText('7 km/h');
  await fix(1);
  await expect(badge).toBeHidden();
  await fix(10);
  await expect(badge).toHaveText('36 km/h');
  // No fix for a few seconds: it's old news.
  await expect(badge).toBeHidden({ timeout: 8000 });
});

test('speed follows the route: always in a car, never on foot', async ({ page }) => {
  await openApp(page);
  const shown = await page.evaluate(async () => {
    const { speedToShow } = await import('/js/you.js');
    return {
      carStopped: speedToShow(0, null, 'car'),
      bike: speedToShow(3, null, 'bike'),
      foot: speedToShow(5, null, 'foot'),
      noneSlow: speedToShow(2, null, undefined),
      noneFast: speedToShow(3, null, undefined),
      unknown: speedToShow(null, 3, 'car'),
    };
  });
  expect(shown).toEqual({ carStopped: 0, bike: 3, foot: null, noneSlow: null, noneFast: 3, unknown: null });
});

test('the handle tilts and turns, and two fingers are left to pan', async ({ page }) => {
  await openApp(page);
  expect((await camera(page)).touchPitch).toBe(false);
  await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    getMap().jumpTo({ pitch: 30, bearing: 0 });
  });
  const box = await page.locator('#orbitHandle').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  const c = await camera(page);
  expect(c.pitch).toBeCloseTo(50, 0);
  expect(c.bearing).toBeCloseTo(-48, 0);

  // By keyboard too.
  await page.locator('#orbitHandle').focus();
  await page.keyboard.press('ArrowDown');
  expect((await camera(page)).pitch).toBeCloseTo(35, 0);
  await page.keyboard.press('ArrowRight');
  expect((await camera(page)).bearing).toBeCloseTo(-24, 0);
});

test('the zoom buttons zoom, and do not stop following', async ({ page }) => {
  await openApp(page);
  await locateAndFollow(page);
  await waitForMapIdle(page);
  const before = (await camera(page)).zoom;
  await page.locator('#zoomInBtn').click();
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before + 0.5);
  await expect(page.locator('#locateBtn')).toHaveAttribute('aria-pressed', 'true');
});

test('Check for updates says when there is nothing new', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))).toBe(true);
  await page.waitForTimeout(500);
  await page.locator('#updateBtn').click();
  await expect(page.locator('#toast')).toContainText('newest version');
});

// A camera that shows a QR code, as the tests have no real one.
const fakeCamera = (page, text) => page.evaluate(async (code) => {
  const { default: qrcode } = await import('/vendor/qrcode/qrcode.mjs');
  const qr = qrcode(0, 'L');
  qr.addData(code);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 6;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (n + 8) * cell;
  const c = canvas.getContext('2d');
  const draw = () => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) c.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
  };
  draw();
  setInterval(draw, 100);
  const stream = canvas.captureStream(10);
  window.__cameraStream = stream;
  navigator.mediaDevices.getUserMedia = async () => stream;
}, text);

test('Scan a code opens a uwuMaps link, and the camera goes off after', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  const link = await page.evaluate(async () => {
    const { selfLink } = await import('/js/nearby.js');
    return selfLink({ kind: 'place', data: { label: 'Scanned place', lat: 1.29, lng: 103.85 } });
  });
  await fakeCamera(page, link);
  await page.locator('#nearbyBtn').click();
  await page.getByRole('button', { name: 'Scan a code' }).click();
  await expect(page.locator('#placeName')).toHaveText('Scanned place', { timeout: 20000 });
  await expect(page.locator('#scanModal')).toBeHidden();
  await expect(page.locator('#nearbyModal')).toBeHidden();
  expect(await page.evaluate(() => window.__cameraStream.getTracks().every((t) => t.readyState === 'ended'))).toBe(true);
  expect(errors).toEqual([]);
});

test('Scan a code says when a code is not one of ours, and closing it stops the camera', async ({ page }) => {
  await openApp(page);
  await fakeCamera(page, 'https://example.com/not-ours');
  await page.locator('#nearbyBtn').click();
  await page.getByRole('button', { name: 'Scan a code' }).click();
  await expect(page.locator('#nearbyStatus')).toHaveText("That code isn't a uwuMaps link.", { timeout: 20000 });
  await expect(page.locator('#nearbyModal')).toBeVisible();

  await page.getByRole('button', { name: 'Scan a code' }).click();
  await page.locator('#scanModal [data-close-modal]').click();
  await expect(page.locator('#scanModal')).toBeHidden();
  await expect(page.locator('#nearbyModal')).toBeVisible();
});

test('walking in Singapore with no saved map uses our graph, void decks and all, and says it is online', async ({ page }) => {
  await openApp(page);
  const asked = [];
  page.on('request', (r) => {
    if (r.url().includes('routing.openstreetmap.de') || r.url().includes('/api/mappack?id=')) asked.push(r.url());
  });
  const route = await page.evaluate(async () => {
    const { getRoute } = await import('/js/route-client.js');
    const r = await getRoute({ lat: 1.3695, lon: 103.8450 }, { lat: 1.3725, lon: 103.8475 }, 'foot');
    return { source: r.source, distance: r.distance, names: r.steps.map((s) => s.name) };
  });
  expect(route.source).toBe('online');
  expect(route.distance).toBeGreaterThan(100);
  expect(asked.some((u) => u.includes('routing.openstreetmap.de'))).toBe(false);
});

test('driving, and walking outside Singapore, still go to the route servers', async ({ page }) => {
  await openApp(page);
  const urls = [];
  await page.route('**/routing.openstreetmap.de/**', (r) => {
    urls.push(r.request().url());
    return r.fulfill({ json: { code: 'Ok', routes: [] } });
  });
  const answers = await page.evaluate(async () => {
    const { getRoute } = await import('/js/route-client.js');
    const tryIt = (a, b, mode) => getRoute(a, b, mode).then((r) => r.source, (e) => e.message);
    return [
      await tryIt({ lat: 1.3695, lon: 103.8450 }, { lat: 1.3725, lon: 103.8475 }, 'car'),
      await tryIt({ lat: 3.1390, lon: 101.6869 }, { lat: 3.1450, lon: 101.6950 }, 'foot'),
    ];
  });
  expect(answers).toEqual(['No way there was found.', 'No way there was found.']);
  expect(urls.some((u) => u.includes('routed-car'))).toBe(true);
  expect(urls.some((u) => u.includes('routed-foot'))).toBe(true);
});

test('when the published map fails, walking falls back to the route server', async ({ page }) => {
  await openApp(page);
  await page.context().route('**/api/mappack?id=**', (r) => r.abort());
  const urls = [];
  await page.context().route('**/routing.openstreetmap.de/**', (r) => {
    urls.push(r.request().url());
    return r.fulfill({ json: { code: 'Ok', routes: [] } });
  });
  const answer = await page.evaluate(async () => {
    const { getRoute } = await import('/js/route-client.js');
    return getRoute({ lat: 1.3695, lon: 103.8450 }, { lat: 1.3725, lon: 103.8475 }, 'foot').then((r) => r.source, (e) => e.message);
  });
  expect(answer).toBe('No way there was found.');
  expect(urls.some((u) => u.includes('routed-foot'))).toBe(true);
});

// Directions and live navigation, with the device's location moved along by the test.
import { expect, test } from '@playwright/test';
import { collectErrors, downloadSingapore, jumpTo, openApp, quietThirdParties, rendered, waitForMapIdle, waitForServiceWorker } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let context;
let page;

const moveTo = (latitude, longitude, speed = 10) => context.setGeolocation({ latitude, longitude, accuracy: 8, speed });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    geolocation: { latitude: 1.3048, longitude: 103.8318 },
    permissions: ['geolocation'],
  });
  await quietThirdParties(context);
  page = await context.newPage();
  await openApp(page);
  await waitForServiceWorker(page);
  await downloadSingapore(page);
  await waitForMapIdle(page);
});

test.afterAll(async () => context.close());

test('a place card leads to directions from where you are', async () => {
  await page.evaluate(async () => {
    const { showPlace } = await import('/js/places.js');
    showPlace({ name: 'Somerset', lat: 1.3006, lon: 103.8389 });
  });
  await page.click('#placeGo');
  await expect(page.locator('#routeFrom')).toHaveValue('My location');
  await expect(page.locator('#routeTo')).toHaveValue('Somerset');
  await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
  // The line itself: the panel can say all this with nothing drawn on the map.
  await waitForMapIdle(page);
  await expect.poll(() => rendered(page, ['route-line']), { timeout: 30000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/directions.png' });
});

test('changing how to travel finds a new route, and swap turns it round', async () => {
  await page.click('#travelModes [data-travel="foot"]');
  await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
  const walkTime = await page.locator('#routeTime').textContent();
  await page.click('#travelModes [data-travel="car"]');
  await expect(page.locator('#routeTime')).not.toHaveText(walkTime, { timeout: 30000 });
  await page.click('#routeSwap');
  await expect(page.locator('#routeFrom')).toHaveValue('Somerset');
  await expect(page.locator('#routeTo')).toHaveValue('My location');
  await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
  await page.click('#routeSwap');
  await page.click('#travelModes [data-travel="foot"]');
  await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
});

test('navigating: says what is next, counts down, and follows the device', async () => {
  await page.waitForTimeout(500);
  await page.click('#routeStart');
  await expect(page.locator('#navHud')).not.toHaveClass(/hidden/);
  await expect(page.locator('#directionsPanel')).toHaveClass(/hidden/);
  await expect(page.locator('#navText')).not.toBeEmpty();
  await expect(page.locator('#navLeft')).toContainText(/min|h/);
  await expect.poll(() => rendered(page, ['route-line']), { timeout: 30000 }).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/navigating.png' });

  const before = await page.locator('#navLeft').textContent();
  const along = await page.evaluate(async () => {
    const { navProgress } = await import('/js/nav.js');
    const { route } = navProgress();
    const c = route.coords[Math.floor(route.coords.length / 2)];
    return { lat: c[1], lon: c[0] };
  });
  await moveTo(along.lat, along.lon);
  await expect(page.locator('#navLeft')).not.toHaveText(before, { timeout: 20000 });
  const center = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    await new Promise((r) => setTimeout(r, 1200));
    const c = getMap().getCenter();
    return { lat: c.lat, lon: c.lng, pitch: getMap().getPitch() };
  });
  expect(Math.abs(center.lat - along.lat)).toBeLessThan(0.002);
  expect(center.pitch).toBeGreaterThan(30);
});

test('navigating: going well off the route finds a new one', async () => {
  const before = await page.evaluate(async () => {
    const { navProgress } = await import('/js/nav.js');
    return navProgress().route.coords.length + navProgress().route.distance;
  });
  // A few fixes running, away from the route, all near each other.
  for (const [lat, lon] of [[1.3120, 103.8450], [1.3121, 103.8451], [1.3122, 103.8452], [1.3123, 103.8453]]) {
    await moveTo(lat, lon);
    await page.waitForTimeout(1200);
  }
  await expect.poll(() => page.evaluate(async () => {
    const { navProgress } = await import('/js/nav.js');
    return navProgress().route.coords.length + navProgress().route.distance;
  }), { timeout: 30000 }).not.toBe(before);
  const start = await page.evaluate(async () => {
    const { navProgress } = await import('/js/nav.js');
    return navProgress().route.coords[0];
  });
  // The new route starts from where the device went.
  expect(Math.abs(start[1] - 1.3122)).toBeLessThan(0.003);
});

test('navigating: arriving ends it, and tidies up', async () => {
  await moveTo(1.3006, 103.8389);
  await expect(page.locator('#navHud')).toHaveClass(/hidden/, { timeout: 30000 });
  await expect(page.locator('#toast')).toContainText('You have arrived');
  expect(await page.evaluate(() => document.body.classList.contains('navigating'))).toBe(false);
});

test('navigating: End stops following, and the voice button remembers', async () => {
  await moveTo(1.3048, 103.8318);
  await page.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: { name: 'Orchard', lat: 1.3048, lon: 103.8318 }, to: { name: 'Somerset', lat: 1.3006, lon: 103.8389 }, mode: 'foot' });
  });
  await expect(page.locator('#routeSource')).toHaveText('Offline', { timeout: 30000 });
  await page.click('#routeStart');
  await expect(page.locator('#navVoice')).toHaveAttribute('aria-pressed', 'true');
  await page.click('#navVoice');
  await expect(page.locator('#navVoice')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('uwumaps.navVoice'))).toBe('false');
  await page.click('#navStop');
  await expect(page.locator('#navHud')).toHaveClass(/hidden/);
});

test('with location refused, starting from where you are says how to fix it', async ({ browser }) => {
  const denied = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(denied);
  const p = await denied.newPage();
  // The config grants every context location, so the refusal is made here, as a browser reports it.
  await p.addInitScript(() => {
    const refuse = (_ok, fail) => fail(Object.assign(new Error('User denied'), { code: 1, PERMISSION_DENIED: 1 }));
    navigator.geolocation.getCurrentPosition = refuse;
    navigator.geolocation.watchPosition = refuse;
  });
  await openApp(p);
  await p.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: 'here', to: { name: 'Somerset', lat: 1.3006, lon: 103.8389 }, mode: 'foot' });
  });
  await expect(p.locator('#routeStatus')).toContainText('Allow location access');
  await denied.close();
});

test('with no saved map, directions come from the online server', async ({ browser }) => {
  const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(fresh);
  const p = await fresh.newPage();
  await openApp(p);
  await p.evaluate(async () => {
    const { openDirections } = await import('/js/directions.js');
    openDirections({ from: { name: 'A', lat: 1.3048, lon: 103.8318 }, to: { name: 'B', lat: 1.3006, lon: 103.8389 }, mode: 'bike' });
  });
  await expect(p.locator('#routeSource')).toHaveText('Online', { timeout: 30000 });
  const steps = await p.locator('#routeSteps li').allTextContents();
  expect(steps[steps.length - 1]).toContain('You have arrived');
  await fresh.close();
});

test('both ends of a route can be picked by tapping the map, not only from where you are', async ({ browser }) => {
  const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', viewport: { width: 1280, height: 800 }, geolocation: { latitude: 1.3048, longitude: 103.8318 }, permissions: ['geolocation'] });
  await quietThirdParties(fresh);
  const p = await fresh.newPage();
  const errors = collectErrors(p);
  await openApp(p);
  await jumpTo(p, { center: [103.8352, 1.3025], zoom: 15.5, pitch: 0, bearing: 0 });
  await waitForMapIdle(p);
  const tap = (x, y) => p.mouse.click(x, y);
  const ends = () => p.evaluate(async () => {
    const { directionsState } = await import('/js/directions.js');
    const { from, to } = directionsState();
    return { from, to };
  });
  const from = p.locator('#routeFrom');
  const to = p.locator('#routeTo');
  const pickFrom = p.locator('[data-pick="from"]');
  const pickTo = p.locator('[data-pick="to"]');

  await p.click('#directionsBtn');
  await expect(from).toHaveValue('My location');
  await expect(p.locator('#routeStatus')).toContainText('tap the map');
  await expect(pickTo).toHaveAttribute('aria-pressed', 'true');

  // The start, off a tap, then the destination is next without being asked for.
  await pickFrom.click();
  await expect(pickFrom).toHaveAttribute('aria-pressed', 'true');
  await tap(700, 300);
  await expect(from).not.toHaveValue('My location');
  await expect(from).not.toHaveValue('');
  await expect(pickTo).toHaveAttribute('aria-pressed', 'true');
  await expect(p.locator('.marker-from')).toBeVisible();

  await tap(900, 500);
  await expect(to).not.toHaveValue('');
  await expect(p.locator('#routeSource')).toHaveText('Online', { timeout: 30000 });
  await expect(p.locator('.marker-pin:not(.marker-from)')).toBeVisible();
  await expect(p.locator('#placeCard')).toHaveClass(/hidden/);
  await p.waitForTimeout(800);
  await p.screenshot({ path: 'test-results/directions-picked.png' });

  // With both set a stray tap leaves the route alone, until an end is chosen to change.
  const picked = await ends();
  await tap(600, 770);
  await expect(p.locator('#toast, .toast').first()).toContainText('Press the pin');
  expect(await ends()).toEqual(picked);
  await pickTo.click();
  await tap(700, 40);
  await expect.poll(async () => (await ends()).to.lat).not.toBe(picked.to.lat);
  expect((await ends()).from).toEqual(picked.from);

  // Back to starting from here, from the field.
  await from.click();
  await p.locator('#routeSuggestions button', { hasText: 'My location' }).click();
  await expect(from).toHaveValue('My location');
  await expect(p.locator('.marker-from')).toHaveCount(0);

  await p.click('#directionsClose');
  await expect(p.locator('.marker-pin')).toHaveCount(0);

  // From a place's card, the other way round from its Directions.
  await p.evaluate(async () => {
    const { showPlace } = await import('/js/places.js');
    showPlace({ name: 'Somerset', lat: 1.3006, lon: 103.8389 }, { fly: false });
  });
  await p.click('#placeFrom');
  await expect(from).toHaveValue('Somerset');
  await expect(to).toHaveValue('');
  await tap(900, 500);
  await expect(to).not.toHaveValue('');
  await expect(p.locator('#routeSource')).toHaveText('Online', { timeout: 30000 });
  expect(errors).toEqual([]);
  await fresh.close();
});

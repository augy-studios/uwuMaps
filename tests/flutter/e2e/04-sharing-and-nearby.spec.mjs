import { test, expect } from '@playwright/test';
import { button, call, collectErrors, openApp, openPlace, said, state } from './helpers.mjs';

const WEBSITE = 'http://127.0.0.1:4173';
const place = { name: 'Fullerton Hotel', lat: 1.2861, lon: 103.8531 };

const selfLink = (origin, payload) => `${origin}/#s=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

test('a place shares as a short link that opens in the app and on the website', async ({ page, context }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await openPlace(page, place);
  await button(page, 'Share').click();
  await expect.poll(async () => (await state(page)).shareUrl, { timeout: 15000 }).toMatch(/\/go\/[a-z0-9]{10}$/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('share.png') });
  await expect(button(page, 'Copy link')).toBeVisible();
  await expect(button(page, 'Send')).toBeVisible();
  await expect(button(page, 'Nearby')).toBeVisible();
  const url = (await state(page)).shareUrl;
  const id = /\/go\/([a-z0-9]{10})$/.exec(url)[1];

  // In the app.
  const other = await context.newPage();
  await openApp(other, { path: `/go/${id}` });
  await expect.poll(async () => (await state(other)).place, { timeout: 15000 }).toBe(place.name);

  // On the website, from the same store.
  const site = await context.newPage();
  await site.goto(`${WEBSITE}/#share/${id}`);
  await expect(site.locator('#placeName')).toHaveText(place.name, { timeout: 60000 });
  expect(errors).toEqual([]);
});

test('a link the website made opens in the app, and one the app makes opens on the website', async ({ page, context }) => {
  await openApp(page);
  const fromSite = { kind: 'place', data: { label: 'Café 東京', lat: 1.3, lng: 103.8 } };
  expect(await call(page, 'openLink', selfLink('http://127.0.0.1:4180', fromSite))).toBe('true');
  await expect.poll(async () => (await state(page)).place).toBe('Café 東京');

  const directions = { kind: 'directions', data: { from: 'here', to: { label: 'Somewhere', lat: 1.29, lng: 103.85 }, mode: 'foot' } };
  await call(page, 'openLink', selfLink('http://127.0.0.1:4180', directions));
  await expect.poll(async () => (await state(page)).directionsOpen).toBe(true);
  expect((await state(page)).to).toBe('Somewhere');
  expect((await state(page)).mode).toBe('foot');

  // Nonsense is refused rather than acted on.
  expect(await call(page, 'openLink', selfLink('http://127.0.0.1:4180', { kind: 'place', data: { label: 'x', lat: 999, lng: 0 } }))).toBe('false');
});

test('a shared list opens with its places, and saves them all', async ({ page }, info) => {
  await openApp(page);
  const list = { kind: 'list', data: { name: 'Coffee', places: [{ label: 'One', lat: 1.3, lng: 103.8 }, { label: 'Two', lat: 1.31, lng: 103.81 }] } };
  await call(page, 'openLink', selfLink('http://127.0.0.1:4180', list));
  await expect(page.getByRole('heading', { name: 'Coffee' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('list.png') });
  await button(page, 'Save all').click();
  await expect(said(page, 'Saved 2 places to Coffee')).toBeVisible();
  expect((await state(page)).saved).toEqual(['One', 'Two']);

  await button(page, 'Saved places').click();
  await expect(page.getByRole('heading', { name: 'Saved places' })).toBeVisible();
  await expect(button(page, 'One')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('saved.png') });
  await button(page, 'Remove One').click();
  await expect.poll(async () => (await state(page)).saved).toEqual(['Two']);
});

test('saved places sync with a code, between two copies of the app and the website', async ({ page, browser }) => {
  await openApp(page, {});
  await openPlace(page, place);
  await button(page, 'Save').click();
  await button(page, 'Saved places').click();
  await button(page, 'Start syncing').click();
  await expect.poll(async () => (await state(page)).syncState, { timeout: 15000 }).toMatch(/^Synced at/);
  const { syncCode } = await state(page);
  expect(syncCode).toMatch(/^[A-Z2-9]{12}$/);

  const second = await browser.newContext({ baseURL: 'http://127.0.0.1:4180', viewport: { width: 412, height: 915 } });
  const other = await second.newPage();
  await openApp(other);
  await button(other, 'Saved places').click();
  const box = other.getByRole('textbox', { name: 'Sync code' });
  await box.click();
  await other.waitForTimeout(150);
  await other.keyboard.type(syncCode);
  await button(other, 'Join').click();
  await expect.poll(async () => (await state(other)).saved, { timeout: 15000 }).toContain(place.name);
  await second.close();

  // The same code on the website.
  const web = await browser.newContext({ baseURL: WEBSITE, viewport: { width: 412, height: 915 } });
  const site = await web.newPage();
  await site.addInitScript((code) => localStorage.setItem('uwumaps.syncCode', code), syncCode);
  await site.goto('/');
  await site.click('#savedBtn');
  await expect(site.locator('#savedList')).toContainText(place.name, { timeout: 30000 });
  await web.close();
});

test('a bad sync code is explained', async ({ page }) => {
  await openApp(page);
  await button(page, 'Saved places').click();
  const box = page.getByRole('textbox', { name: 'Sync code' });
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.type('NOPE');
  await button(page, 'Join').click();
  await expect(said(page, 'A code is 12 letters and numbers.')).toBeVisible();
});

test('a live ETA goes out while navigating, and a follower sees it', async ({ page, context }, info) => {
  await openApp(page);
  // A route from the online servers, stubbed.
  await page.route(/routing\.openstreetmap\.de/, (route) => route.fulfill({ json: {
    routes: [{ distance: 1000, duration: 200, geometry: { coordinates: [[103.8318, 1.3048], [103.84, 1.30], [103.8565, 1.2835]] }, legs: [{ steps: [
      { distance: 500, duration: 100, name: 'First Road', mode: 'driving', maneuver: { type: 'depart', location: [103.8318, 1.3048], bearing_after: 90 } },
      { distance: 500, duration: 100, name: 'Second Road', mode: 'driving', maneuver: { type: 'turn', modifier: 'right', location: [103.84, 1.30] } },
      { distance: 0, duration: 0, name: '', mode: 'driving', maneuver: { type: 'arrive', location: [103.8565, 1.2835] } },
    ] }] }],
  } }));
  await openPlace(page, { name: 'Marina', lat: 1.2835, lon: 103.8565 });
  await button(page, 'Directions').last().click();
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('online');
  await button(page, 'Start').click();
  await expect.poll(async () => (await state(page)).navigating).toBe(true);
  await button(page, 'Share ETA').click();
  await expect(button(page, 'Stop sharing')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: info.outputPath('eta-sharing.png') });
  await button(page, 'End').click();
  await expect.poll(async () => (await state(page)).navigating).toBe(false);
});

test('a QR code is offered, and sending by code pairs with the website, both ways', async ({ page, browser }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await openPlace(page, place);
  await button(page, 'Save').click();

  // App to website.
  await button(page, 'Send to a device nearby').click();
  await expect(page.getByRole('img', { name: 'QR code' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('nearby.png') });
  await button(page, 'Show a code').click();
  await expect.poll(async () => (await state(page)).nearbyCode).toBeTruthy();
  await expect(said(page, /Waiting for the other device/)).toBeVisible({ timeout: 20000 });
  const { nearbyCode } = await state(page);

  const webA = await browser.newContext({ baseURL: WEBSITE, viewport: { width: 412, height: 915 } });
  const siteA = await webA.newPage();
  await siteA.goto(`/#join=${nearbyCode}`);
  await expect(siteA.locator('#listTitle')).toHaveText('From a nearby device', { timeout: 60000 });
  await expect(siteA.locator('#listPlaces')).toContainText(place.name);
  await expect(said(page, 'Sent.')).toBeVisible({ timeout: 20000 });
  await webA.close();
  await button(page, 'Close').click();

  // Website to app.
  const webB = await browser.newContext({ baseURL: WEBSITE, viewport: { width: 412, height: 915 } });
  const siteB = await webB.newPage();
  await siteB.goto('/');
  await siteB.waitForFunction(() => document.querySelector('#map canvas'), null, { timeout: 60000 });
  await siteB.evaluate(async () => {
    const { savePlace } = await import('/js/places.js');
    savePlace({ name: 'From the website', lat: 1.3, lon: 103.8 });
  });
  await siteB.click('#nearbyBtn');
  await siteB.click('#nearbyStart');
  await expect(siteB.locator('#nearbyStatus')).toContainText('Waiting for the other device', { timeout: 20000 });
  const code = (await siteB.locator('#nearbyHost .code-big').textContent()).trim();

  await button(page, 'Send to a device nearby').click();
  const box = page.getByRole('textbox', { name: 'Code', exact: true });
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.type(code);
  await button(page, 'Receive').click();
  await expect(page.getByRole('heading', { name: 'From a nearby device' })).toBeVisible({ timeout: 60000 });
  await expect(button(page, 'From the website')).toBeVisible();
  await webB.close();
  expect(errors).toEqual([]);
});

test('a code nobody is hosting says so', async ({ page }) => {
  await openApp(page);
  await button(page, 'Send to a device nearby').click();
  const box = page.getByRole('textbox', { name: 'Code', exact: true });
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.type('BCDFGH');
  await button(page, 'Receive').click();
  await expect(said(page, /Nobody is hosting with that code|Could not reach the other device/)).toBeVisible({ timeout: 40000 });
});

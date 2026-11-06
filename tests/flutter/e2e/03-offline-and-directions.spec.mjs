import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { button, call, collectErrors, openApp, openPlace, said, state } from './helpers.mjs';

const sharp = createRequire(fileURLToPath(new URL('../../../main-site/package.json', import.meta.url)))('sharp');

async function download(page) {
  await button(page, 'Offline maps').click();
  await expect.poll(async () => (await state(page)).catalogue, { timeout: 30000 }).toContain('singapore');
  await button(page, 'Download').first().click();
  await expect.poll(async () => (await state(page)).installed, { timeout: 120000, intervals: [1000] }).toContain('singapore');
  await button(page, 'Close').click();
}

const place = { name: 'Marina', lat: 1.2835, lon: 103.8565 };

test('a pack downloads from the release, with progress, in pieces by range', async ({ page }, info) => {
  const errors = collectErrors(page);
  const requests = [];
  page.on('request', (r) => {
    if (r.url().includes('/__release/singapore-')) requests.push(r.headers().range);
  });
  await openApp(page);
  await page.route('**/__release/singapore-*', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await button(page, 'Offline maps').click();
  await expect.poll(async () => (await state(page)).catalogue, { timeout: 30000 }).toContain('singapore');
  await page.waitForTimeout(500);
  await page.screenshot({ path: info.outputPath('before.png') });
  // Not built on the test server, so honest about it.
  await expect(said(page, 'Not ready yet')).toBeVisible();
  await button(page, 'Download').first().click();
  await expect.poll(async () => Object.keys((await state(page)).downloading)).toContain('singapore');
  await page.screenshot({ path: info.outputPath('during.png') });
  await expect(button(page, 'Stop')).toBeVisible();
  await expect.poll(async () => (await state(page)).installed, { timeout: 120000, intervals: [1000] }).toContain('singapore');
  await expect(button(page, 'Delete Singapore')).toBeVisible();
  await page.screenshot({ path: info.outputPath('after.png') });
  await expect(said(page, 'Singapore is ready to use offline')).toBeVisible();
  // Straight from the release's files, 4 MiB at a time, rather than through the API route.
  expect(requests.length).toBeGreaterThan(8);
  expect(requests.every((r) => /^bytes=\d+-\d+$/.test(r))).toBe(true);
  expect(errors).toEqual([]);
});

test('a stopped download leaves nothing half installed, and deleting a pack takes it away', async ({ page }) => {
  await openApp(page);
  await page.route('**/__release/singapore-*', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await button(page, 'Offline maps').click();
  await expect.poll(async () => (await state(page)).catalogue, { timeout: 30000 }).toContain('singapore');
  await button(page, 'Download').first().click();
  await button(page, 'Stop').click();
  await expect.poll(async () => Object.keys((await state(page)).downloading), { timeout: 30000 }).not.toContain('singapore');
  expect((await state(page)).installed).not.toContain('singapore');
  await button(page, 'Download').first().click();
  await expect.poll(async () => (await state(page)).installed, { timeout: 120000 }).toContain('singapore');
  await button(page, 'Delete Singapore').click();
  await expect.poll(async () => (await state(page)).installed).not.toContain('singapore');
});

test('with a pack, directions come from the offline router, the same as the website\'s', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await download(page);
  await openPlace(page, place);
  await button(page, 'Directions').last().click();
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');
  const s = await state(page);
  // tests/flutter/compare-router.mjs has the website's answer for this journey.
  expect(s.route.distance).toBe(5266);
  expect(s.route.duration).toBe(421);
  // On screen, whole, at its proper width and in the theme's colour: a route reset to a hairline, or fitted
  // somewhere else, still "exists". Counted above the panel, where the only thing that colour is the line.
  const primary = [(s.primary >> 16) & 255, (s.primary >> 8) & 255, s.primary & 255];
  await expect.poll(async () => {
    const shot = await page.screenshot({ path: info.outputPath('route-car.png') });
    const { data, info: size } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const above = Math.floor(size.height * 0.5);
    let line = 0;
    for (let i = 0; i < size.width * above * size.channels; i += size.channels) {
      if (Math.abs(data[i] - primary[0]) + Math.abs(data[i + 1] - primary[1]) + Math.abs(data[i + 2] - primary[2]) < 24) line++;
    }
    return line;
  }, { timeout: 15000, intervals: [1000] }).toBeGreaterThan(4000);
  const { camera } = await state(page);
  expect(camera.tilt).toBeCloseTo(0, 1);
  expect(camera.bearing).toBeCloseTo(0, 1);

  await button(page, 'Walk').click();
  await expect.poll(async () => (await state(page)).route?.distance, { timeout: 30000 }).toBe(4889);
  await button(page, 'Cycle').click();
  await expect.poll(async () => (await state(page)).route?.distance, { timeout: 30000 }).toBe(5650);
  expect((await state(page)).mode).toBe('bike');

  // Swapped, the start's a place and the end is here.
  await button(page, 'Swap start and end').click();
  await expect.poll(async () => (await state(page)).from).toBe('Marina');
  await expect.poll(async () => (await state(page)).to).toBe('My location');
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');
  expect(errors).toEqual([]);
});

test('an end can be typed or picked on the map, and a tap with neither waiting says so', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await download(page);
  await button(page, 'Directions').click();
  await expect.poll(async () => (await state(page)).directionsOpen).toBe(true);

  const to = page.getByRole('textbox', { name: 'To' });
  await to.click();
  await page.waitForTimeout(150);
  await page.keyboard.type('Bayfront', { delay: 15 });
  const hit = page.getByRole('button', { name: /Bayfront.*Train station/ }).first();
  await expect(hit).toBeVisible();
  await page.screenshot({ path: info.outputPath('typing.png') });
  await hit.click();
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');

  // A fresh end, by pressing the pin and then the map.
  await button(page, 'Pick the destination on the map').click();
  await expect(said(page, 'Tap the map for where to go.')).toBeVisible();
  await page.waitForTimeout(1000);
  // Beside City Hall, somewhere with roads, above the panel.
  await call(page, 'jumpTo', { lat: 1.2935, lon: 103.852, zoom: 15, tilt: 0, bearing: 0 });
  await page.waitForTimeout(1000);
  const at = JSON.parse(await call(page, 'tapMap', { lat: 1.2935, lon: 103.852 }));
  await page.mouse.click(at.x, at.y - 120);
  await expect.poll(async () => (await state(page)).to, { timeout: 10000 }).not.toBe('Bayfront');
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');
  await page.waitForTimeout(1000);
  await page.mouse.click(120, 160);
  await expect(said(page, 'Press the pin beside From or To to change it')).toBeVisible();
  expect(errors).toEqual([]);
});

test('following a route: what\'s next, a new way when you leave it, and arriving', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await download(page);
  await openPlace(page, place);
  await button(page, 'Directions').last().click();
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');
  await button(page, 'Start').click();
  await expect.poll(async () => (await state(page)).navigating).toBe(true);
  await page.waitForTimeout(800);
  expect((await state(page)).navText).toBeTruthy();
  await page.screenshot({ path: info.outputPath('navigating.png') });

  await button(page, 'Spoken directions').click();
  await button(page, 'Spoken directions').click();

  // Well off the line, three fixes running, and it finds a new way from there.
  const first = (await state(page)).navText;
  for (let i = 0; i < 4; i++) {
    await call(page, 'position', { lat: 1.33, lon: 103.8 });
    await page.waitForTimeout(150);
  }
  await expect.poll(async () => (await state(page)).navText, { timeout: 30000 }).not.toBe(first);

  // At the end.
  const [lon, lat] = (await state(page)).navEnd;
  await call(page, 'position', { lat, lon });
  await expect.poll(async () => (await state(page)).navigating, { timeout: 10000 }).toBe(false);
  await expect(said(page, 'You have arrived')).toBeVisible();
  expect(errors).toEqual([]);
});

test('offline: the bar says so, search and routes still work, and what needs the internet says so', async ({ page }, info) => {
  await openApp(page);
  await download(page);
  await call(page, 'online', 'false');
  await expect(said(page, "You're offline. Saved areas still work.")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('offline.png') });

  // A street, from the pack's search file, which only exists offline.
  const box = page.getByRole('textbox', { name: 'Search places' });
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.type('Bencoolen Street', { delay: 15 });
  const hit = page.getByRole('button', { name: /Bencoolen Street/ }).first();
  await expect(hit).toBeVisible();
  await hit.click();
  await expect.poll(async () => (await state(page)).place).toBe('Bencoolen Street');
  await button(page, 'Directions').last().click();
  await expect.poll(async () => (await state(page)).route?.source, { timeout: 30000 }).toBe('offline');
  await button(page, 'Close').click();

  // Somewhere with no pack.
  await openPlace(page, { name: 'Tokyo', lat: 35.68, lon: 139.76 });
  await button(page, 'Directions').last().click();
  await expect.poll(async () => (await state(page)).status, { timeout: 15000 }).toContain('offline');
  await button(page, 'Close').click();

  await button(page, 'Offline maps').click();
  await page.waitForTimeout(300);
  await expect(button(page, 'Delete Singapore')).toBeVisible();

  await call(page, 'online', 'true');
  await expect(page.getByText("You're offline. Saved areas still work.")).toHaveCount(0);
});

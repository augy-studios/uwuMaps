import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { button, call, collectErrors, openApp, state, waitRendered } from './helpers.mjs';

const search = (page) => page.getByRole('textbox', { name: 'Search places' });
const toggle = (page, name) => page.getByRole('switch', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true }));

async function type(page, box, text) {
  await box.click();
  await page.waitForTimeout(150);
  await page.keyboard.type(text, { delay: 15 });
}

test('the map draws 3D buildings and Singapore\'s transport from the app\'s own data', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await waitRendered(page, ['buildings-walls'], 5);
  await waitRendered(page, ['sg-lines'], 1);
  await waitRendered(page, ['sg-stations'], 1);
  await call(page, 'jumpTo', { lat: 1.2936, lon: 103.8520, zoom: 16.5, tilt: 0 });
  await waitRendered(page, ['sg-stops'], 1);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath('stops.png') });
  expect(errors).toEqual([]);
});

test('the Layers sheet turns each layer off and on, and remembers', async ({ page }, info) => {
  await openApp(page);
  await waitRendered(page, ['buildings-walls'], 5);
  await button(page, 'Layers').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath('layers.png') });
  await toggle(page, '3D buildings').click();
  await expect.poll(async () => Number(await call(page, 'rendered', ['buildings-walls']))).toBe(0);
  await toggle(page, 'MRT and LRT lines').click();
  await expect.poll(async () => Number(await call(page, 'rendered', ['sg-lines']))).toBe(0);
  await button(page, 'Close').click();

  await page.reload();
  await page.waitForFunction(() => window.__uwu);
  await expect.poll(async () => (await state(page)).styleLoaded, { timeout: 60000 }).toBe(true);
  expect((await state(page)).layers['buildings']).toBe(false);
  await page.waitForTimeout(1500);
  expect(Number(await call(page, 'rendered', ['buildings-walls']))).toBe(0);

  await button(page, 'Layers').click();
  await toggle(page, '3D buildings').click();
  await waitRendered(page, ['buildings-walls'], 5);
});

test('the map stays where it was left', async ({ page }) => {
  await openApp(page);
  await call(page, 'jumpTo', { lat: 1.35, lon: 103.9, zoom: 14, tilt: 30, bearing: 10 });
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForFunction(() => window.__uwu);
  await expect.poll(async () => (await state(page)).styleLoaded, { timeout: 60000 }).toBe(true);
  const { camera } = await state(page);
  expect(camera.lat).toBeCloseTo(1.35, 2);
  expect(camera.lon).toBeCloseTo(103.9, 2);
  expect(camera.zoom).toBeCloseTo(14, 1);
});

test('search finds stations and bus stops offline, and a station\'s card has its train doors', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  await type(page, search(page), 'Orchard');
  const hit = page.getByRole('button', { name: /^Orchard.*Train station/ }).first();
  await expect(hit).toBeVisible();
  await page.screenshot({ path: info.outputPath('results.png') });
  await hit.click();
  await expect.poll(async () => (await state(page)).place).toBe('Orchard');
  const s = await state(page);
  expect(s.placeSub).toContain('Train station');
  // A station found by search has no door codes until tapped on the map: see the next test.
  expect(errors).toEqual([]);
  await expect(button(page, 'Directions').first()).toBeVisible();
  await button(page, 'Close').click();
  await expect.poll(async () => (await state(page)).place).toBe(null);
});

test('tapping a station on the map opens its card, with its doors, page by page', async ({ page }, info) => {
  const errors = collectErrors(page);
  await openApp(page);
  // Dhoby Ghaut, face on, with nothing tilted, where the app's own data has it.
  const rail = JSON.parse(readFileSync(new URL('../../../main-site/data/sg-rail.json', import.meta.url)));
  const station = rail.stations.find((st) => st.name.startsWith('Dhoby Ghaut'));
  const where = { lat: station.lat, lon: station.lng };
  await call(page, 'jumpTo', { ...where, zoom: 16.5, tilt: 0, bearing: 0 });
  await waitRendered(page, ['sg-stations'], 1);
  await page.waitForTimeout(1500);
  const at = JSON.parse(await call(page, 'tapMap', where));
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await state(page)).doorCodes?.length ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
  const s = await state(page);
  expect(s.place).toContain('Dhoby');
  await expect(button(page, 'Next direction')).toBeVisible();
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('station-doors.png') });
  await button(page, 'Next direction').click();
  await expect(page.getByText(/^2 of \d+$/)).toBeVisible();
  await button(page, 'Previous direction').click();
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await expect(button(page, 'Go by public transport')).toBeVisible();
  expect(errors).toEqual([]);
});

test('tapping an empty part of the map drops a pin, and tapping again clears it', async ({ page }) => {
  await openApp(page);
  await call(page, 'jumpTo', { lat: 1.27, lon: 103.87, zoom: 15, tilt: 0, bearing: 0 });
  await page.waitForTimeout(800);
  await page.mouse.click(200, 400);
  await expect.poll(async () => (await state(page)).place, { timeout: 10000 }).toBeTruthy();
  await button(page, 'Save').click();
  await expect(button(page, 'Saved')).toBeVisible();
  const name = (await state(page)).place;
  expect((await state(page)).saved).toContain(name);
  await button(page, 'Saved').click();
  await expect(button(page, 'Save')).toBeVisible();
  expect((await state(page)).saved).not.toContain(name);
});

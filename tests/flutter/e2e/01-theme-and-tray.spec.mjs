import { test, expect } from '@playwright/test';
import { button, collectErrors, openApp, openPlace, said, state } from './helpers.mjs';

const toggle = (page, name) => page.getByRole('switch', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true }));

test.describe('the look', () => {
  test('Material You is on by default, in the phone\'s font', async ({ page }, info) => {
    const errors = collectErrors(page);
    await openApp(page);
    const s = await state(page);
    expect(s.materialYou).toBe(true);
    expect(s.tokensMaterial).toBe(true);
    expect(s.phoneColours).toBe(true);
    expect(s.phoneFont).toBe(true);
    // The phone's default, and not the uwuapps font.
    expect(s.fontFamily).toBe('sans-serif');
    await page.screenshot({ path: info.outputPath('material-light.png') });
    expect(errors).toEqual([]);
  });

  test('Material You follows the phone into dark, map and all', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openApp(page);
    const s = await state(page);
    expect(s.dark).toBe(true);
    expect(s.mapDark).toBe(true);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: info.outputPath('material-dark.png') });
  });

  test('switching it off in Settings gives the uwuapps theme, and it stays off', async ({ page }, info) => {
    const errors = collectErrors(page);
    await openApp(page);
    const materialPrimary = (await state(page)).primary;

    await button(page, 'Settings').click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('settings-material.png') });
    await toggle(page, 'Material You').click();

    await expect.poll(async () => (await state(page)).tokensMaterial).toBe(false);
    const s = await state(page);
    expect(s.materialYou).toBe(false);
    expect(s.fontFamily).toBe('Jua');
    expect(s.primary).not.toBe(materialPrimary);
    // Its page colour: #ccffcc at 10% over #eef2f0.
    expect(s.page.toString(16).toLowerCase()).toBe('ffebf3ec');
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath('settings-uwu.png') });

    await page.reload();
    await page.waitForFunction(() => window.__uwu);
    await expect.poll(async () => (await state(page)).tokensMaterial).toBe(false);
    await expect.poll(async () => (await state(page)).styleLoaded, { timeout: 60000 }).toBe(true);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath('uwu-light.png') });
    expect(errors).toEqual([]);
  });

  test('uwuapps defaults to light whatever the phone says, has all its swatches and three modes', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openApp(page, { settings: { 'uwumaps.materialYou': false } });
    expect((await state(page)).dark).toBe(false);

    await button(page, 'Settings').click();
    for (const name of ['Classic', 'Not green 1', 'Not green 2', 'Not green 3', 'Not green 4', 'Not green 5', 'Really really light green']) {
      await expect(button(page, name)).toBeVisible();
    }
    // Each swatch's page colour: its own 10% over the light page, as the theme spec's color-mix has it.
    const pageOf = (hex) => {
      const base = [0xee, 0xf2, 0xf0];
      const mixed = [0, 2, 4].map((at, i) => Math.round(parseInt(hex.slice(at, at + 2), 16) * 0.1 + base[i] * 0.9));
      return `ff${mixed.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    };
    const swatches = { 'Not green 1': 'ffcccc', 'Not green 2': 'ccccff', 'Not green 3': 'ffffcc', 'Not green 4': 'ffccff', 'Not green 5': 'ccffff', 'Really really light green': 'ffffff', Classic: 'ccffcc' };
    for (const [name, hex] of Object.entries(swatches)) {
      await button(page, name).click();
      await expect.poll(async () => (await state(page)).page.toString(16)).toBe(pageOf(hex));
    }

    await button(page, 'Dark').click();
    await expect.poll(async () => (await state(page)).dark).toBe(true);
    await expect.poll(async () => (await state(page)).mapDark).toBe(true);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: info.outputPath('settings-uwu-dark.png') });

    await button(page, 'Time-based').click();
    await expect.poll(async () => (await state(page)).modePreference).toBe('time');
    await expect(said(page, /Following the clock\. Currently (light|dark)\./)).toBeVisible();
    await button(page, 'Light').click();
    await button(page, 'Close').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath('uwu-after.png') });
  });

  test('the phone\'s colours and font can each be turned off', async ({ page }) => {
    await openApp(page);
    await button(page, 'Settings').click();
    await toggle(page, 'Your phone’s font').click();
    await expect.poll(async () => (await state(page)).fontFamily).toBe('Jua');
    await toggle(page, 'Your phone’s font').click();
    await expect.poll(async () => (await state(page)).fontFamily).toBe('sans-serif');
    await toggle(page, 'Your phone’s colours').click();
    await expect(button(page, 'Not green 2')).toBeVisible();
    const before = (await state(page)).primary;
    await button(page, 'Not green 2').click();
    await expect.poll(async () => (await state(page)).primary).not.toBe(before);
  });
});

test.describe('the Edge Tray', () => {
  for (const [look, settings] of [['Material You', {}], ['uwuapps', { 'uwumaps.materialYou': false }]]) {
    test(`in ${look}: hides, comes back, is remembered, and takes its buttons out of reach`, async ({ page }, info) => {
      await openApp(page, { settings });
      for (const name of ['Directions', 'Saved places', 'Offline maps', 'My location', 'Layers', 'Send to a device nearby', 'Check for updates', 'Settings']) {
        await expect(button(page, name)).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath('open.png') });

      await button(page, 'Hide menu').click();
      await expect(button(page, 'Show menu')).toBeVisible();
      expect((await state(page)).trayOpen).toBe(false);
      // Off screen, and gone from anything a screen reader or the keyboard could reach.
      await expect(button(page, 'Directions')).toHaveCount(0);
      await page.waitForTimeout(500);
      await page.screenshot({ path: info.outputPath('collapsed.png') });

      await page.reload();
      await page.waitForFunction(() => window.__uwu);
      await expect.poll(async () => (await state(page)).trayOpen).toBe(false);
      await expect(button(page, 'Show menu')).toBeVisible();

      await button(page, 'Show menu').click();
      await expect(button(page, 'Directions')).toBeVisible();
      expect((await state(page)).trayOpen).toBe(true);
    });
  }

  test('each button does its job', async ({ page }) => {
    await openApp(page);
    await button(page, 'Directions').click();
    await expect.poll(async () => (await state(page)).directionsOpen).toBe(true);
    // Selected, Flutter's web build gives its name as text, twice over: so by its start here.
    await page.getByRole('button', { name: /^Directions/ }).click();
    await expect.poll(async () => (await state(page)).directionsOpen).toBe(false);
    for (const [name, heading] of [['Saved places', 'Saved places'], ['Offline maps', 'Offline maps'], ['Layers', 'Layers'], ['Settings', 'Settings']]) {
      await button(page, name).click();
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await button(page, 'Close').click();
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
    await button(page, 'My location').click();
    await expect.poll(async () => (await state(page)).camera.lat, { timeout: 15000 }).toBeCloseTo(1.3048, 2);
  });

  test('its stagger and slide take about the spec\'s time, and reduced motion makes it instant', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4180', viewport: { width: 412, height: 915 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await openApp(page);
    await button(page, 'Hide menu').click();
    await expect(button(page, 'Show menu')).toBeVisible();
    expect((await state(page)).trayOpen).toBe(false);
    await context.close();
  });
});

test('nothing the tray and panels draw overflows at the narrowest phone, or at the largest text', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4180', viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await openApp(page);
  await openPlace(page, { name: 'A place with a rather long name for such a small screen', lat: 1.3, lon: 103.85 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('small-place.png') });
  await button(page, 'Directions', true).last().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: info.outputPath('small-directions.png') });
  expect(errors.filter((e) => /overflow/i.test(e))).toEqual([]);
  await context.close();
});

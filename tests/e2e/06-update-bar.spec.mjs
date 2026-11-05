// The update bar, checked the way docs/update-bar-spec.md asks: a real worker, a real new version.
import { expect, test } from '@playwright/test';
import { openApp, quietThirdParties, waitForServiceWorker } from './helpers.mjs';

const swVersion = (page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return { active: Boolean(reg.active), waiting: Boolean(reg.waiting) };
});

test('a new version waits, Not now holds it off, and Reload brings it in once', async ({ browser, request }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(context);
  const page = await context.newPage();
  await openApp(page);
  await waitForServiceWorker(page);
  await expect(page.locator('.update-notice')).toHaveCount(0);

  // The tab left open across a deploy: the updatefound path.
  await request.get('/__test/bump');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect(page.locator('.update-notice')).toContainText('A new version of uwuMaps is ready.', { timeout: 60000 });
  await expect(page.locator('.update-notice')).toHaveAttribute('role', 'status');
  expect((await swVersion(page)).waiting).toBe(true);

  // Nothing has moved on its own, and the tray has moved down for the bar.
  const trayTop = await page.locator('.hud-right').evaluate((el) => el.getBoundingClientRect().top);
  const barHeight = await page.locator('.update-notice').evaluate((el) => el.offsetHeight);
  expect(trayTop).toBeGreaterThanOrEqual(barHeight);

  await page.click('[data-sw-later]');
  await expect(page.locator('.update-notice')).toHaveCount(0);
  expect((await swVersion(page)).waiting).toBe(true);

  // The worker already waiting on the next view: the path most people meet.
  await page.reload();
  await expect(page.locator('.update-notice')).toContainText('A new version of uwuMaps is ready.', { timeout: 30000 });

  let loads = 0;
  page.on('load', () => loads++);
  await page.click('[data-sw-update]');
  await page.waitForLoadState('load');
  await expect(page.locator('.update-notice')).toHaveCount(0, { timeout: 30000 });
  await page.waitForTimeout(1500);
  expect(loads).toBe(1);
  const after = await swVersion(page);
  expect(after).toEqual({ active: true, waiting: false });
  await context.close();
});

test('keeps pack, tile and font caches across a new version', async ({ browser, request }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  await quietThirdParties(context);
  const page = await context.newPage();
  await openApp(page);
  await waitForServiceWorker(page);
  await page.evaluate(async () => {
    const pack = await caches.open('uwumaps-pack-singapore');
    await pack.put('/packs/singapore.json', new Response('{}'));
  });
  await request.get('/__test/bump');
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect(page.locator('.update-notice')).toContainText('ready', { timeout: 60000 });
  await page.click('[data-sw-update]');
  await page.waitForLoadState('load');
  await expect(page.locator('.update-notice')).toHaveCount(0, { timeout: 30000 });
  const names = await page.evaluate(() => caches.keys());
  expect(names).toContain('uwumaps-pack-singapore');
  expect(names.filter((n) => n.startsWith('uwumaps-shell-'))).toHaveLength(1);
  await context.close();
});

import { expect } from '@playwright/test';

// Kept for the tests' readability. Ads and analytics are blocked in playwright.config.mjs, at the
// browser's DNS: Playwright bypasses service workers in any context that has routes.
export async function quietThirdParties() {}

// Collects what went wrong on a page, leaving out network failures the tests cause on purpose.
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ABORTED|Failed to load resource/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

export async function openApp(page, path = '/') {
  await page.goto(path);
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await waitForMapIdle(page);
}

// Polled from here rather than with waitForFunction, which takes an async function's promise as a
// truthy answer and returns at once. The page exposes nothing for tests, so the map is reached through
// the module it came from.
export async function waitForMapIdle(page) {
  await expect.poll(() => page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    return Boolean(map && map.isStyleLoaded() && map.areTilesLoaded());
  }), { timeout: 60000, intervals: [500] }).toBe(true);
}

export async function jumpTo(page, view) {
  await page.evaluate(async (v) => {
    const { getMap } = await import('/js/map.js');
    getMap().jumpTo(v);
  }, view);
  await waitForMapIdle(page);
}

// How many features of these layers are drawn on screen now.
export async function rendered(page, layers) {
  return page.evaluate(async (ids) => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    const present = ids.filter((id) => map.getLayer(id));
    return present.length ? map.queryRenderedFeatures({ layers: present }).length : 0;
  }, layers);
}

// Waits until the service worker has installed, then loads the page under it. It never claims a page
// that's already open, so it has to have finished activating before this reloads.
export async function waitForServiceWorker(page) {
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.state || 'none';
  }), { timeout: 60000, intervals: [500] }).toBe('activated');
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#map canvas'));
}

export async function downloadSingapore(page) {
  await page.click('#packsBtn');
  const row = page.locator('[data-pack="singapore"]');
  await row.getByRole('button', { name: 'Download' }).click();
  await expect(row.locator('.pack-sub')).toContainText('Saved', { timeout: 120000 });
  await page.click('[data-close-modal="packsModal"]');
}

import { expect } from '@playwright/test';

// Flutter draws on a canvas, so a test sees the app through what screen readers do (the semantics tree,
// where every control is a real role and name) and through window.__uwu (lib/main.dart).

export const state = (page) => page.evaluate(() => JSON.parse(window.__uwu.state()));
export const call = (page, method, arg = '') => page.evaluate(([m, a]) => window.__uwu.call(m, typeof a === 'string' ? a : JSON.stringify(a)), [method, arg]);

// Collects what went wrong on a page, leaving out network failures the tests cause on purpose.
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ABORTED|Failed to load resource|WebGL/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

// The world outside the test server, stubbed, so runs don't depend on it or trouble it.
export async function quietOutside(page) {
  await page.route(/photon\.komoot\.io/, (route) => route.fulfill({ json: { features: [] } }));
  await page.route(/routing\.openstreetmap\.de/, (route) => route.abort());
  await page.route(/tiles\.openfreemap\.org|overturemaps/, (route) => route.abort());
}

// Opens the app. `settings` are put in storage first, as a returning user's would be.
export async function openApp(page, { path = '/', settings = {} } = {}) {
  await quietOutside(page);
  await page.addInitScript((s) => {
    // Flutter's shared_preferences keeps strings JSON-quoted under flutter. in localStorage.
    if (window.__seeded) return;
    window.__seeded = true;
    for (const [k, v] of Object.entries(s)) {
      if (localStorage.getItem(`flutter.${k}`) == null) localStorage.setItem(`flutter.${k}`, JSON.stringify(v));
    }
  }, settings);
  await page.goto(path);
  await page.waitForFunction(() => window.__uwu, null, { timeout: 60000 });
  // On a phone the credit is MapLibre Native's small button. The browser's lies open over the bottom of the screen.
  await page.addStyleTag({ content: '.maplibregl-ctrl-attrib { display: none !important; }' });
  await expect.poll(async () => (await state(page)).styleLoaded, { timeout: 60000, intervals: [500] }).toBe(true);
}

export const button = (page, name, exact = true) => page.getByRole('button', { name, exact });

// Waits till the map has drawn something of these layers.
export async function waitRendered(page, layers, atLeast = 1) {
  await expect.poll(async () => Number(await call(page, 'rendered', layers)), { timeout: 60000, intervals: [1000] }).toBeGreaterThanOrEqual(atLeast);
}

// Text on screen. A live region says it a second time, for screen readers, so this looks at the last.
export const said = (page, text) => page.getByText(text).or(page.getByLabel(text)).last();

// A place's card, up. The tray has a Directions button too, so its own is the last.
export async function openPlace(page, place) {
  await call(page, 'showPlace', place);
  await expect(page.getByRole('heading', { name: place.name })).toBeVisible();
}

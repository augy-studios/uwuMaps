// The map itself: coloured 3D buildings, the layers sheet, Singapore's and Malaysia's public transport.
import { expect, test } from '@playwright/test';
import { collectErrors, jumpTo, openApp, quietThirdParties, rendered, waitForMapIdle } from './helpers.mjs';

test.beforeEach(async ({ context }) => quietThirdParties(context));

test('3D buildings draw in colour, from Overture, online', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page);
  await expect.poll(() => rendered(page, ['buildings-walls', 'parts-walls']), { timeout: 60000 }).toBeGreaterThan(50);
  await waitForMapIdle(page);

  const colours = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const features = getMap().queryRenderedFeatures({ layers: ['buildings-walls', 'parts-walls'] });
    const stated = features.filter((f) => f.properties.facade_color || f.properties.roof_color).length;
    const typed = features.filter((f) => f.properties.subtype).length;
    const tall = features.filter((f) => Number(f.properties.height) > 50).length;
    return { total: features.length, stated, typed, tall };
  });
  expect(colours.stated, JSON.stringify(colours)).toBeGreaterThan(0);
  expect(colours.tall, JSON.stringify(colours)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/buildings-light.png' });
});

// In the order they're drawn: a flat layer after the 3D ones paints over them, while still counting as
// rendered, so only this shows it.
const buildingsAboveFlatLayers = (page) => page.evaluate(async () => {
  const { getMap } = await import('/js/map.js');
  const { layers } = getMap().getStyle();
  const first = layers.findIndex((l) => l.type === 'fill-extrusion');
  return layers.slice(first).filter((l) => l.source === 'openmaptiles' && l.type !== 'symbol').map((l) => l.id);
});

test('changing to dark mode redraws everything over the dark map', async ({ page }) => {
  await openApp(page);
  await expect.poll(() => rendered(page, ['buildings-walls', 'parts-walls']), { timeout: 60000 }).toBeGreaterThan(0);
  expect(await buildingsAboveFlatLayers(page)).toEqual([]);
  await page.click('#themeBtn');
  await page.click('#modeToggle [data-mode="dark"]');
  await page.click('[data-close-modal="themeModal"]');
  await waitForMapIdle(page);
  await expect.poll(() => rendered(page, ['buildings-walls', 'parts-walls']), { timeout: 60000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['sg-stations']), { timeout: 30000 }).toBeGreaterThan(0);
  expect(await buildingsAboveFlatLayers(page)).toEqual([]);
  await waitForMapIdle(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/buildings-dark.png' });
});

test('the layers sheet turns each layer off and on, and remembers', async ({ page }) => {
  await openApp(page);
  await expect.poll(() => rendered(page, ['sg-lines']), { timeout: 30000 }).toBeGreaterThan(0);
  await page.click('#layersBtn');
  await expect(page.locator('#layersModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('#layersList .switch')).toHaveCount(11);

  const visibility = (id) => page.evaluate(async (layer) => {
    const { getMap } = await import('/js/map.js');
    return getMap().getLayoutProperty(layer, 'visibility');
  }, id);

  await page.locator('[data-layer="sg-lines"]').uncheck();
  expect(await visibility('sg-lines')).toBe('none');
  await page.locator('[data-layer="buildings"]').uncheck();
  expect(await visibility('buildings-walls')).toBe('none');
  expect(await visibility('parts-roofs')).toBe('none');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  await waitForMapIdle(page);
  expect(await visibility('sg-lines')).toBe('none');
  await page.click('#layersBtn');
  await expect(page.locator('[data-layer="sg-lines"]')).not.toBeChecked();
  await page.locator('[data-layer="sg-lines"]').check();
  expect(await visibility('sg-lines')).toBe('visible');
});

test('Singapore: stations, exits, stops and doors, handing over to SG Bus Timings', async ({ page }) => {
  await openApp(page);
  await jumpTo(page, { center: [103.8519, 1.2835], zoom: 16.5, pitch: 0, bearing: 0 });
  await expect.poll(() => rendered(page, ['sg-stations']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['sg-exits']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['sg-stops']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['sg-lines']), { timeout: 30000 }).toBeGreaterThan(0);

  // Raffles Place: tap the station itself.
  const point = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    const f = map.queryRenderedFeatures({ layers: ['sg-stations'] }).find((x) => x.properties.name === 'Raffles Place');
    return f ? map.project(f.geometry.coordinates) : null;
  });
  expect(point).not.toBeNull();
  await page.locator('#map canvas').click({ position: { x: point.x, y: point.y } });
  await expect(page.locator('#placeName')).toHaveText('Raffles Place');
  await expect(page.locator('#placeSub')).toContainText('NS26');

  const link = page.locator('#placeLinks a', { hasText: 'Go by public transport' });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^https:\/\/sgbus\.uwuapps\.org\/#nav\/here\/1\.28\d+,103\.85\d+~Raffles%20Place%20MRT$/);
  expect(await link.getAttribute('target')).toBe('_blank');

  await page.locator('#placeDetail summary').click();
  await expect(page.locator('#placeDetail .door-dir').first()).toContainText('towards');
  await expect(page.locator('#placeDetail .door-list li').first()).toContainText(/door/);
});

test('Singapore: a bus stop card links to its timings', async ({ page }) => {
  await openApp(page);
  await jumpTo(page, { center: [103.85253, 1.29684], zoom: 18, pitch: 0, bearing: 0 });
  await expect.poll(() => rendered(page, ['sg-stops']), { timeout: 30000 }).toBeGreaterThan(0);
  const point = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    const f = map.queryRenderedFeatures({ layers: ['sg-stops'] }).find((x) => x.properties.code === '01012');
    return f ? map.project(f.geometry.coordinates) : null;
  });
  expect(point).not.toBeNull();
  await page.locator('#map canvas').click({ position: { x: point.x, y: point.y } });
  await expect(page.locator('#placeSub')).toContainText('01012');
  expect(await page.locator('#placeLinks a', { hasText: 'Bus timings' }).getAttribute('href')).toBe('https://sgbus.uwuapps.org/#01012');
  expect(await page.locator('#placeLinks a', { hasText: 'Go by public transport' }).getAttribute('href')).toContain('https://sgbus.uwuapps.org/#nav/here/');
});

test('Malaysia: lines, stations and live vehicles, handing over to the Malaysia site', async ({ page }) => {
  let asked = 0;
  await page.route(/\/api\/my-live\?feed=/, (route) => {
    asked++;
    const feed = new URL(route.request().url()).searchParams.get('feed');
    const vehicles = feed === 'ktmb'
      ? [{ id: 'T1', route: 'KTM1', lat: 3.1395, lon: 101.6869, bearing: 90, at: Math.floor(Date.now() / 1000) - 60 }]
      : feed === 'rapid-bus-kl'
        ? [{ id: 'WVB123', route: 'U80', lat: 3.1450, lon: 101.6950, bearing: 180, at: Math.floor(Date.now() / 1000) - 30 }]
        : [];
    route.fulfill({ json: { feed, at: 0, vehicles } });
  });
  await openApp(page);
  await jumpTo(page, { center: [101.6900, 3.1420], zoom: 14, pitch: 0, bearing: 0 });
  await expect.poll(() => rendered(page, ['my-stations']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['my-lines']), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(() => rendered(page, ['my-live-trains']), { timeout: 30000 }).toBe(1);
  await expect.poll(() => rendered(page, ['my-live-buses']), { timeout: 30000 }).toBe(1);
  expect(asked).toBeGreaterThan(0);

  const point = await page.evaluate(async () => {
    const { getMap } = await import('/js/map.js');
    const map = getMap();
    return map.project(map.queryRenderedFeatures({ layers: ['my-live-buses'] })[0].geometry.coordinates);
  });
  await page.locator('#map canvas').click({ position: { x: point.x, y: point.y } });
  await expect(page.locator('#placeName')).toHaveText('Bus U80');
  await expect(page.locator('#placeSub')).toContainText('WVB123');
  await expect(page.locator('#placeSub')).toContainText('min ago');
  expect(await page.locator('#placeLinks a').first().getAttribute('href')).toBe('https://malaysia.uwuapps.org/bus/');
  await page.screenshot({ path: 'test-results/malaysia-live.png' });
});

test('nothing of Malaysia loads while looking only at Singapore', async ({ page }) => {
  const asked = [];
  page.on('request', (r) => {
    if (/my-live|my-transit/.test(r.url())) asked.push(r.url());
  });
  await openApp(page);
  await page.waitForTimeout(1500);
  expect(asked).toEqual([]);
});

test('one lookup of the Overture release, however many tiles ask at once', async ({ page }) => {
  let lookups = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/overture')) lookups++;
  });
  await openApp(page);
  await expect.poll(() => rendered(page, ['buildings-walls', 'parts-walls']), { timeout: 60000 }).toBeGreaterThan(0);
  expect(lookups).toBe(1);
});

test('live feeds are not asked for from outside Malaysia, or when turned off', async ({ page }) => {
  const asked = [];
  await page.route(/\/api\/my-live\?feed=/, (route) => {
    asked.push(route.request().url());
    route.fulfill({ json: { feed: 'x', at: 0, vehicles: [] } });
  });
  await page.addInitScript(() => localStorage.setItem('uwumaps.view', JSON.stringify({ center: [2.35, 48.85], zoom: 14, pitch: 0, bearing: 0 })));
  await openApp(page);
  await page.waitForTimeout(1500);
  expect(asked).toEqual([]);

  await page.click('#layersBtn');
  await page.locator('[data-layer="my-live-trains"]').uncheck();
  await page.locator('[data-layer="my-live-buses"]').uncheck();
  await page.click('[data-close-modal="layersModal"]');
  await jumpTo(page, { center: [101.69, 3.142], zoom: 13 });
  await page.waitForTimeout(1500);
  expect(asked).toEqual([]);
});

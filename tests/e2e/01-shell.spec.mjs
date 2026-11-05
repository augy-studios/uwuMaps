// The theme, time based mode, the Edge Tray and the rules every file has to keep.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { collectErrors, openApp, quietThirdParties } from './helpers.mjs';

test.beforeEach(async ({ context }) => quietThirdParties(context));

test('loads with no errors, in light and classic, even with the OS in dark mode', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  await quietThirdParties(context);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await openApp(page);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-mode', 'light');
  await expect(root).toHaveAttribute('data-color-theme', 'classic');
  await expect(page).toHaveTitle('uwuMaps | UwU Apps');
  expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Explore cities in colourful 3D and find your way on foot, by bike or by car.');
  expect(errors).toEqual([]);
  await context.close();
});

test('every swatch and mode applies, stays after a reload, and the modal stays open', async ({ page }) => {
  await openApp(page);
  await page.click('#themeBtn');
  await expect(page.locator('#swatchGrid .swatch')).toHaveCount(7);
  await page.click('[data-theme-id="not-green-2"]');
  await page.click('#modeToggle [data-mode="dark"]');
  await expect(page.locator('#themeModal')).not.toHaveClass(/hidden/);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#ccccff');
  await expect(page.locator('#themeBtn [data-icon]')).toHaveAttribute('data-icon', 'moon');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-theme', 'not-green-2');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});

test('text stays readable in all 14 combinations', async ({ page }) => {
  await openApp(page);
  const worst = await page.evaluate(async () => {
    const { COLOR_THEMES, applyColorTheme, applyMode } = await import('/js/theme.js');
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    canvas.canvas.width = 4;
    canvas.canvas.height = 4;
    const toRgb = (css, over = [255, 255, 255]) => {
      canvas.fillStyle = `rgb(${over.join(',')})`;
      canvas.fillRect(0, 0, 4, 4);
      canvas.fillStyle = css;
      canvas.fillRect(0, 0, 4, 4);
      return [...canvas.getImageData(1, 1, 1, 1).data].slice(0, 3);
    };
    const lum = (c) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    const probe = document.createElement('div');
    document.body.append(probe);
    const resolve = (name) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    let out = { ratio: 99 };
    for (const t of COLOR_THEMES) {
      for (const mode of ['light', 'dark']) {
        applyColorTheme(t.id);
        applyMode(mode);
        const bg = toRgb(resolve('--bg'));
        // The worst a floating panel can sit over, map colours aside: its own base colour.
        const panel = toRgb(resolve('--panel'), bg);
        const pairs = [
          ['--ink on panel', toRgb(resolve('--ink'), panel), panel],
          ['--brand-ink on panel', toRgb(resolve('--brand-ink'), panel), panel],
          ['--muted-strong on panel', toRgb(resolve('--muted-strong'), panel), panel],
          ['--on-brand on fill', toRgb(resolve('--on-brand')), toRgb(resolve('--brand-fill'), panel)],
        ];
        for (const [name, fg, back] of pairs) {
          const r = ratio(fg, back);
          if (r < out.ratio) out = { ratio: r, name, theme: t.id, mode };
        }
      }
    }
    probe.remove();
    return out;
  });
  expect(worst.ratio, JSON.stringify(worst)).toBeGreaterThanOrEqual(4.5);
});

test('time based mode: dark in the evening from first paint, and the choice survives', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-06T20:30:00'));
  await page.addInitScript(() => localStorage.setItem('uwumaps.mode', 'time'));
  await page.goto('/');
  // Read before the modules run: this is the pre-paint script's work.
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-mode-preference', 'time');
  await page.click('#themeBtn');
  await expect(page.locator('#modeToggle [data-mode="time"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#modeNote')).toHaveText('Following the clock. Currently dark.');
  expect(await page.evaluate(() => localStorage.getItem('uwumaps.mode'))).toBe('time');
});

test('time based mode: a tab left open past a boundary changes by itself', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-06T17:59:00') });
  await page.addInitScript(() => localStorage.setItem('uwumaps.mode', 'time'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  await page.click('#themeBtn');
  await page.clock.fastForward('02:30');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await expect(page.locator('#modeNote')).toHaveText('Following the clock. Currently dark.');
});

test('the tray collapses, leaves the tab order, remembers, and lets clicks through', async ({ page }) => {
  await openApp(page);
  const tab = page.locator('#trayTab');
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-label', 'Show menu');
  expect(await page.locator('#trayButtons').evaluate((el) => el.inert)).toBe(true);
  // Until it's slid home: the map in 3D with no GPU can hold the animation up well past its 0.34s.
  await expect.poll(async () => {
    const box = await tab.boundingBox();
    return Math.round(box.x + box.width);
  }).toBe(1280);

  await page.reload();
  await expect(page.locator('#trayTab')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.body.classList.contains('tray-open'))).toBe(false);

  await page.locator('#trayTab').click();
  await expect(page.locator('#directionsBtn')).toBeVisible();
  // The tray's container must not swallow clicks around its buttons.
  expect(await page.locator('.hud-right').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
});

test('the tray opens with storage blocked', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key) {
      if (String(key).endsWith('.trayOpen')) throw new Error('blocked');
      return original.call(this, key);
    };
  });
  await page.goto('/');
  await expect(page.locator('#trayTab')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#trayTab').click();
  await expect(page.locator('#trayTab')).toHaveAttribute('aria-expanded', 'false');
});

test('at phone width the tray fits and nothing runs under it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  await quietThirdParties(context);
  const page = await context.newPage();
  await openApp(page);
  const btn = await page.locator('#directionsBtn').boundingBox();
  expect(Math.round(btn.width)).toBe(40);
  expect(Math.round(360 - (btn.x + btn.width))).toBe(10);
  const search = await page.locator('.searchbox').boundingBox();
  const tab = await page.locator('#trayTab').boundingBox();
  expect(search.x + search.width).toBeLessThanOrEqual(tab.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  // Every button fits above the bottom of the screen.
  const last = await page.locator('#themeBtn').boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(740);
  await context.close();
});

/* ---- rules about the code itself ---- */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'vendor', '.git', '.fixture', 'docs', 'images', 'map', 'data', 'test-results'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|mjs|css|html|json|sql|md|yml)$/.test(name) && !/package-lock|^404|LICENSE|CODE_OF_CONDUCT/.test(name)) out.push(path);
  }
  return out;
}

test('no em dashes, emoji or gradients, and no hex below the theme tokens', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const files = walk(ROOT).filter((f) => !f.includes('tests'));
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    expect(text.includes('—'), `em dash in ${file}`).toBe(false);
    // Only the copyright sign's pictographic neighbours are allowed; none of those are in the code.
    const found = [...text].find((c) => emoji.test(c) && c !== '©');
    expect(found, `emoji in ${file}`).toBeUndefined();
  }
  const css = readFileSync(join(ROOT, 'main-site/style.css'), 'utf8');
  expect(css).not.toMatch(/gradient\(/);
  const below = css.slice(css.indexOf('/* flat, static colour'));
  expect(below.match(/#[0-9a-f]{3,8}\b(?=[^{}]*;)/gi)).toBeNull();
  expect(css).not.toMatch(/font-family:(?!\s*"Jua")/);
});

test('the worker only ever skips waiting when asked, and precaches what exists', () => {
  const sw = readFileSync(join(ROOT, 'main-site/sw.js'), 'utf8');
  const withoutComments = sw.replace(/\/\/.*$/gm, '');
  expect(withoutComments.match(/skipWaiting\(\)/g)).toHaveLength(1);
  expect(withoutComments.match(/clients\.claim\(\)/g)).toHaveLength(1);
  expect(withoutComments.indexOf('skipWaiting()')).toBeGreaterThan(withoutComments.indexOf('addEventListener("message"'));
  const listed = [...sw.matchAll(/^\s+"(\/[^"]+)",$/gm)].map((m) => m[1]).filter((p) => p !== '/');
  expect(listed.length).toBeGreaterThan(30);
  for (const path of listed) expect(() => statSync(join(ROOT, 'main-site', path)), path).not.toThrow();
  // Every module the app has is in the list, so none goes missing offline.
  for (const name of readdirSync(join(ROOT, 'main-site/js'))) expect(listed, name).toContain(`/js/${name}`);
});

test('the STUN build holds no TURN relay', () => {
  for (const f of ['main-site/vendor/peerjs/peerjs.min.js', 'main-site/js/p2p.js']) {
    expect(readFileSync(join(ROOT, f), 'utf8')).not.toMatch(/turns?:/);
  }
});

test('the manifest names icons that exist and a description that says little', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'main-site/manifest.json'), 'utf8'));
  for (const icon of m.icons) expect(() => statSync(join(ROOT, 'main-site', icon.src))).not.toThrow();
  expect(m.description).toBe('Explore cities in colourful 3D and find your way on foot, by bike or by car.');
  expect(m.description).not.toMatch(/\b(ads?|offline|free)\b/i);
});

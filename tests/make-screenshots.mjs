// Takes the manifest's screenshots of the real app, at the sizes the manifest states. With
// tests/dev-server.mjs running: node tests/make-screenshots.mjs

import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = fileURLToPath(new URL('../main-site/images/', import.meta.url));
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--host-resolver-rules=MAP www.googletagmanager.com ~NOTFOUND, MAP pagead2.googlesyndication.com ~NOTFOUND'],
});

const shots = [
  { file: 'screenshot_1.png', viewport: { width: 360, height: 780 }, scale: 3, mobile: true },
  { file: 'screenshot_2.png', viewport: { width: 1920, height: 1080 }, scale: 1, mobile: false },
];

for (const shot of shots) {
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: shot.scale, isMobile: shot.mobile, hasTouch: shot.mobile });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForFunction(() => document.querySelector('#map canvas'));
  for (let i = 0; i < 90; i++) {
    const idle = await page.evaluate(async () => {
      const { getMap } = await import('/js/map.js');
      const map = getMap();
      return Boolean(map && map.isStyleLoaded() && map.areTilesLoaded());
    });
    if (idle) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}${shot.file}` });
  await context.close();
  console.log(`Took ${shot.file}`);
}
await browser.close();

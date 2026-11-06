#!/usr/bin/env node
// Makes the launcher icons and the splash from main-site/MAP-main.png. The art already sits on its own flat
// colour with room around it, so the adaptive foreground is the whole picture: the launcher's mask leaves
// the pin and the map whole. Run once, and again if the icon changes. Needs main-site's sharp.
//
//   node android/tool/make-icons.mjs

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const sharp = createRequire(here('../../main-site/package.json'))('sharp');
const SOURCE = here('../../main-site/MAP-main.png');
const RES = here('../android/app/src/main/res/');

const round = (px) => Buffer.from(`<svg width="${px}" height="${px}"><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}"/></svg>`);

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, scale] of Object.entries(DENSITIES)) {
  const dir = `${RES}mipmap-${name}/`;
  mkdirSync(dir, { recursive: true });
  const legacy = Math.round(48 * scale);
  const layer = Math.round(108 * scale);
  await sharp(SOURCE).resize(legacy, legacy).png().toFile(`${dir}ic_launcher.png`);
  await sharp(SOURCE).resize(legacy, legacy).composite([{ input: round(legacy), blend: 'dest-in' }]).png().toFile(`${dir}ic_launcher_round.png`);
  await sharp(SOURCE).resize(layer, layer).png().toFile(`${dir}ic_launcher_foreground.png`);
}
mkdirSync(`${RES}drawable-nodpi`, { recursive: true });
// Android draws it at up to 288 dp, and only the middle two thirds show. Never upscaled, so at the source's
// own 1024 px rather than the spec's 1152.
await sharp(SOURCE).png().toFile(`${RES}drawable-nodpi/splash_icon.png`);
console.log('Icons made');

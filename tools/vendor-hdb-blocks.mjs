#!/usr/bin/env node
// Refreshes tools/packs/data/hdb-blocks.json from HDB Property Information on data.gov.sg (Singapore Open
// Data Licence), which says which HDB blocks hold flats and which have shops on the ground floor. Neither
// is in OpenStreetMap reliably, and tools/packs/lib/void-decks.mjs needs both. Blocks rarely change, so a
// snapshot goes in the repository, and the pack builds don't depend on data.gov.sg being up.
//
//   node tools/vendor-hdb-blocks.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE = 'd_17f5382f26140b1fdae0ba2ef6239d2f';
const PAGE = 2000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'packs', 'data', 'hdb-blocks.json');

async function page(offset) {
  const url = `https://data.gov.sg/api/action/datastore_search?resource_id=${RESOURCE}&limit=${PAGE}&offset=${offset}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    // Its rate limit is low, and says so with a 429.
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 6000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`data.gov.sg answered ${res.status}`);
    const body = await res.json();
    if (!body.success) throw new Error('data.gov.sg said no');
    return body.result;
  }
}

const rows = [];
for (;;) {
  const { records, total } = await page(rows.length);
  rows.push(...records);
  if (!records.length || rows.length >= total) break;
  await new Promise((r) => setTimeout(r, 1500));
}

// Blocks by street, as HDB spells them: flats with a clear ground floor, and those with shops or a market.
const add = (into, row) => {
  (into[row.street] ||= []).push(row.blk_no);
};
const open = {};
const shops = {};
for (const row of rows) {
  if (row.residential !== 'Y') continue;
  add(row.commercial === 'Y' || row.market_hawker === 'Y' ? shops : open, row);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ source: 'HDB Property Information, data.gov.sg, Singapore Open Data Licence', fetched: new Date().toISOString().slice(0, 10), open, shops })}\n`);
console.log(`${rows.length} blocks read, ${Object.values(open).flat().length} open and ${Object.values(shops).flat().length} with shops, to ${OUT}`);

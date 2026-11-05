// Runs the migrations against a real Postgres (PGlite), since the files can't be edited once run.
// node tests/unit/migrations-check.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
// As Supabase has them: only service_role gets past row level security.
await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
await db.exec('grant usage on schema public to anon, authenticated, service_role;');

const dir = new URL('../../migrations/', import.meta.url);
const files = readdirSync(dir).sort();
for (const f of files) {
  await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  console.log('ran', f);
}
// A second time: "run once" shouldn't break the database if somebody runs one again.
for (const f of files) await db.exec(readFileSync(new URL(f, dir), 'utf8'));

await db.exec('set role service_role');
const bump = async () => (await db.query("select public.uwumaps_bump_rate('t', 60) as n")).rows[0].n;
if ((await bump()) !== 1 || (await bump()) !== 2) throw new Error('The rate limit did not count');
await db.query("insert into public.uwumaps_share_links (id, kind, data) values ('abcdefghij', 'list', '{}')");
await db.query('insert into public.uwumaps_sync (code_hash) values ($1)', ['a'.repeat(64)]);
await db.exec('reset role');

await db.exec('set role anon');
for (const sql of ['select * from public.uwumaps_share_links', 'select * from public.uwumaps_sync', "select public.uwumaps_bump_rate('x', 60)"]) {
  let refused = false;
  try {
    await db.query(sql);
  } catch {
    refused = true;
  }
  if (!refused) throw new Error(`anon was allowed: ${sql}`);
}
console.log('Migrations ran, and the anon role is refused');
await db.close();

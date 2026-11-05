// What the tests run the site on: main-site served the way Vercel would, its API routes included, with
// Supabase and the GitHub release stood in for locally, so the whole thing runs with no accounts.
//
//   /__supabase/rest/v1/*   A small stand-in for PostgREST, covering the queries the API makes. The
//                           real tables are checked separately by tests/unit/migrations-check.mjs.
//   /__release/*            The pack built by tests/build-fixture.mjs, with Range support.
//   /__test/bump            Changes sw.js as a deploy would, for testing the update bar.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 4173);
const ROOT = fileURLToPath(new URL('../main-site/', import.meta.url));
const RELEASE = fileURLToPath(new URL('./.fixture/release/', import.meta.url));

process.env.SUPABASE_URL = `http://127.0.0.1:${PORT}/__supabase`;
process.env.SUPABASE_SERVICE_KEY = 'sb_secret_test';
process.env.MAP_RELEASE_URL = `http://127.0.0.1:${PORT}/__release`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pbf': 'application/x-protobuf',
};

let swBump = 0;

/* ---- the Supabase stand-in ---- */

const tables = { uwumaps_share_links: new Map(), uwumaps_sync: new Map() };
const rates = new Map();

function matches(row, params) {
  for (const [k, v] of params) {
    if (['select', 'limit', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|lt|gt)\.(.*)$/s.exec(v);
    if (!m) continue;
    const have = row[k];
    if (m[1] === 'eq' && String(have) !== m[2]) return false;
    if (m[1] === 'lt' && !(have && Date.parse(have) < Date.parse(m[2]))) return false;
    if (m[1] === 'gt' && !(have && Date.parse(have) > Date.parse(m[2]))) return false;
  }
  return true;
}

function supabase(req, res, url, body) {
  const path = url.pathname.replace('/__supabase/rest/v1/', '');
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(value === undefined ? '' : JSON.stringify(value));
  };
  if (path === 'rpc/uwumaps_bump_rate') {
    // As the real function does: the count starts again once the window is over.
    const now = Date.now();
    const had = rates.get(body.p_key);
    const entry = had && had.until > now ? { ...had, n: had.n + 1 } : { n: 1, until: now + body.window_seconds * 1000 };
    rates.set(body.p_key, entry);
    return json(200, entry.n);
  }
  const table = tables[path];
  if (!table) return json(404, { message: `No table ${path}` });
  const key = path === 'uwumaps_sync' ? 'code_hash' : 'id';
  const params = [...url.searchParams];
  const rows = () => [...table.values()].filter((r) => matches(r, params));

  if (req.method === 'GET') return json(200, rows());
  if (req.method === 'POST') {
    const upsert = (req.headers.prefer || '').includes('merge-duplicates');
    if (!upsert && table.has(body[key])) return json(409, { code: '23505', message: 'duplicate key' });
    table.set(body[key], { updated_at: new Date().toISOString(), ...table.get(body[key]), ...body });
    return json(201);
  }
  if (req.method === 'PATCH') {
    const hit = rows();
    for (const r of hit) Object.assign(r, body);
    return json(200, hit);
  }
  if (req.method === 'DELETE') {
    for (const r of rows()) table.delete(r[key]);
    return json(204);
  }
  return json(405, {});
}

/* ---- the release stand-in ---- */

function release(req, res, url) {
  const file = join(RELEASE, decodeURIComponent(url.pathname.replace('/__release/', '')));
  if (!file.startsWith(RELEASE) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const { size } = statSync(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { 'Content-Length': size });
    return createReadStream(file).pipe(res);
  }
  const start = Number(range[1]);
  if (start >= size) {
    res.writeHead(416);
    return res.end();
  }
  const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  return createReadStream(file, { start, end }).pipe(res);
}

/* ---- Vercel's shape for an API route ---- */

function shim(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value) => {
    res.end(value);
    return res;
  };
  return res;
}

async function apiRoute(req, res, url, body) {
  const name = url.pathname.replace('/api/', '');
  const file = join(ROOT, 'api', `${name}.js`);
  if (!/^[a-z-]+$/.test(name) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  const { default: handler } = await import(pathToFileURL(file).href);
  req.query = Object.fromEntries(url.searchParams);
  req.body = body;
  return handler(req, shim(res));
}

/* ---- the site ---- */

const REWRITE = /^\/(go|trip|eta|list)\/([^/]+)$/;

function staticFile(res, url) {
  let path = decodeURIComponent(url.pathname);
  // As vercel.json's cleanUrls does in production: a worker that precaches one of these gets a redirected
  // response, which can't answer a navigation.
  if (path.endsWith('.html')) {
    res.writeHead(308, { Location: path === '/index.html' ? '/' : path.slice(0, -5) });
    return res.end();
  }
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const headers = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (path === '/sw.js') {
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    return res.end(`${readFileSync(file, 'utf8')}\n// test build ${swBump}\n`);
  }
  res.writeHead(200, headers);
  return createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? JSON.parse(text) : {};
    }
    if (url.pathname.startsWith('/__supabase/')) return supabase(req, res, url, body);
    if (url.pathname.startsWith('/__release/')) return release(req, res, url);
    if (url.pathname === '/__test/bump') {
      swBump++;
      res.writeHead(200);
      return res.end(String(swBump));
    }
    const rewritten = REWRITE.exec(url.pathname);
    if (rewritten) {
      url.pathname = '/api/share-page';
      url.searchParams.set('id', rewritten[2]);
    }
    if (url.pathname.startsWith('/api/')) return await apiRoute(req, res, url, body);
    return staticFile(res, url);
  } catch (err) {
    console.error(req.url, err);
    if (!res.headersSent) res.writeHead(500);
    return res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Listening on ${PORT}`));

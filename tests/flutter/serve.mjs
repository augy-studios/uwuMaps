// What the Android app's Playwright tests run against: the same Dart code built for the browser
// (tests/flutter/build-web.mjs), with what's around it stood in for, so no accounts are needed:
//
//   /__tiles/<archive>/z/x/y   The map's tiles from the fixture pack, as the phone's tile server gives them.
//   /__vendor/*                The website's vendored MapLibre, for the browser build's map.
//   /__releases?page=N         GitHub's releases API, saying what /__test/releases was last told.
//   /__apk/*                   A release's APK: some bytes to download, with a checksum to match.
//   /api/*, /__release/*       Handed to tests/dev-server.mjs: the real API routes, and the pack.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PORT = Number(process.env.FLUTTER_PORT || 4180);
const API_PORT = Number(process.env.PORT || 4173);
const WEB = here('../../android/build/web/');
const VENDOR = here('../../main-site/vendor/');
const FIXTURE = here('../.fixture/');

const { PMTiles } = createRequire(here('../../tools/package.json'))('pmtiles');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pbf': 'application/x-protobuf', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.frag': 'application/octet-stream', '.bin': 'application/octet-stream',
};

function archive(name) {
  const bytes = readFileSync(`${FIXTURE}singapore.${name}`);
  return new PMTiles({
    getKey: () => name,
    getBytes: async (offset, length) => ({ data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length) }),
  });
}

const archives = {};

async function tile(res, name, z, x, y) {
  archives[name] ||= archive(name);
  const got = await archives[name].getZxy(z, x, y);
  if (!got) {
    res.writeHead(204);
    return res.end();
  }
  const raw = Buffer.from(got.data);
  res.writeHead(200, { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'max-age=3600' });
  return res.end(raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw);
}

function staticFile(res, root, path) {
  // Flutter's web build keeps a folder with a space in its name as "Noto%20Sans%20Regular", on disk.
  const raw = normalize(join(root, path));
  const file = existsSync(raw) ? raw : normalize(join(root, decodeURIComponent(path)));
  if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
  return true;
}

// What the fake GitHub says, and the fake APK.
let releases = [];
const APK = Buffer.alloc(2_500_000, 7);
const APK_SHA = createHash('sha256').update(APK).digest('hex');

function proxy(req, res) {
  const out = httpRequest({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  out.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(out);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  try {
    const t = /^\/__tiles\/(base|buildings)\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
    if (t) return await tile(res, t[1], Number(t[2]), Number(t[3]), Number(t[4]));
    if (path.startsWith('/__vendor/')) {
      if (staticFile(res, VENDOR, path.replace('/__vendor/', ''))) return undefined;
      res.writeHead(404);
      return res.end();
    }
    if (path === '/__test/releases') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      releases = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200);
      return res.end('ok');
    }
    if (path === '/__test/apk') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sha256: APK_SHA, size: APK.length }));
    }
    if (path === '/__releases') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(url.searchParams.get('page') === '1' ? releases : []));
    }
    if (path.startsWith('/__apk/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': APK.length });
      return res.end(APK);
    }
    if (path.startsWith('/api/') || path.startsWith('/__release/') || path.startsWith('/__supabase/')) return proxy(req, res);
    if (staticFile(res, WEB, path === '/' ? 'index.html' : path.slice(1))) return undefined;
    // The app's own addresses, /go/<id> and so on, are the one page.
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return res.end(readFileSync(`${WEB}index.html`));
  } catch (err) {
    console.error(req.url, err);
    if (!res.headersSent) res.writeHead(500);
    return res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Listening on ${PORT}`));

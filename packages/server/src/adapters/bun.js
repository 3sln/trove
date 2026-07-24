// Bun adapter — the production runtime. Bun speaks Web Request/Response natively,
// so the server's `handle(request)` plugs straight into `Bun.serve` with no
// req/res conversion. Static assets are served with `Bun.file` (SPA fallback), and
// SQLite uses `bun:sqlite` (see core/sqlite-driver.js). The Node adapter
// (adapters/node.js) stays as a fully compatible alternative.
//
//   TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
//   TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
//   bun packages/server/src/adapters/bun.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createServer, configFromEnv } from '../index.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.TROVE_WEB_DIST || path.resolve(__dirname, '../../../web/dist');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

async function staticAssets(req) {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(WEB_DIST, path.normalize(rel));
  if (!filePath.startsWith(WEB_DIST)) return null; // traversal guard

  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file, { headers: { 'content-type': MIME[path.extname(filePath)] || file.type || 'application/octet-stream' } });
  }
  // SPA fallback: serve index.html for unknown non-API GET routes.
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const index = Bun.file(path.join(WEB_DIST, 'index.html'));
    if (await index.exists()) return new Response(index, { headers: { 'content-type': 'text/html' } });
  }
  return null;
}

const hasWeb = existsSync(WEB_DIST);
const { handle } = await createServer({
  ...configFromEnv(),
  assets: hasWeb ? staticAssets : undefined,
});

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    return (await handle(req)) ?? new Response('Not found', { status: 404 });
  },
  error(err) {
    console.error('server error', err);
    return new Response('Internal error', { status: 500 });
  },
});

console.log(`Trove server (Bun) on http://${HOST}:${PORT}  (web assets: ${hasWeb ? WEB_DIST : 'none — run npm run build:web'})`);

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
import { existsSync, readFileSync } from 'node:fs';
import { createServer, configFromEnv, warnOnOpenAccess } from '../index.js';

// A JWKS held in a file rather than inlined in the environment: multi-line JSON is
// awkward in env vars and shows up in `docker inspect`, while a mounted secret file
// does not. Read here rather than in configFromEnv, which has to stay loadable on
// Workers where there is no filesystem.
if (process.env.TROVE_JWT_JWKS_FILE && !process.env.TROVE_JWT_JWKS) {
  process.env.TROVE_JWT_JWKS = readFileSync(process.env.TROVE_JWT_JWKS_FILE, 'utf8');
}


// TROVE_-prefixed to match every other setting; bare PORT/HOST still work, since that
// is what most platforms inject and breaking them would be gratuitous.
const PORT = Number(process.env.TROVE_PORT || process.env.PORT || 8787);
const HOST = process.env.TROVE_HOST || process.env.HOST || '0.0.0.0';

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
const envConfig = configFromEnv();
warnOnOpenAccess(envConfig);
const { handle, close } = await createServer({
  ...envConfig,
  assets: hasWeb ? staticAssets : undefined,
});

const server = Bun.serve({
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

// Graceful shutdown: stop serving, then flush notifications, dispose the sidecar,
// and close SQLite cleanly so a redeploy doesn't lose in-flight work.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Trove shutting down (${signal})…`);
  try { server.stop(); } catch { /* ignore */ }
  try { await close(); } catch (err) { console.error('shutdown error', err); }
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));

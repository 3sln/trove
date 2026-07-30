// Bun adapter — the production runtime. Bun speaks Web Request/Response natively,
// so the server's `handle(request)` plugs straight into `Bun.serve` with no
// req/res conversion. Static assets are served with `Bun.file` (SPA fallback), and
// SQLite uses `bun:sqlite` (see core/sqlite-driver.js). The Node adapter
// (adapters/node.js) stays as a fully compatible alternative.
//
//   TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
//   TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
//   bun packages/server/src/adapters/bun.js

import { readFileSync } from 'node:fs';
import { createServer, configFromEnv, warnOnOpenAccess } from '../index.js';
// This runtime HAS a filesystem, so it registers the filesystem driver. Imported from
// storage/filesystem.js rather than the package barrel: that import is what pulls in
// node:fs, and the Workers adapter deliberately never makes it — so there, Filesystem is
// absent from the collection form and absent from the bundle.
import { filesystemDriver } from '@3sln/trove/core/storage/filesystem.js';
import { findWebDist } from './webDist.js';
import { createStaticAssets } from './staticAssets.js';

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

// Built web assets, if the app has been built — see webDist.js for why this is a
// resolution rather than a relative path.
const { dir: WEB_DIST, source: WEB_DIST_SOURCE } = findWebDist();

// Where to look, what to refuse and what to say about caching is shared with the Node
// adapter — see staticAssets.js. All that differs here is how a file is read.
const staticAssets = WEB_DIST && createStaticAssets({
  dir: WEB_DIST,
  read: async (filePath) => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return { size: file.size, mtime: file.lastModified, type: file.type, open: () => file };
  },
});

const hasWeb = !!WEB_DIST;
const envConfig = configFromEnv();
warnOnOpenAccess(envConfig);
const { handle, close } = await createServer({
  ...envConfig,
  storageDrivers: [filesystemDriver()],
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

console.log(`Trove server (Bun) on http://${HOST}:${PORT}  (web assets: ${hasWeb ? WEB_DIST : `none — ${WEB_DIST_SOURCE}; run npm run build:web`})`);

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

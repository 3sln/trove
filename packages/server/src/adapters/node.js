// Node adapter. Uses the standard http server and converts between Node's
// req/res and Web Request/Response (Node 20+ has global fetch/Request/Response
// and Readable.toWeb/fromWeb). Serves the built web app from disk when present,
// with SPA fallback, so `node adapters/node.js` runs the whole thing.
//
//   TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
//   TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
//   node packages/server/src/adapters/node.js

import http from 'node:http';
import fs, { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createServer, configFromEnv, warnOnOpenAccess } from '../index.js';
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

// Where to look, what to refuse and what to say about caching is shared with the Bun
// adapter — see staticAssets.js. All that differs here is how a file is read.
const staticAssets = WEB_DIST && createStaticAssets({
  dir: WEB_DIST,
  read: async (filePath) => {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        size: stat.size,
        mtime: stat.mtimeMs,
        open: () => Readable.toWeb(fs.createReadStream(filePath)),
      };
    } catch {
      return null;
    }
  },
});

async function toWebRequest(nodeReq) {
  const url = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
  const method = nodeReq.method;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method, headers,
    body: hasBody ? Readable.toWeb(nodeReq) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeWebResponse(res, webRes) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  if (webRes.body) {
    await new Promise((resolve, reject) =>
      Readable.fromWeb(webRes.body).pipe(res).on('finish', resolve).on('error', reject),
    );
  } else {
    res.end();
  }
}

const hasWeb = !!WEB_DIST;
const envConfig = configFromEnv();
warnOnOpenAccess(envConfig);
const { handle, close } = await createServer({
  ...envConfig,
  assets: hasWeb ? staticAssets : undefined,
});

const server = http.createServer(async (nodeReq, nodeRes) => {
  try {
    const webReq = await toWebRequest(nodeReq);
    const webRes = await handle(webReq);
    await writeWebResponse(nodeRes, webRes);
  } catch (err) {
    console.error('server error', err);
    if (!nodeRes.headersSent) nodeRes.statusCode = 500;
    nodeRes.end('Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Trove server on http://${HOST}:${PORT}  (web assets: ${hasWeb ? WEB_DIST : `none — ${WEB_DIST_SOURCE}; run npm run build:web`})`);
});

// Graceful shutdown: stop accepting connections, then flush notifications, dispose
// the sidecar, and close SQLite cleanly so a redeploy doesn't lose in-flight work.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Trove shutting down (${signal})…`);
  server.close();
  try { await close(); } catch (err) { console.error('shutdown error', err); }
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));

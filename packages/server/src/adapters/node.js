// Node adapter. Uses the standard http server and converts between Node's
// req/res and Web Request/Response (Node 20+ has global fetch/Request/Response
// and Readable.toWeb/fromWeb). Serves the built web app from disk when present,
// with SPA fallback, so `node adapters/node.js` runs the whole thing.
//
//   TROVE_STORAGE=filesystem TROVE_FS_ROOT=./data/objects \
//   TROVE_METADATA=sqlite TROVE_DB_PATH=./data/trove.db \
//   node packages/server/src/adapters/node.js

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createServer, configFromEnv, warnOnOpenAccess } from '../index.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built web assets (packages/web/dist) if the app has been built.
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
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return null;
    const stream = Readable.toWeb(fs.createReadStream(filePath));
    return new Response(stream, { headers: { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' } });
  } catch {
    // SPA fallback: serve index.html for unknown non-API GET routes.
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      try {
        const html = await fsp.readFile(path.join(WEB_DIST, 'index.html'));
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      } catch {
        return null;
      }
    }
    return null;
  }
}

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

const hasWeb = fs.existsSync(WEB_DIST);
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
  console.log(`Trove server on http://${HOST}:${PORT}  (web assets: ${hasWeb ? WEB_DIST : 'none — run npm run build:web'})`);
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

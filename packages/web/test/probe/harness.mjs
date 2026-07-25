// Reusable boot for exploratory browser probing: real Trove server (in-memory
// backends) serving the built web app, driven in headless Chromium. Returns handles
// so a probe script can seed content, drive the UI, and watch for silent failures
// (uncaught errors, stuck spinners, missing feedback).

import { chromium } from 'playwright-core';
import { createServer, configFromEnv } from '../../../server/src/index.js';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm' };

const CHROME = process.env.CHROME_PATH
  || fs.readdirSync('/opt/pw-browsers').map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
  || '/opt/pw-browsers/chromium/chrome';

async function staticAssets(req) {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.join(DIST, path.normalize(rel));
  if (!fp.startsWith(DIST)) return null;
  try {
    const st = await fsp.stat(fp);
    if (st.isDirectory()) throw 0;
    return new Response(Readable.toWeb(fs.createReadStream(fp)), { headers: { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' } });
  } catch {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      return new Response(await fsp.readFile(path.join(DIST, 'index.html')), { headers: { 'content-type': 'text/html' } });
    }
    return null;
  }
}

async function toWeb(nodeReq) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
  return new Request(`http://localhost${nodeReq.url}`, { method: nodeReq.method, headers, body: hasBody ? Readable.toWeb(nodeReq) : undefined, duplex: 'half' });
}

export async function boot({ serverConfig = {}, seed } = {}) {
  const { handle, vfs, ...rest } = await createServer({ ...configFromEnv({ TROVE_STORAGE: 'memory' }), ...serverConfig, assets: staticAssets });
  if (seed) await seed(vfs);

  const server = http.createServer(async (req, res) => {
    try {
      const webRes = await handle(await toWeb(req));
      res.statusCode = webRes.status;
      webRes.headers.forEach((v, k) => res.setHeader(k, v));
      if (webRes.body) Readable.fromWeb(webRes.body).pipe(res);
      else res.end();
    } catch (e) {
      res.statusCode = 500; res.end(String(e?.message || e));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

  async function close() {
    clearTimeout(watchdog);
    await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    // Backends may keep timers alive; probes are one-shot, so exit deterministically.
    setTimeout(() => process.exit(process.exitCode || 0), 200).unref?.();
  }
  // Never let a probe hang the whole session; force-exit with a diagnostic.
  const watchdog = setTimeout(() => {
    console.error('\n‼ WATCHDOG: probe exceeded 75s — forcing exit. Recent errors:\n' + errors.slice(-8).join('\n'));
    process.exit(2);
  }, 75_000);
  watchdog.unref?.();

  // networkidle can stall (the offline service polls the API); callers use goto().
  async function goto(pathOrEmpty = '') {
    await page.goto(base + pathOrEmpty, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shell', { timeout: 8000 });
  }
  return { base, page, browser, server, vfs, handle, errors, close, goto, ...rest };
}

// A tiny check harness with a nonzero exit on failure.
export function checker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  const done = () => {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (passed !== results.length) process.exitCode = 1;
  };
  return { check, done, results };
}

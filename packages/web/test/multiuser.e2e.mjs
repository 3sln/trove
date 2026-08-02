// Multi-user access boundaries, at the API and in the UI.
//
// Every other test in this repo runs as one user with access to everything, so the
// permission layer has been exercised only by unit tests of the checker itself. That
// leaves the interesting question untested: not "does `can()` return false", but "does
// a real request from a real user actually get stopped, and does the app show that
// user a drive that matches what they can do".
//
// FOUR PEOPLE, TWO COLLECTIONS:
//
//                 default            research
//   root          admin (TROVE_ADMINS)         — sees and does everything
//   alice         read + write        read     — can edit her own, only read the other
//   bob           —                   read + write
//   nobody        —                   —        (a valid token, no grants at all)
//
// Tokens are real ES256 JWTs signed by a key the server is configured to trust — the
// keychain, not a JWKS endpoint. That is the point: this exercises the actual identity
// path a deployment uses, rather than stubbing authentication out and testing a mock.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createServer } from '../../server/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm' };
const CHROME = process.env.CHROME_PATH
  || fs.readdirSync('/opt/pw-browsers').map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
  || '/opt/pw-browsers/chromium/chrome';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// --- mint tokens -------------------------------------------------------------

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const seg = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(sub, extra = {}) {
  const input = `${seg({ alg: 'ES256', typ: 'JWT', kid: 'test-key' })}.${seg({
    sub, iss: 'https://trove.test', aud: 'trove', exp: Math.floor(Date.now() / 1000) + 3600, ...extra,
  })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const USERS = {
  root: await token('root', { name: 'Root', email: 'root@trove.test' }),
  alice: await token('alice', { name: 'Alice', email: 'alice@trove.test', roles: ['staff'] }),
  bob: await token('bob', { name: 'Bob', email: 'bob@trove.test' }),
  nobody: await token('nobody', { name: 'Nobody' }),
};

// --- server ------------------------------------------------------------------

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

const srv = await createServer({
  storage: { driver: 'memory' },
  identity: {
    driver: 'jwt',
    jwt: { jwks: { keys: [publicJwk] }, issuer: 'https://trove.test', audience: 'trove', required: true },
  },
  admins: ['root'],
  // Not world-open: the default collection grants nothing to nobody-in-particular, so
  // every grant below has to be explicit. A test against an open drive proves nothing.
  defaultOpen: false,
  startFlusher: false,
  assets: staticAssets,
});

// Grants. `alice` owns the default collection and may only read research; `bob` is the
// reverse; `nobody` is deliberately left with nothing.
const ROOT = { id: 'root' };
await srv.collections.update('default', {
  acl: { grants: [{ type: 'user', subject: 'alice', capabilities: ['read', 'write', 'delete'] }] },
}, ROOT);
const research = await srv.collections.create({
  name: 'Research',
  // Each collection names its own backing store; this one gets its own in-memory one.
  store: { driver: 'memory' },
  acl: {
    grants: [
      { type: 'user', subject: 'bob', capabilities: ['read', 'write', 'delete'] },
      { type: 'user', subject: 'alice', capabilities: ['read'] },
    ],
  },
}, ROOT);
const RESEARCH = research.id;

await srv.vfs.writeFile('alice-notes.md', '# Alice notes\n\nSailing at dawn.', { contentType: 'text/markdown', collectionId: 'default' });
await srv.vfs.writeFile('research-paper.md', '# Research\n\nThe spice melange.', { contentType: 'text/markdown', collectionId: RESEARCH });

const server = http.createServer(async (req, res) => {
  try {
    const webRes = await srv.handle(await toWeb(req));
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    if (webRes.body) Readable.fromWeb(webRes.body).pipe(res);
    else res.end();
  } catch (e) { res.statusCode = 500; res.end(String(e?.message || e)); }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// --- API boundaries ----------------------------------------------------------

const api = async (who, method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(USERS[who] ? { authorization: `Bearer ${USERS[who]}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// No token at all. `required: true` means the door is shut, not ajar.
check('an unauthenticated request is refused', (await api(null, 'GET', '/api/items')).status === 401);
// 401, not 400: an unparseable credential means "sign in again", and reporting it as a
// malformed request tells the client the wrong thing to do about it.
const garbage = await fetch(base + '/api/items', { headers: { authorization: 'Bearer not-a-jwt' } });
check('a garbage token is refused as an auth failure', garbage.status === 401, `got ${garbage.status}`);

// Each user sees exactly the collections they were granted — no more.
const collectionsFor = async (who) => ((await api(who, 'GET', '/api/collections')).json?.collections || []).map((c) => c.id).sort();
check('alice sees both collections she has any access to', JSON.stringify(await collectionsFor('alice')) === JSON.stringify(['default', RESEARCH].sort()), (await collectionsFor('alice')).join(','));
check('bob sees only the collection he was granted', JSON.stringify(await collectionsFor('bob')) === JSON.stringify([RESEARCH]), (await collectionsFor('bob')).join(','));
check('a user with no grants sees no collections', (await collectionsFor('nobody')).length === 0);

// Reading across the boundary.
check('bob cannot list the collection he has no grant on', (await api('bob', 'GET', '/api/items?collection=default')).status === 403);
check('alice can list the collection she can read', (await api('alice', 'GET', `/api/items?collection=${RESEARCH}`)).status === 200);

// Read is not write. This is the distinction most likely to be got wrong.
const aliceWriteToResearch = await api('alice', 'POST', '/api/uploads', { name: 'sneaky.txt', size: 4, contentType: 'text/plain', collection: RESEARCH });
check('read access does not imply write access', aliceWriteToResearch.status === 403, `got ${aliceWriteToResearch.status}`);

const researchItem = (await api('bob', 'GET', `/api/items?collection=${RESEARCH}`)).json.items[0];
const aliceRename = await api('alice', 'POST', '/api/items/rename', { id: researchItem.id, newName: 'renamed.md' });
check('a reader cannot rename an item they can see', aliceRename.status === 403, `got ${aliceRename.status}`);
const aliceDelete = await api('alice', 'POST', '/api/items/delete', { id: researchItem.id });
check('a reader cannot delete an item they can see', aliceDelete.status === 403, `got ${aliceDelete.status}`);
check('the item survived both attempts', (await api('bob', 'GET', `/api/items?collection=${RESEARCH}`)).json.items.length === 1);

// Search must not leak across the boundary — a result row names a file.
const bobSearch = await api('bob', 'GET', '/api/search?q=sailing');
const bobHitNames = (bobSearch.json?.results || []).map((r) => r.name || r.node?.name).filter(Boolean);
check('search does not return items from collections the user cannot read',
  !bobHitNames.some((n) => /alice-notes/.test(n)), bobHitNames.join(',') || '(none)');

// Drive-wide operations are for people who can act drive-wide.
check('a scoped user cannot rebuild the whole index', (await api('bob', 'POST', '/api/reindex')).status === 403);
check('an admin can', (await api('root', 'POST', '/api/reindex')).status === 200);
check('a reader cannot scan a collection they cannot write', (await api('alice', 'POST', `/api/collections/${RESEARCH}/scan`)).status === 403);
check('the collection owner can', (await api('bob', 'POST', `/api/collections/${RESEARCH}/scan`)).status === 200);

// Identity is reported honestly.
const aliceMe = await api('alice', 'GET', '/api/me');
check('a signed-in user is reported as authenticated, with their claims',
  aliceMe.json.authenticated === true && aliceMe.json.principal.name === 'Alice' && aliceMe.json.admin === false);
check('an admin is reported as one', (await api('root', 'GET', '/api/me')).json.admin === true);

// --- the UI each user actually gets ------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function openAs(who) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // `window.__trove` is off in the shipped bundle — see createWorkbench's `debug`
  // option. `addInitScript` runs before any page script, which is how automation asks.
  await context.addInitScript(() => { window.__troveDebug = true; });
  // The app reads the token from localStorage-backed auth; inject it before any script
  // runs so the very first API call is already authenticated.
  await context.addInitScript((t) => { window.localStorage.setItem('trove.token', t); }, USERS[who]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 8000 });
  return { page, context, errors };
}

const alice = await openAs('alice');
await alice.page.waitForTimeout(800);
const aliceCollections = await alice.page.evaluate(() => window.__trove.app.explorer.get().collections.map((c) => c.id));
check('the UI offers alice both her collections', JSON.stringify([...aliceCollections].sort()) === JSON.stringify(['default', RESEARCH].sort()), aliceCollections.join(','));
check('a signed-in user gets a profile chip', (await alice.page.locator('.principal').count()) === 1);

const bob = await openAs('bob');
await bob.page.waitForTimeout(800);
const bobCollections = await bob.page.evaluate(() => window.__trove.app.explorer.get().collections.map((c) => c.id));
check('the UI offers bob only his collection', JSON.stringify(bobCollections) === JSON.stringify([RESEARCH]), bobCollections.join(','));
const bobItems = await bob.page.evaluate(() => window.__trove.app.explorer.get().items.map((i) => i.name));
// Both halves matter. "Bob sees nothing" would satisfy the leak check while being a
// completely broken drive — which is exactly what it was before the client learned to
// land on a collection the user can actually read.
check('bob lands on his own collection and sees its contents',
  bobItems.includes('research-paper.md'), bobItems.join(',') || '(none)');
check('and nothing from the collection he cannot read',
  !bobItems.some((n) => /alice-notes/.test(n)), bobItems.join(',') || '(none)');

// A user with a valid token and no grants: the app must SAY so, not sit blank.
const nobody = await openAs('nobody');
await nobody.page.waitForTimeout(1000);
const nobodyState = await nobody.page.evaluate(() => ({
  collections: window.__trove.app.explorer.get().collections.length,
  error: window.__trove.app.explorer.get().error,
  loading: window.__trove.app.explorer.get().loading,
}));
check('a user with no access is not left on a spinner', nobodyState.loading === false, JSON.stringify(nobodyState));
check('and is told something, rather than shown an empty drive that looks normal',
  nobodyState.collections === 0 && !!nobodyState.error, JSON.stringify(nobodyState));

const uiErrors = [...alice.errors, ...bob.errors, ...nobody.errors];
check('no uncaught exceptions in any user\'s session', uiErrors.length === 0, uiErrors.slice(0, 3).join(' | '));

// --- done --------------------------------------------------------------------

for (const s of [alice, bob, nobody]) await s.context.close().catch(() => {});
await browser.close().catch(() => {});
server.closeAllConnections?.();
await srv.close().catch(() => {});
await new Promise((r) => server.close(r));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exitCode = 1;
await new Promise((r) => process.stdout.write('', r));
process.exit(process.exitCode || 0);

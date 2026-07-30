// The parts of the HTTP contract that are easy to get subtly wrong and hard to notice:
// a redirect that never leaves the server, a filename the browser mangles, and a
// state-changing request that another site made on the user's behalf.

import { test, expect } from 'bun:test';
import { Router, cors, parseRange, crossSiteRefusal } from '../src/router.js';
import { createServer } from '../src/index.js';

test('a redirect survives the response pipeline', async () => {
  // `Response.redirect()` has an IMMUTABLE headers guard. `cors()` sets a header on
  // every response, so on any runtime that enforces the guard (Node, Workers — Bun
  // happens not to) every presigned download turned into a 500 whose body was
  // `{"error":{"code":"internal","message":"immutable"}}`.
  const r = new Router();
  r.get('/dl', () => Response.redirect('https://bucket.example/obj?sig=abc', 302));
  const res = await r.handle(new Request('http://t/dl'));
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://bucket.example/obj?sig=abc');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('cors() leaves an ordinary response mutable and untouched otherwise', async () => {
  const res = cors(new Response('hi', { headers: { 'x-keep': '1' } }));
  expect(await res.text()).toBe('hi');
  expect(res.headers.get('x-keep')).toBe('1');
});

test('parseRange understands both forms, and neither more', () => {
  expect(parseRange('bytes=0-99')).toEqual({ start: 0, end: 99 });
  expect(parseRange('bytes=100-')).toEqual({ start: 100, end: undefined });
  // The suffix form is NOT `{start: 0, end: 500}` — that served the first 501 bytes.
  expect(parseRange('bytes=-500')).toEqual({ suffix: 500 });
  expect(parseRange('bytes=-')).toBe(null);
  expect(parseRange('items=0-9')).toBe(null);
  expect(parseRange(null)).toBe(null);
});

test('a downloaded file keeps its real name', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const node = await vfs.writeFile('Q3 report, final.pdf', 'x', { contentType: 'application/pdf' });
  const res = await handle(new Request(`http://t/api/items/download?id=${node.id}&disposition=attachment`));
  const cd = res.headers.get('content-disposition');
  // Percent-encoding the quoted-string form is not a decoding any browser performs, so
  // the file landed on disk as `Q3%20report%2C%20final.pdf`. RFC 6266 says: an ASCII
  // fallback in `filename`, the real name in `filename*`.
  expect(cd).toContain('filename="Q3 report, final.pdf"');
  expect(cd).toContain("filename*=UTF-8''Q3%20report%2C%20final.pdf");
});

// --- cross-site writes ---------------------------------------------------------

const post = (headers) => new Request('http://drive.example/api/items/delete', {
  method: 'POST', headers, body: '{"id":"itm_1"}',
});

test('a cross-site write is refused; a same-origin one is not', () => {
  // The attack this closes: a CORS *simple* request needs no preflight, so the
  // TROVE_CORS_ORIGIN allowlist was never consulted and the write went through. The
  // attacker cannot read the reply — which is no comfort when the call was a delete.
  const evil = crossSiteRefusal(post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }));
  expect(evil.status).toBe(403);

  expect(crossSiteRefusal(post({ 'sec-fetch-site': 'same-origin', origin: 'http://drive.example' }))).toBe(null);
  // A top-level navigation or a user-typed URL reports `none`.
  expect(crossSiteRefusal(post({ 'sec-fetch-site': 'none' }))).toBe(null);
});

test('a non-browser client is unaffected', () => {
  // curl, an agent, a script: no Origin, no Sec-Fetch-Site, and — the point — no
  // ambient credential for another site to borrow.
  expect(crossSiteRefusal(post({ authorization: 'Bearer t' }))).toBe(null);
  expect(crossSiteRefusal(post({}))).toBe(null);
});

test('an operator who opted into CORS for an origin meant it', () => {
  const req = post({ 'sec-fetch-site': 'cross-site', origin: 'https://app.example' });
  expect(crossSiteRefusal(req, { corsOrigin: 'https://app.example' })).toBe(null);
  expect(crossSiteRefusal(req, { corsOrigin: 'https://other.example' })?.status).toBe(403);
});

test('a GET is never refused — it is supposed to be safe', () => {
  const req = new Request('http://drive.example/api/collections/default/items', {
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  });
  expect(crossSiteRefusal(req)).toBe(null);
});

test('the refusal reaches the real API and the MCP endpoint', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const node = await vfs.writeFile('keep.md', 'mine', { contentType: 'text/markdown' });
  const cross = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', 'content-type': 'text/plain' };

  const del = await handle(new Request('http://t/api/items/delete', {
    method: 'POST', headers: cross, body: JSON.stringify({ id: node.id }),
  }));
  expect(del.status).toBe(403);
  expect(await vfs.stat(node.id)).toBeTruthy(); // still there

  const mcp = await handle(new Request('http://t/mcp', {
    method: 'POST', headers: cross,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_file', arguments: { file: 'keep.md' } } }),
  }));
  expect(mcp.status).toBe(403);
  expect(await vfs.stat(node.id)).toBeTruthy();
});

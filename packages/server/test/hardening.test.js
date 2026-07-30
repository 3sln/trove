// Production-hardening behaviours over the real HTTP handler: safe download
// disposition, request-body size cap, CORS defaults, SSRF guard on the assetlinks
// proxy, and the readiness probe.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

async function seed(vfs, name, bytes, contentType) {
  return vfs.writeFile(name, new Uint8Array(bytes), { contentType });
}

test('download forces attachment + nosniff for non-inline-safe types (HTML/SVG)', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const html = await seed(vfs, 'evil.html', [60, 33, 45], 'text/html');
  const res = await handle(new Request(`http://t/api/items/download?id=${html.id}`));
  expect(res.headers.get('content-disposition')).toStartWith('attachment');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
});

test('download stays inline for safe media types (images)', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const png = await seed(vfs, 'pic.png', [1, 2, 3], 'image/png');
  const res = await handle(new Request(`http://t/api/items/download?id=${png.id}`));
  expect(res.headers.get('content-disposition')).toStartWith('inline');
});

test('oversized JSON body is rejected', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const big = 'a'.repeat(4 * 1024 * 1024 + 32); // just over the 4 MiB default cap
  const res = await handle(new Request('http://t/api/items/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'x', newName: big }),
  }));
  expect(res.status).toBe(400);
});

test('CORS is off by default and honours a configured origin', async () => {
  const off = await createServer();
  await off.collections?.ensure({ id: 'default', name: 'My Drive' });
  const r1 = await off.handle(new Request('http://t/api/health', { method: 'OPTIONS' }));
  expect(r1.headers.get('access-control-allow-origin')).toBeNull();

  const on = await createServer({ corsOrigin: '*' });
  await on.collections?.ensure({ id: 'default', name: 'My Drive' });
  const r2 = await on.handle(new Request('http://t/api/health', { method: 'OPTIONS' }));
  expect(r2.headers.get('access-control-allow-origin')).toBe('*');
});

test('assetlinks proxy refuses internal/private hosts (SSRF)', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  for (const domain of ['localhost', '169.254.169.254', '10.0.0.1', '127.0.0.1', '192.168.1.1']) {
    const res = await handle(new Request(`http://t/api/plugins/assetlinks?domain=${domain}`));
    expect(res.status).toBe(400);
  }
});

test('readiness probe reports ok when the store answers', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const res = await handle(new Request('http://t/api/ready'));
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
});

test('list limit is clamped (no error on an absurd limit)', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  await vfs.writeFile('a.txt', 'x', { contentType: 'text/plain' });
  const res = await handle(new Request('http://t/api/collections/default/items?limit=99999999'));
  expect(res.status).toBe(200);
  expect(Array.isArray((await res.json()).items)).toBe(true);
});

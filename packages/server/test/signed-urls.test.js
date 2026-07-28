// A signed URL against the real server: minting it needs `read`, using it does not.
//
// That asymmetry is the whole feature — an <img src>, a <video src> and cache.add()
// cannot send an Authorization header, so the grant has to travel in the URL. Which
// makes "what exactly does this URL let you do, and for how long" the thing to pin.

import { test, expect } from 'bun:test';
import { createServer, configFromEnv } from '../src/index.js';
import { SignedUrls } from '@3sln/trove/core';

const ENV = { TROVE_STORAGE: 'memory' };

async function drive(extra = {}) {
  const server = await createServer({ ...configFromEnv(ENV), ...extra });
  const item = await server.vfs.writeFile('cliff.png', 'PNGBYTES', { contentType: 'image/png' });
  return { server, item };
}
const get = (server, path, init) => server.handle(new Request(`http://t${path}`, init));
const post = (server, path, b) => get(server, path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
});

test('a minted URL fetches the bytes with no credentials at all', async () => {
  const { server, item } = await drive();
  const { urls } = await (await post(server, '/api/items/urls', { ids: [item.id], op: 'media' })).json();
  const url = urls[item.id].url;
  // Relative, because a browser subresource is same-origin — and because handing out an
  // absolute URL guessed from a Host header is how you get a poisoned link.
  expect(url.startsWith('/api/items/download?')).toBe(true);
  expect(new URL(url, 'http://t').searchParams.get('sig')).toBeTruthy();

  const res = await get(server, url);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('PNGBYTES');
  // Long enough to outlast a sitting — the point of the media purpose.
  expect(urls[item.id].expiresAt - Date.now()).toBeGreaterThan(8 * 3600 * 1000);
});

test('the signature is the grant, and it is welded to one node', async () => {
  const { server, item } = await drive();
  const other = await server.vfs.writeFile('secret.png', 'NOPE', { contentType: 'image/png' });
  const { urls } = await (await post(server, '/api/items/urls', { ids: [item.id], op: 'media' })).json();
  const q = new URL(urls[item.id].url, 'http://t').searchParams;

  // Point a valid signature at a different file: refused, because the id is signed.
  const moved = `/api/items/download?id=${other.id}&op=media&exp=${q.get('exp')}&sig=${encodeURIComponent(q.get('sig'))}`;
  expect((await get(server, moved)).status).toBe(403);

  // Extend your own expiry: refused, because the expiry is signed.
  const extended = `/api/items/download?id=${item.id}&op=media&exp=${Number(q.get('exp')) + 86400}&sig=${encodeURIComponent(q.get('sig'))}`;
  expect((await get(server, extended)).status).toBe(403);

  // Forge one outright: refused.
  const forged = `/api/items/download?id=${item.id}&op=media&exp=${q.get('exp')}&sig=${'A'.repeat(43)}`;
  expect((await get(server, forged)).status).toBe(403);
});

test('an expired URL is refused, and says which kind of refusal it is', async () => {
  // A signer whose clock is a day ahead mints a grant that is already spent.
  const stale = new SignedUrls({ secret: 'test-secret', now: () => Date.now() - 48 * 3600 * 1000 });
  const { server, item } = await drive({ urlSecret: 'test-secret' });
  const g = await stale.grant(item.id, { op: 'media' });
  const res = await get(server, `/api/items/download?id=${item.id}&op=media&exp=${g.exp}&sig=${encodeURIComponent(g.sig)}`);
  expect(res.status).toBe(403);
  // "Expired" is ordinary and the client should re-mint; "bad signature" is someone
  // editing URLs. A client that cannot tell them apart cannot cycle correctly.
  expect((await res.json()).error.message).toMatch(/expired/i);
});

test('a signed URL grants reading and nothing else', async () => {
  const { server, item } = await drive({ urlSecret: 'test-secret' });
  const signer = new SignedUrls({ secret: 'test-secret' });
  const g = await signer.grant(item.id, { op: 'media' });
  const signature = { op: g.op, exp: g.exp, sig: g.sig };
  const lease = (deps) => server.engineContainer.use(deps, (r) => r);

  // Straight at the provider, because no ROUTE offers a signature anywhere but the
  // download — going through one would prove the route's opt-in, not the grant's shape.
  const { node } = await lease({ node: { id: item.id, capability: 'read', signature } });
  expect(typeof node.read).toBe('function');
  expect(node.remove).toBeUndefined();
  expect(node.rename).toBeUndefined();

  // Asking for more than the signature carries fails to obtain a handle at all, rather
  // than quietly handing back a lesser one that a route then acts through.
  await expect(lease({ node: { id: item.id, capability: 'delete', signature } })).rejects.toThrow();
  await expect(lease({ node: { id: item.id, capability: 'admin', signature } })).rejects.toThrow();
  expect(await server.vfs.stat(item.id)).toBeTruthy();
  await server.close();
});

test('minting is authorized per id, and a batch never widens what you may see', async () => {
  const { server, item } = await drive();
  const res = await post(server, '/api/items/urls', { ids: [item.id, 'no-such-node'], op: 'download' });
  const { urls, failed } = await res.json();
  expect(Object.keys(urls)).toEqual([item.id]);
  // Absent with a reason, rather than failing the whole batch — a partly-visible gallery
  // should still draw the part you can see.
  expect(failed['no-such-node']).toBeTruthy();

  // A gallery asks for what it is about to draw, not for the drive.
  const huge = await post(server, '/api/items/urls', { ids: Array.from({ length: 500 }, (_, i) => `n${i}`) });
  expect(huge.status).toBe(400);
  expect((await post(server, '/api/items/urls', { ids: [] })).status).toBe(400);
});

test('the ordinary authenticated download still works, signature or no', async () => {
  const { server, item } = await drive();
  const res = await get(server, `/api/items/download?id=${item.id}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('PNGBYTES');
});

// The upload negotiation descriptor: a self-describing plan (transfer mode,
// limits/quota, lifecycle endpoints) plus per-file quota enforcement.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

async function jsonReq(handle, method, path, body) {
  const res = await handle(new Request(`http://t${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('upload create returns a self-describing descriptor', async () => {
  const { handle, collections: __cols } = await createServer(); // memory storage → proxied transfer
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const r = await jsonReq(handle, 'POST', '/api/collections/default/uploads', { name: 'big.bin', size: 20 * 1024 * 1024, contentType: 'application/octet-stream' });
  const d = r.json;
  expect(d.uploadId).toBeTruthy();
  expect(typeof d.multipart).toBe('boolean');

  // Limits/quota are advertised.
  expect(d.limits).toBeTruthy();
  expect(d.limits.partSize).toBeGreaterThan(0);
  expect(d.limits.maxParts).toBeGreaterThan(0);
  expect('maxBytes' in d.limits).toBe(true);

  // Transfer instructions: memory can't presign, so parts are proxied through us.
  expect(d.transfer.mode).toBe('proxied');
  expect(d.transfer.partUrl).toContain(d.uploadId);
  expect(d.transfer.partUrl).toContain('{partNumber}');
  expect(d.transfer.authHeaders).toBeTruthy();

  // Lifecycle endpoints incl. the "finished" hook.
  expect(d.endpoints.complete).toContain(d.uploadId);
  expect(d.endpoints.status).toContain(d.uploadId);
  expect(d.endpoints.abort).toContain(d.uploadId);
});

test('a full proxied upload drives entirely off the descriptor', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const create = await jsonReq(handle, 'POST', '/api/collections/default/uploads', { name: 'note.txt', size: 5, contentType: 'text/plain' });
  const d = create.json;
  const put = await handle(new Request(`http://t${d.transfer.partUrl.replace('{partNumber}', '1')}`, { method: 'PUT', body: 'hello' }));
  expect(put.status).toBe(200);
  const done = await jsonReq(handle, 'POST', d.endpoints.complete, {});
  expect(done.json.node.name).toBe('note.txt');
  expect(done.json.node.size).toBe(5);
});

test('an upload onto an existing name is disambiguated, not overwritten', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const original = await vfs.writeFile('note.txt', 'ORIGINAL', { contentType: 'text/plain' });

  const create = await jsonReq(handle, 'POST', '/api/collections/default/uploads', { name: 'note.txt', size: 3, contentType: 'text/plain' });
  const d = create.json;
  await handle(new Request(`http://t${d.transfer.partUrl.replace('{partNumber}', '1')}`, { method: 'PUT', body: 'new' }));
  const done = await jsonReq(handle, 'POST', d.endpoints.complete, {});

  // The new upload got a fresh name; the original file (id + bytes) is untouched.
  expect(done.json.node.name).toBe('note (1).txt');
  expect(done.json.node.id).not.toBe(original.id);
  const keep = await vfs.metadata.getById(original.id);
  expect(keep).toBeTruthy();
  expect(keep.name).toBe('note.txt');
  expect(keep.size).toBe(8); // 'ORIGINAL'
  expect(keep.storageKey).toBe(original.storageKey); // bytes not replaced
});

test('per-file quota is enforced at create time', async () => {
  const { handle, collections: __cols } = await createServer({ maxUploadBytes: 1024 });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const ok = await jsonReq(handle, 'POST', '/api/collections/default/uploads', { name: 'small', size: 512 });
  expect(ok.status).toBe(200);
  const tooBig = await jsonReq(handle, 'POST', '/api/collections/default/uploads', { name: 'huge', size: 4096 });
  expect(tooBig.status).toBe(413); // TOO_LARGE — the store isn't full, the file is too big
  expect(tooBig.json.error.code).toBe('too_large');
  expect(tooBig.json.error.details.maxBytes).toBe(1024);
});

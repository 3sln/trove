// The presigned upload path, over HTTP.
//
// `sign` and `report` are the two upload routes no test reached: they only exist for a
// backend that can hand a client a URL to PUT to directly, and every test backend is
// memory, which cannot. So they were converted onto the upload handle with nothing
// exercising them — the same gap that let `listTrash` ship under the wrong capability.
//
// A backend that presigns is enough to close it; this is not a test of S3.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { MemoryStorage } from '@3sln/trove/core';

class PresigningStorage extends MemoryStorage {
  get capabilities() {
    return { ...super.capabilities, presignUpload: true, presignDownload: false };
  }
  async presignPart(key, uploadId, partNumber) {
    return `https://bucket.example/${encodeURIComponent(key)}?upload=${uploadId}&part=${partNumber}`;
  }
}

const api = async (handle, method, path, body) => {
  const res = await handle(new Request(`http://t${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

test('a presigned upload can be signed, reported, and inspected', async () => {
  const { handle, close, collections: __cols } = await createServer({ storage: new PresigningStorage() });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const start = await api(handle, 'POST', '/api/collections/default/uploads', {
    name: 'big.bin', size: 12 * 1024 * 1024, contentType: 'application/octet-stream',
  });
  expect(start.status).toBe(200);
  const id = start.json.uploadId;

  const signed = await api(handle, 'POST', `/api/uploads/${id}/parts/1/sign`);
  expect(signed.status).toBe(200);
  expect(signed.json.url).toContain('https://bucket.example/');

  const reported = await api(handle, 'POST', `/api/uploads/${id}/parts/1/report`, { etag: 'abc123' });
  expect(reported.status).toBe(200);

  // `status` is what a resuming client reads to learn which parts it may skip.
  const status = await api(handle, 'GET', `/api/uploads/${id}/status`);
  expect(status.status).toBe(200);
  expect(status.json.received).toContain(1);
  expect(status.json.strategy).toBe('presign');

  expect((await api(handle, 'DELETE', `/api/uploads/${id}`)).status).toBe(200);
  await close();
});

test('reporting a part outside the plan is refused, not recorded', async () => {
  const { handle, close, collections: __cols } = await createServer({ storage: new PresigningStorage() });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const start = await api(handle, 'POST', '/api/collections/default/uploads', {
    name: 'big.bin', size: 12 * 1024 * 1024, contentType: 'application/octet-stream',
  });
  const bad = await api(handle, 'POST', `/api/uploads/${start.json.uploadId}/parts/99999/report`, { etag: 'x' });
  expect(bad.status).toBe(400);
  await close();
});

test('an upload id that names nothing is a 404, not a 500', async () => {
  const { handle, close, collections: __cols } = await createServer({ storage: new PresigningStorage() });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  expect((await api(handle, 'GET', '/api/uploads/up_nope/status')).status).toBe(404);
  expect((await api(handle, 'POST', '/api/uploads/up_nope/parts/1/sign')).status).toBe(404);
  await close();
});

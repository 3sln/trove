// S3Storage against an actual S3 server, over real HTTP.
//
// Everything else in the suite exercises S3Storage against nothing — the memory and
// filesystem backends don't sign, don't speak XML, and don't have opinions about
// Range headers or multipart part ordering. This is the file that puts real requests
// on a socket.
//
// TWO BACKENDS, ONE TEST BODY:
//
//   • Default: `s3rver`, an in-process S3 server (a devDependency, no daemon, no
//     container, ~1s). It covers the WIRE PROTOCOL — paths, query parameters, XML
//     shapes, Range semantics, ETags, the multipart create/put/complete dance, and
//     404-vs-error mapping.
//
//     What it explicitly does NOT cover is authentication. s3rver's own source says
//     "Signature version 4 calculation is unimplemented"; it checks only that the
//     access key id is one it knows, and will accept a completely bogus signature.
//     Signing is covered by s3sigv4.test.js, which diffs against an independent
//     implementation and AWS's published vector — not by this file. Do not read a
//     green run here as "our SigV4 works".
//
//   • Opt-in: set TROVE_S3_TEST_ENDPOINT and the same tests run against a real
//     server — MinIO, Garage, R2, or S3 itself — which DOES verify signatures and
//     enforces real semantics (5 MiB minimum part size, ETag formats, error codes):
//
//       docker run -p 9000:9000 -e MINIO_ROOT_USER=minioadmin \
//         -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
//       # create the bucket, then:
//       TROVE_S3_TEST_ENDPOINT=http://127.0.0.1:9000 \
//       TROVE_S3_TEST_BUCKET=trove-test \
//       TROVE_S3_TEST_KEY=minioadmin TROVE_S3_TEST_SECRET=minioadmin bun test s3-e2e

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Storage } from '../src/index.js';

const EXTERNAL = process.env.TROVE_S3_TEST_ENDPOINT;
const BUCKET = process.env.TROVE_S3_TEST_BUCKET || 'trove-test';

// Resolved at load time so the tests genuinely SKIP when there's no server to talk to,
// rather than returning early and reporting as passes.
const S3rver = EXTERNAL ? null : await import('s3rver').then((m) => m.default).catch(() => null);
const available = !!EXTERNAL || !!S3rver;

let server = null;
let dir = null;
let s3 = null;

beforeAll(async () => {
  if (EXTERNAL) {
    s3 = new S3Storage({
      bucket: BUCKET,
      region: process.env.TROVE_S3_TEST_REGION || 'us-east-1',
      endpoint: EXTERNAL,
      accessKeyId: process.env.TROVE_S3_TEST_KEY || 'minioadmin',
      secretAccessKey: process.env.TROVE_S3_TEST_SECRET || 'minioadmin',
      forcePathStyle: true,
    });
    return;
  }
  // A production install (`--omit=dev`) has no s3rver; every test is skipped instead.
  if (!S3rver) return;
  dir = await mkdtemp(join(tmpdir(), 'trove-s3-'));
  server = new S3rver({
    port: 0, address: '127.0.0.1', silent: true, directory: dir,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  const { port } = await server.run();
  s3 = new S3Storage({
    bucket: BUCKET, region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true,
  });
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

// A unique prefix per run, so a shared external bucket doesn't collide with itself.
const KEY = (n) => `e2e_${Math.random().toString(36).slice(2, 8)}/${n}`;

test.if(available)('put, head, get — the round trip an upload actually makes', async () => {
  const key = KEY('note.txt');
  const body = 'Tacking upwind at dawn.';
  const put = await s3.put(key, body, { contentType: 'text/plain' });
  expect(put.size).toBe(body.length);
  expect(put.etag).toBeTruthy();

  const head = await s3.head(key);
  expect(head.size).toBe(body.length);
  expect(head.contentType).toBe('text/plain');

  const got = await s3.get(key);
  expect(await new Response(got.stream).text()).toBe(body);
  await s3.delete(key);
});

test.if(available)('a range request returns only the range', async () => {
  // The media openers stream by range; getting this wrong shows up as audio that
  // won't seek rather than as an error.
  const key = KEY('range.txt');
  await s3.put(key, 'hello world', { contentType: 'text/plain' });
  const got = await s3.get(key, { range: { start: 6, end: 10 } });
  expect(await new Response(got.stream).text()).toBe('world');
  await s3.delete(key);
});

test.if(available)('a missing object is notFound, not a generic failure', async () => {
  // The whole error surface depends on this mapping: a 404 has to become notFound so
  // callers can distinguish "gone" from "broken".
  await expect(s3.head(KEY('never-written.txt'))).rejects.toMatchObject({ code: 'not_found' });
});

test.if(available)('delete is idempotent', async () => {
  // S3 returns 204 for a delete of something that was never there. Cleanup paths run
  // after partial failures, so a second delete must not throw.
  const key = KEY('twice.txt');
  await s3.put(key, 'x', { contentType: 'text/plain' });
  await s3.delete(key);
  await s3.delete(key);
});

test.if(available)('a presigned GET is fetchable by a client that has no credentials', async () => {
  // This is the point of presigning: the browser talks to S3 directly, with nothing
  // but the URL. A plain fetch, no auth headers.
  const key = KEY('presigned.txt');
  await s3.put(key, 'straight from the bucket', { contentType: 'text/plain' });
  const res = await fetch(await s3.presignGet(key, { expiresIn: 60 }));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('straight from the bucket');
  await s3.delete(key);
});

test.if(available)('a presigned PUT accepts an upload from a client that has no credentials', async () => {
  const key = KEY('presigned-put.txt');
  const res = await fetch(await s3.presignPut(key, { contentType: 'text/plain' }), {
    method: 'PUT', body: 'uploaded direct', headers: { 'content-type': 'text/plain' },
  });
  expect(res.ok).toBe(true);
  expect(await new Response((await s3.get(key)).stream).text()).toBe('uploaded direct');
  await s3.delete(key);
});

test.if(available)('a multipart upload reassembles in part order', async () => {
  // Parts are uploaded concurrently and can complete out of order, so completeMultipart
  // sorts them. A drive that reassembles a large file backwards is worse than one that
  // fails the upload.
  const key = KEY('big.bin');
  const uploadId = await s3.createMultipart(key, { contentType: 'application/octet-stream' });
  expect(uploadId).toBeTruthy();
  const part1 = 'A'.repeat(5 * 1024 * 1024); // S3 requires ≥5 MiB for all but the last
  const part2 = 'B'.repeat(1024);
  // Deliberately upload the LAST part first.
  const p2 = await s3.putPart(key, uploadId, 2, part2);
  const p1 = await s3.putPart(key, uploadId, 1, part1);
  await s3.completeMultipart(key, uploadId, [p2, p1]);

  const head = await s3.head(key);
  expect(head.size).toBe(part1.length + part2.length);
  const tail = await s3.get(key, { range: { start: part1.length, end: part1.length + 4 } });
  expect(await new Response(tail.stream).text()).toBe('BBBBB');
  await s3.delete(key);
});

test.if(available)('a presigned part URL uploads without credentials', async () => {
  const key = KEY('presigned-part.bin');
  const uploadId = await s3.createMultipart(key, {});
  const res = await fetch(await s3.presignPart(key, uploadId, 1, { expiresIn: 60 }), {
    method: 'PUT', body: 'x'.repeat(1024),
  });
  expect(res.ok).toBe(true);
  expect(res.headers.get('etag')).toBeTruthy();

  // Abandoning an upload must not leave the object half-written. s3rver has no route
  // for AbortMultipartUpload (`DELETE /key?uploadId=…`) and answers 405, so this half
  // only runs against a real server. Left in rather than deleted: it is the assertion
  // that matters for the maintenance sweep that reaps abandoned sessions, and a silent
  // omission here would read as coverage we don't have.
  if (EXTERNAL) {
    await s3.abortMultipart(key, uploadId);
    await expect(s3.head(key)).rejects.toMatchObject({ code: 'not_found' });
  }
});

test.if(available)('keys that need escaping survive the round trip', async () => {
  // Storage keys are generated ids today, but a prefix or a future caller can put a
  // space or a non-ASCII character in one, and that is exactly the case where the
  // signed URL and the sent URL diverge. Against a signature-verifying server
  // (TROVE_S3_TEST_ENDPOINT), this is the test that would 403.
  for (const name of ['my notes.txt', '日本語.md', "it's (a) file!.txt", 'a+b=c.txt']) {
    const key = KEY(name);
    await s3.put(key, `contents of ${name}`, { contentType: 'text/plain' });
    expect(await new Response((await s3.get(key)).stream).text()).toBe(`contents of ${name}`);
    const res = await fetch(await s3.presignGet(key, { expiresIn: 60 }));
    expect(res.status).toBe(200);
    await s3.delete(key);
  }
});

test.if(available)('a download name becomes a Content-Disposition on the presigned URL', async () => {
  const key = KEY('report.bin');
  await s3.put(key, 'data', { contentType: 'application/octet-stream' });
  const url = await s3.presignGet(key, { downloadName: 'Q3 report.pdf', expiresIn: 60 });
  expect(decodeURIComponent(new URL(url).search)).toContain('attachment; filename="Q3 report.pdf"');
  await s3.delete(key);
});

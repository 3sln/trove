// SigV4 — the part of the S3 backend that is invisible until it is wrong, and then
// fails as a flat 403 with no clue in it.
//
// Testing a signer against your own verifier proves nothing, so this file never does
// that. It checks our signature against two things we did not write:
//
//   1. AWS's own published worked example (a hardcoded expected signature from the S3
//      documentation), which anchors the whole algorithm — key derivation, canonical
//      request, string to sign.
//   2. `aws4`, an independent, long-established SigV4 implementation, run over a corpus
//      of awkward object keys. That is where encoding bugs live, and it is how the
//      double-encoded path bug below was found.
//
// The third property has no external oracle and needs none: the URL we SIGN must be
// byte-identical to the URL we SEND. S3 recomputes the signature from the request it
// receives, so any disagreement between the two is a guaranteed 403 no matter how
// correct the algorithm is.

import { test, expect } from 'bun:test';
import aws4 from 'aws4';
import { presignUrl, signRequest, uriEncode } from '../src/storage/s3sigv4.js';
import { S3Storage } from '../src/index.js';

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};

// Both signers stamp the request with "now", so a comparison needs a shared clock.
const FIXED = new Date('2013-05-24T00:00:00Z');
async function atFixedTime(fn) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { return a.length ? new Real(...a) : new Real(FIXED); }
    static now() { return FIXED.getTime(); }
  };
  try { return await fn(); } finally { globalThis.Date = Real; }
}

const sigOf = (auth) => /Signature=([0-9a-f]+)/.exec(auth)?.[1];

// Object keys that have historically broken S3 signing. Every one of these produces a
// path that differs between `encodeURIComponent` and SigV4's UriEncode.
const AWKWARD_KEYS = [
  'obj_deadbeef1234',            // the ordinary case
  'my notes.txt',                // a space — by far the most common real filename
  'a+b=c.txt',                   // characters with meaning in a query string
  '日本語.md',                     // multi-byte UTF-8
  "it's (a) file!.txt",          // encodeURIComponent leaves !'()* alone; SigV4 does not
  'plugins/pkg_1/bundle.zip',    // slashes are separators, not data
  'a~b.txt',                     // ~ is unreserved and must NOT be encoded
  'a&b?c#d.txt',                 // would otherwise split the URL
];

test('the AWS documented presign example reproduces exactly', async () => {
  // GET /test.txt from examplebucket, 2013-05-24, expires in 86400 — the worked
  // example in AWS's "Authenticating Requests: Using Query Parameters". The expected
  // signature comes from AWS, not from us, so this fails if the algorithm drifts.
  const url = await atFixedTime(() => presignUrl(CREDS, {
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    expiresIn: 86400,
  }));
  const q = new URL(url).searchParams;
  expect(q.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  expect(q.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  expect(q.get('X-Amz-SignedHeaders')).toBe('host');
  expect(q.get('X-Amz-Date')).toBe('20130524T000000Z');
});

test('header signatures match an independent implementation on awkward keys', async () => {
  const mismatched = [];
  for (const key of AWKWARD_KEYS) {
    const url = `https://examplebucket.s3.amazonaws.com/${uriEncode(key, false)}`;
    const ours = await signRequest(CREDS, { method: 'GET', url });
    const u = new URL(url);
    const theirs = aws4.sign({
      host: u.host, method: 'GET', path: u.pathname, service: 's3', region: 'us-east-1',
      // Bind the same header set on both sides — a different set is a different
      // signature for reasons that have nothing to do with correctness.
      headers: { 'X-Amz-Date': ours['x-amz-date'], 'X-Amz-Content-Sha256': ours['x-amz-content-sha256'] },
    }, CREDS);
    if (sigOf(ours.Authorization) !== sigOf(theirs.headers.Authorization)) mismatched.push(key);
  }
  expect(mismatched).toEqual([]);
});

test('presigned signatures match an independent implementation on awkward keys', async () => {
  const mismatched = [];
  for (const key of AWKWARD_KEYS) {
    const u = new URL(`https://examplebucket.s3.amazonaws.com/${uriEncode(key, false)}`);
    const [ours, theirs] = await atFixedTime(async () => [
      new URL(await presignUrl(CREDS, { method: 'GET', url: u.toString(), expiresIn: 86400 })),
      aws4.sign({ host: u.host, method: 'GET', path: u.pathname, service: 's3', region: 'us-east-1', signQuery: true }, CREDS),
    ]);
    const mine = ours.searchParams.get('X-Amz-Signature');
    const yours = new URLSearchParams(theirs.path.split('?')[1]).get('X-Amz-Signature');
    if (mine !== yours) mismatched.push(key);
  }
  expect(mismatched).toEqual([]);
});

test('the URL we sign is the URL we send', async () => {
  // The bug this pins down: S3Storage built its URL with encodeURIComponent while the
  // signer re-encoded the already-encoded pathname, so a key with a space went out as
  // %20 and was signed as %2520. Every such object 403s against real S3 — and no
  // in-process mock catches it, because a mock that doesn't verify signatures is happy
  // either way.
  // A presigned URL carries both halves: the path a client will actually request, and
  // a signature over it. Hand that exact path to an independent signer — which is all
  // S3 does — and the signatures must agree.
  const s3 = new S3Storage({ bucket: 'examplebucket', region: 'us-east-1', accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey });
  const rejected = [];
  for (const key of AWKWARD_KEYS) {
    const [presigned, verifier] = await atFixedTime(async () => {
      const url = new URL(await s3.presignGet(key, { expiresIn: 86400 }));
      return [url, aws4.sign({ host: url.host, method: 'GET', path: url.pathname, service: 's3', region: 'us-east-1', signQuery: true }, CREDS)];
    });
    const mine = presigned.searchParams.get('X-Amz-Signature');
    const theirs = new URLSearchParams(verifier.path.split('?')[1]).get('X-Amz-Signature');
    if (mine !== theirs) rejected.push(`${key} → ${presigned.pathname}`);
  }
  expect(rejected).toEqual([]);
});

test('uriEncode follows RFC 3986, not encodeURIComponent', async () => {
  // Unreserved characters survive; everything else is escaped uppercase-hex.
  expect(uriEncode("abcXYZ019-._~")).toBe('abcXYZ019-._~');
  expect(uriEncode("it's (a)!*")).toBe('it%27s%20%28a%29%21%2A');
  expect(uriEncode('a/b')).toBe('a%2Fb');
  expect(uriEncode('a/b', false)).toBe('a/b'); // path mode: slashes are separators
  expect(uriEncode('é')).toBe('%C3%A9'); // per UTF-8 byte, uppercase hex
});

test('a different secret produces a different signature', async () => {
  // Cheap, but it is the property that makes all of the above worth anything: if the
  // secret never reached the signing key, every test here would still pass.
  const url = 'https://examplebucket.s3.amazonaws.com/test.txt';
  const a = await atFixedTime(() => signRequest(CREDS, { method: 'GET', url }));
  const b = await atFixedTime(() => signRequest({ ...CREDS, secretAccessKey: 'a-different-secret' }, { method: 'GET', url }));
  expect(sigOf(a.Authorization)).not.toBe(sigOf(b.Authorization));
});

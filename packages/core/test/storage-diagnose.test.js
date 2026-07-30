// The check that would have caught the bug that motivated it.
//
// A bucket with no CORS policy serves the server perfectly and serves the browser
// nothing: the file list works, search works, and every file opens to a spinner that
// never resolves. Nothing in the drive knew, because the only party that enforces CORS
// is the browser. These tests pin the one thing that makes it detectable — that the
// check is a real preflight, so a server-side pass means a browser-side pass.

import { test, expect } from 'bun:test';
import { diagnoseStorage, corsPolicy, MemoryStorage, StorageBackend, STORAGE_ISSUE_CODES } from '../src/index.js';

const ORIGIN = 'https://drive.example.com';

/** A store that presigns, so CORS applies to it — as S3 and R2 do. */
class DirectStore extends StorageBackend {
  constructor(headers, { failList = false } = {}) {
    super();
    this.headers = headers;
    this.failList = failList;
    this.preflights = [];
    this.gets = [];
  }
  // A getter, like every real backend — StorageBackend declares it as one.
  get capabilities() {
    return { presignDownload: true };
  }
  async list() {
    if (this.failList) throw new Error('The specified bucket does not exist');
    return { items: [] };
  }
  async presignGet(key) {
    return `https://bucket.example.net/${key}?X-Amz-Signature=abc`;
  }
  /**
   * Stands in for the network.
   *
   * Deliberately answers the preflight WITHOUT expose-headers and the real GET with them,
   * which is how the spec has it and how several stores behave. A checker that read
   * exposeHeaders off the preflight would report this correct bucket as broken.
   */
  fetch = async (url, init) => {
    const method = init?.method || 'GET';
    if (method === 'OPTIONS') this.preflights.push({ url, method, headers: init?.headers });
    else this.gets.push({ url, method, headers: init?.headers });
    if (this.headers === 'throw') throw new Error('getaddrinfo ENOTFOUND');
    const h = { ...this.headers };
    if (method === 'OPTIONS') delete h['access-control-expose-headers'];
    else delete h['access-control-allow-headers'];
    return new Response(null, { status: method === 'OPTIONS' ? 200 : 404, headers: h });
  };
}

const GOOD = {
  'access-control-allow-origin': ORIGIN,
  'access-control-allow-headers': 'content-type, range',
  'access-control-expose-headers': 'ETag, Content-Length, Content-Type, Content-Range, Accept-Ranges',
};

const codes = (findings) => findings.map((f) => f.code);

test('a bucket with no CORS policy is reported, with the policy to apply', async () => {
  // The actual production failure: 200 from the store, no allow-origin header, so the
  // browser discards a response the server can read fine.
  const store = new DirectStore({});
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, driver: 's3', fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['cors-missing']);
  expect(found[0].severity).toBe('error');
  // The remedy has to be actionable — a diagnostic that names a problem the admin has
  // never heard of, without the fix, has told them nothing.
  expect(found[0].remedy).toContain(ORIGIN);
  expect(found[0].remedy).toContain('wrangler r2 bucket cors put');
  // And it says what the user is seeing, because that is how they find this message.
  expect(found[0].detail).toContain('refuse every download');
});

test('the check is a real preflight against a presigned URL', async () => {
  // This is the whole design: if it passes for us it passes for the browser, because it
  // is the same request. A check that only asked the store for its config would not
  // survive a proxy, a bucket policy or a signing difference.
  const store = new DirectStore(GOOD);
  await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(store.preflights.length).toBe(1);
  const p = store.preflights[0];
  expect(p.method).toBe('OPTIONS');
  expect(p.headers.origin).toBe(ORIGIN);
  expect(p.headers['access-control-request-method']).toBe('GET');
  expect(p.headers['access-control-request-headers']).toContain('range');
  // Against a key that need not exist — a preflight is answered without a lookup, so the
  // check costs nothing and works on an empty bucket.
  expect(p.url).toContain('.trove-cors-probe');
});

test('exposed headers are read off the real response, not the preflight', async () => {
  // Where the spec puts them, and where the browser looks. Reading them off the OPTIONS
  // response reported correctly configured buckets as hiding headers they do expose.
  const store = new DirectStore(GOOD);
  expect(await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch })).toEqual([]);
  expect(store.gets.length).toBe(1);
  expect(store.gets[0].headers.origin).toBe(ORIGIN);
  // The probe key still does not have to exist — a 404 carries the CORS headers.
  expect(store.gets[0].url).toContain('.trove-cors-probe');
});

test('a preflight that passes and a GET that cannot be sent is not a finding', async () => {
  // The policy is already known to be in place; failing to complete a second request says
  // nothing further about it, and warning would be guessing.
  const store = new DirectStore(GOOD);
  let first = true;
  const flaky = async (url, init) => {
    if (init?.method === 'OPTIONS') return store.fetch(url, init);
    if (first) { first = false; throw new Error('socket hang up'); }
    return store.fetch(url, init);
  };
  expect(await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: flaky })).toEqual([]);
});

test('a correctly configured store reports nothing', async () => {
  const store = new DirectStore(GOOD);
  expect(await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch })).toEqual([]);
});

test('a wildcard policy is accepted', async () => {
  const store = new DirectStore({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
  });
  expect(await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch })).toEqual([]);
});

test('a policy for the wrong origin is as broken as no policy', async () => {
  // The failure mode of copying a policy between deployments. It looks configured.
  const store = new DirectStore({ ...GOOD, 'access-control-allow-origin': 'https://staging.example.com' });
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['cors-origin']);
  expect(found[0].detail).toContain('staging.example.com');
  expect(found[0].detail).toContain(ORIGIN);
});

test('a policy that allows the origin but blocks ranges is a warning, not an error', async () => {
  // Small files open; seeking in video and previewing a large file do not. The drive is
  // usable, so calling this an error would be crying wolf.
  const store = new DirectStore({ ...GOOD, 'access-control-allow-headers': 'content-type' });
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['cors-headers']);
  expect(found[0].severity).toBe('warning');
});

test('headers the viewer cannot read are reported separately', async () => {
  const store = new DirectStore({ ...GOOD, 'access-control-expose-headers': 'ETag' });
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['cors-expose']);
  expect(found[0].detail).toContain('content-range');
});

test('an unreachable store short-circuits the CORS check', async () => {
  // "CORS is not configured" about a bucket whose name is wrong would send an admin to
  // fix the wrong thing.
  const store = new DirectStore(GOOD, { failList: true });
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['storage-unreachable']);
  expect(found[0].detail).toContain('bucket does not exist');
  expect(store.preflights.length).toBe(0);
});

test('a preflight that cannot be sent is not reported as a CORS problem', async () => {
  const store = new DirectStore('throw');
  const found = await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch });
  expect(codes(found)).toEqual(['cors-unknown']);
  expect(found[0].severity).toBe('warning');
});

test('a store the browser never talks to is not checked at all', async () => {
  // Filesystem and memory drives proxy every byte through the server, so it is all
  // same-origin and CORS cannot apply. Reporting a bucket policy there would be a
  // problem the admin has no way to have.
  let called = false;
  const found = await diagnoseStorage({
    storage: new MemoryStorage(), origin: ORIGIN, fetchImpl: () => { called = true; },
  });
  expect(found).toEqual([]);
  expect(called).toBe(false);
});

test('without a known origin the CORS half is skipped rather than guessed', async () => {
  // A policy is allowed to name one origin, so checking an invented one would report a
  // problem that does not exist.
  const store = new DirectStore({});
  expect(await diagnoseStorage({ storage: store, fetchImpl: store.fetch })).toEqual([]);
  expect(store.preflights.length).toBe(0);
});

test('every code a check can produce is in the clearable list', async () => {
  // The caller raises these as issues and clears the ones no longer reported — that is
  // what makes fixing the bucket make the warning disappear. A code missing from this
  // list would be a warning that could never be cleared.
  const produced = ['storage-unreachable', 'cors-missing', 'cors-origin', 'cors-headers', 'cors-expose', 'cors-unknown'];
  for (const code of produced) expect(STORAGE_ISSUE_CODES).toContain(code);
  expect(STORAGE_ISSUE_CODES.length).toBe(produced.length);
});

test('the published policy is the one the drive actually needs', async () => {
  const [policy] = corsPolicy(ORIGIN);
  expect(policy.AllowedOrigins).toEqual([ORIGIN]);
  // PUT because uploads are presigned direct-to-store too, so a read-only policy breaks
  // uploading while leaving downloads working.
  expect(policy.AllowedMethods).toEqual(expect.arrayContaining(['GET', 'PUT', 'HEAD']));
  expect(policy.AllowedHeaders).toContain('range');
  expect(policy.ExposeHeaders).toContain('Content-Range');
  // And applying it satisfies the checker — the advice and the check cannot disagree.
  const store = new DirectStore({
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': policy.AllowedHeaders.join(', '),
    'access-control-expose-headers': policy.ExposeHeaders.join(', '),
  });
  expect(await diagnoseStorage({ storage: store, origin: ORIGIN, fetchImpl: store.fetch })).toEqual([]);
});

// The download plan — the mirror of the upload plan.
//
// Encryption here defends the STORAGE HOST, not the server and not the client: the server
// holds the key already in order to index, and the client is handed it on upload so it can
// seal before the bytes leave the browser. The same trade has to run the other way, or
// encryption quietly costs a deployment its direct downloads — `getDownload` refuses to
// redirect to ciphertext unless asked, nothing asked, and every read of an encrypted
// collection proxied through the drive. The collections that most wanted direct transfer
// got the least.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import {
  CollectionService, MemoryKV, MemoryStorage, SignedUrls,
  encrypt, fromHex, DEFAULT_CHUNK_SIZE,
} from '@3sln/trove/core';

const ADMIN = 'boss@example.com';
const asAdmin = { 'x-user': ADMIN };
const BOSS = { id: ADMIN, email: ADMIN, roles: [] };

/** A store that can hand out URLs — every in-repo test backend otherwise cannot. */
class PresigningStorage extends MemoryStorage {
  get capabilities() {
    return { ...super.capabilities, presignDownload: true };
  }
  async presignGet(key) {
    return `https://bucket.example/${encodeURIComponent(key)}?signed=1`;
  }
}

async function drive({ encrypted = true } = {}) {
  const kv = new MemoryKV();
  const storage = new PresigningStorage();
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [ADMIN], defaultOpen: false,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    signedUrls: new SignedUrls({ secret: 'test-secret' }),
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const c = await collections.create({
    name: 'C',
    store: { driver: 'memory' },
    ...(encrypted ? { encryption: { enabled: true, rules: { all: true } } } : {}),
  }, BOSS);
  return { ...server, collections, storage, c };
}

/**
 * Seal a file the way a browser upload does and record it.
 *
 * NOT `vfs.writeFile` — a server-side write stores plaintext and leaves `encryption`
 * unset on the item, so a plan for it would correctly report "nothing to decrypt" and the
 * test would pass while proving nothing.
 */
async function putSealed(d, name, bytes) {
  const key = await d.collections.dataKeyFor(d.c.id);
  const sealed = await encrypt(key, new Uint8Array(bytes), {
    fingerprint: fromHex(d.c.encryption.fingerprint), chunkSize: DEFAULT_CHUNK_SIZE,
  });
  const storageKey = `obj_${name}`;
  await d.storage.put(storageKey, sealed, { contentType: 'application/octet-stream' });
  const node = await d.vfs.metadata.create({
    collectionId: d.c.id, name, storageKey, size: bytes.length,
    contentType: 'application/octet-stream',
    encryption: { fingerprint: d.c.encryption.fingerprint, chunkSize: DEFAULT_CHUNK_SIZE },
  });
  return node.id;
}

const get = (handle, path, headers = asAdmin) =>
  handle(new Request(`https://drive.test${path}`, { headers }));

test('the plan hands over a direct URL and the key that opens it', async () => {
  const d = await drive();
  const id = await putSealed(d, 'a.bin', [1, 2, 3, 4]);

  const res = await get(d.handle, `/api/items/download/plan?id=${id}`);
  expect(res.status).toBe(200);
  const plan = await res.json();

  expect(plan.direct).toBe(true);
  expect(plan.url).toContain('bucket.example');
  // The key travels, the bytes do not.
  expect(plan.encryption.algorithm).toBe('AES-256-GCM');
  expect(plan.encryption.key).toMatch(/^[0-9a-f]{64}$/);
  expect(plan.encryption.chunkSize).toBeGreaterThan(0);
  expect(plan.encryption.fingerprint).toBeTruthy();
  await d.close?.();
});

test('the plan is session-only, so a signature cannot reach the collection key', async () => {
  // Not a defence against anything that happens today: nothing fetches a JSON plan with a
  // signed URL, because signatures exist for callers that cannot send a header and want
  // BYTES. This pins the asymmetry for whoever later extends signatures across the API —
  // one grants `read` on a single node, the other returns a key that opens the collection.
  const d = await drive();
  const id = await putSealed(d, 'a.bin', [1, 2, 3, 4]);
  const g = await d.vfs.signedUrls.grant(id, { op: 'download' });
  const q = `id=${id}&op=${g.op}&exp=${g.exp}&sig=${encodeURIComponent(g.sig)}`;

  // The same grant, on the same drive, with no ambient identity: the download route
  // honours it (that is the whole point of a signed URL) …
  const download = await get(d.handle, `/api/items/download?${q}`, {});
  expect(download.status).toBeLessThan(400);

  // … and the plan route does not, because the key it would return opens every other
  // file in the collection too.
  const plan = await get(d.handle, `/api/items/download/plan?${q}`, {});
  expect(plan.status).toBeGreaterThanOrEqual(400);
  await d.close?.();
});

test('an unencrypted object still gets the direct URL, with no key', async () => {
  const d = await drive({ encrypted: false });
  const id = (await d.vfs.writeFile('plain.bin', new Uint8Array([9, 9, 9]), {
    collectionId: d.c.id, contentType: 'application/octet-stream',
  })).id;
  const plan = await (await get(d.handle, `/api/items/download/plan?id=${id}`)).json();
  expect(plan.direct).toBe(true);
  expect(plan.encryption).toBe(null);
  await d.close?.();
});

test('a store that cannot presign reports direct:false rather than inventing a URL', async () => {
  // The caller keeps proxying, which is correct and is what it already did.
  const kv = new MemoryKV();
  const storage = new MemoryStorage(); // presignDownload: false
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [ADMIN], defaultOpen: false,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const c = await collections.create({
    name: 'C', store: { driver: 'memory' }, encryption: { enabled: true, rules: { all: true } },
  }, BOSS);
  const id = (await server.vfs.writeFile('a.bin', new Uint8Array([1, 2, 3]), {
    collectionId: c.id, contentType: 'application/octet-stream',
  })).id;

  const plan = await (await get(server.handle, `/api/items/download/plan?id=${id}`)).json();
  expect(plan.direct).toBe(false);
  expect(plan.url).toBeUndefined();
  await server.close?.();
});

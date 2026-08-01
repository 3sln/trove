// What a minted URL may point at, once a collection is encrypted.
//
// `mintUrl` presigned straight to the store whenever the store COULD, and never asked
// whether the object was sealed — while `getDownload`, two hundred lines away, has exactly
// that guard. So on any encrypted collection with a presigning store, every thumbnail,
// every preview and every URL handed to an external service pointed at CIPHERTEXT and
// rendered nothing.
//
// A bucket URL is also a different origin, which is why nothing on our side could rescue
// it: the bytes never came past us at all.

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

test('a minted media URL for an encrypted object goes through us, not the bucket', async () => {
  // `mintUrl` presigned to the store whenever the store could, without asking whether the
  // object was sealed — so every thumbnail and preview in an encrypted collection pointed
  // at ciphertext and rendered nothing. And a bucket URL is a different origin, so the
  // service worker never saw it: the one thing that could have decrypted was routed around.
  const d = await drive();
  const id = await putSealed(d, 'pic.png', [1, 2, 3, 4]);
  const minted = await d.vfs.mintUrl(id, { op: 'media' });
  expect(minted.signed).toBe('trove');
  expect(minted.url).toContain('/api/items/download');
  expect(minted.url).not.toContain('bucket.example');
  await d.close?.();
});

test('an unencrypted object on the same store still gets the bucket URL', async () => {
  // The direct path is the point everywhere it is safe — this narrows it, it does not
  // remove it.
  const d = await drive({ encrypted: false });
  const id = (await d.vfs.writeFile('plain.png', new Uint8Array([1, 2, 3]), {
    collectionId: d.c.id, contentType: 'image/png',
  })).id;
  const minted = await d.vfs.mintUrl(id, { op: 'media' });
  expect(minted.signed).toBe('storage');
  expect(minted.url).toContain('bucket.example');
  await d.close?.();
});

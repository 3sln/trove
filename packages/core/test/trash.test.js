// The trash — the difference between a drive you'd keep your files in and one you
// wouldn't.
//
// Deleting used to destroy the bytes immediately. A confirm dialog is not a safety net;
// it is a thing people click through. So a delete now removes an item from the DRIVE
// while leaving it stored, and the only operations that actually destroy data are the
// ones a person explicitly asked for or a retention policy they configured.
//
// The properties worth pinning are mostly about what a trashed item must STOP doing.
// Half-deleting something — gone from the list but still answering links, still in
// search, still holding its name — would be worse than not having a trash at all.

import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVfs, MemoryStorage, MemoryStore, SqliteStore, LocalSqliteProvider } from '../src/index.js';

const drive = () => createVfs({ storage: new MemoryStorage() });
const names = async (vfs) => (await vfs.list('default')).items.map((i) => i.name).sort();

test('deleting removes an item from the drive but keeps the bytes', async () => {
  const vfs = await drive();
  const node = await vfs.writeFile('precious.md', '# Do not lose me', { contentType: 'text/markdown' });

  const result = await vfs.remove(node.id);
  expect(result.trashed).toBe(true);
  expect(await names(vfs)).toEqual([]);
  // The one thing that cannot be rebuilt is still there.
  expect(await vfs.storage.head(node.storageKey)).toBeTruthy();
  expect((await vfs.listTrash('default')).map((i) => i.name)).toEqual(['precious.md']);
});

test('a trashed item stops answering as part of the drive', async () => {
  // Every one of these is a way a "deleted" file could still be reachable. Missing any
  // of them makes the trash a lie.
  const vfs = await drive();
  const node = await vfs.writeFile('gone.md', 'sailing at dawn', { contentType: 'text/markdown' });
  await vfs.writeFile('index.md', 'see [it](trove:default?name=gone.md)', { contentType: 'text/markdown' });
  await vfs.setTag?.(node.id, 'kind', 'note').catch(() => {});
  expect((await vfs.backlinks(node.id)).length).toBe(1);

  await vfs.remove(node.id);
  expect(await vfs.find('gone.md')).toBe(null);            // by name
  expect(await vfs.find(node.id)).toBe(null);              // by id
  expect(await vfs.find('trove:default?name=gone.md')).toBe(null); // by link
  await expect(vfs.stat(node.id)).rejects.toMatchObject({ code: 'not_found' });
  // Out of the search index too, or it turns up in results and 404s when opened.
  expect((await vfs.search.keywords.search('sailing')).length).toBe(0);
  // And it no longer counts as a document that links anywhere.
  const other = await vfs.metadata.getByName('default', 'index.md');
  expect((await vfs.metadata.findLinksTo([`trove:default?id=${node.id}`])).map((n) => n.name)).toEqual([]);
  expect(other).toBeTruthy();
});

test('the trash does not hold the name hostage', async () => {
  // Under an unconditional unique index, deleting `notes.md` would block ever creating
  // another one — you could not re-create the thing you just deleted.
  const vfs = await drive();
  const first = await vfs.writeFile('notes.md', 'the original', { contentType: 'text/markdown' });
  await vfs.remove(first.id);
  const second = await vfs.writeFile('notes.md', 'a fresh start', { contentType: 'text/markdown' });
  expect(second.id).not.toBe(first.id);
  expect(await names(vfs)).toEqual(['notes.md']);
});

test('restoring brings an item back, findable again', async () => {
  const vfs = await drive();
  const node = await vfs.writeFile('report.md', 'quarterly numbers about sailing', { contentType: 'text/markdown' });
  await vfs.remove(node.id);
  const back = await vfs.restore(node.id);

  expect(back.name).toBe('report.md');
  expect(await names(vfs)).toEqual(['report.md']);
  // Re-indexed, not merely un-hidden — a restored file you can't search for isn't back.
  expect((await vfs.search.keywords.search('quarterly')).length).toBeGreaterThan(0);
  expect(await vfs.listTrash('default')).toEqual([]);
});

test('restoring into a taken name succeeds under a free one', async () => {
  // Someone restoring a file wants the file. Refusing over a name collision leaves them
  // with no way to get it back except to rename whatever took the name.
  const vfs = await drive();
  const original = await vfs.writeFile('notes.md', 'the original', { contentType: 'text/markdown' });
  await vfs.remove(original.id);
  await vfs.writeFile('notes.md', 'a different file, same name', { contentType: 'text/markdown' });

  const back = await vfs.restore(original.id);
  expect(back.name).toBe('notes (1).md');
  expect(await names(vfs)).toEqual(['notes (1).md', 'notes.md']);
});

test('restoring something that was never deleted is not an error', async () => {
  const vfs = await drive();
  const node = await vfs.writeFile('a.txt', 'x', { contentType: 'text/plain' });
  expect((await vfs.restore(node.id)).id).toBe(node.id);
});

test('a permanent delete really destroys the bytes', async () => {
  const vfs = await drive();
  const node = await vfs.writeFile('doomed.txt', 'x', { contentType: 'text/plain' });
  await vfs.remove(node.id, { permanent: true });
  expect(await vfs.listTrash('default')).toEqual([]);
  expect(await vfs.storage.head(node.storageKey).catch(() => null)).toBe(null);
});

test('emptying the trash works on items already out of the drive', async () => {
  // The purge path resolves ids that `find()` deliberately refuses to see. Getting this
  // wrong makes the trash impossible to empty.
  const vfs = await drive();
  const node = await vfs.writeFile('doomed.txt', 'x', { contentType: 'text/plain' });
  await vfs.remove(node.id);
  await vfs.remove(node.id, { permanent: true });
  expect(await vfs.listTrash('default')).toEqual([]);
});

test('retention purges what is old and keeps what is not', async () => {
  const vfs = await drive();
  const old = await vfs.writeFile('old.txt', 'x', { contentType: 'text/plain' });
  const recent = await vfs.writeFile('recent.txt', 'y', { contentType: 'text/plain' });
  await vfs.remove(old.id);
  await vfs.remove(recent.id);
  vfs.metadata.nodes.get(old.id).deletedAt = Date.now() - 40 * 86400_000;

  const result = await vfs.purgeTrash({ before: Date.now() - 30 * 86400_000 });
  expect(result.purged).toBe(1);
  expect((await vfs.listTrash('default')).map((i) => i.name)).toEqual(['recent.txt']);
  // The one it kept still has its bytes; the one it purged does not.
  expect(await vfs.storage.head(recent.storageKey)).toBeTruthy();
  expect(await vfs.storage.head(old.storageKey).catch(() => null)).toBe(null);
});

test('stats count the drive, and report the trash separately', async () => {
  const vfs = await drive();
  await vfs.writeFile('live.txt', 'abc', { contentType: 'text/plain' });
  const gone = await vfs.writeFile('gone.txt', 'defghij', { contentType: 'text/plain' });
  await vfs.remove(gone.id);
  const stats = await vfs.metadata.collectionStats('default');
  expect(stats).toMatchObject({ items: 1, bytes: 3, trashed: 1 });
});

test('a store with no trash still deletes, rather than silently not deleting', async () => {
  // Better a permanent delete than a delete that does nothing. A backend that can't
  // soft-delete must not turn "delete" into a no-op.
  class NoTrash extends MemoryStore {
    async softDelete() { throw Object.assign(new Error('nope'), { code: 'unsupported' }); }
  }
  const vfs = await createVfs({ storage: new MemoryStorage(), metadata: new NoTrash() });
  const node = await vfs.writeFile('x.txt', 'x', { contentType: 'text/plain' });
  const res = await vfs.remove(node.id);
  expect(res.trashed).toBe(false);
  expect(await names(vfs)).toEqual([]);
  expect(await vfs.storage.head(node.storageKey).catch(() => null)).toBe(null);
});

test('a database written before the trash existed migrates and keeps working', async () => {
  // The migration also has to REPLACE the name-uniqueness index with a partial one.
  // Left unconditional, the first delete on an upgraded drive would make that name
  // permanently unusable.
  const dir = await mkdtemp(join(tmpdir(), 'trove-trash-'));
  const path = join(dir, 'trove.db');
  try {
    // Build the pre-trash shape by hand: no deletedAt, unconditional unique index.
    const legacy = new LocalSqliteProvider({ path });
    const db = await legacy.obtain({ key: 'metadata' });
    await db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, collectionId TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0, contentType TEXT, storageKey TEXT, etag TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}', facets TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX idx_nodes_coll_name ON nodes(collectionId, name);
    `);
    await db.run(
      "INSERT INTO nodes (id,collectionId,name,size,createdAt,updatedAt) VALUES ('itm_old','default','legacy.txt',3,1,1)",
    );
    await legacy.close();

    const provider = new LocalSqliteProvider({ path });
    const store = new SqliteStore({ provider });
    await store.init(); // runs the migration

    expect((await store.listItems('default')).items.map((i) => i.name)).toEqual(['legacy.txt']);
    await store.softDelete('itm_old');
    expect((await store.listItems('default')).items).toEqual([]);
    // The freed name is usable again — which the old unconditional index would forbid.
    await store.create({ collectionId: 'default', name: 'legacy.txt' });
    expect((await store.listItems('default')).items.map((i) => i.name)).toEqual(['legacy.txt']);
    expect((await store.listTrash('default')).map((i) => i.id)).toEqual(['itm_old']);
    await provider.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

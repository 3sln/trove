// The SQLite provider/interface, the stores running over it, and the plugin-SQL
// safety screen. Exercises the real drivers (bun:sqlite / node:sqlite) via an
// in-memory provider.

import { test, expect } from 'bun:test';
import {
  LocalSqliteProvider, SqliteStore, SqliteKV, MemoryStore,
  assertSafePluginSql, stripSqlLiterals,
} from '../src/index.js';

function provider() {
  return new LocalSqliteProvider({ path: ':memory:' });
}

test('provider memoizes by key; core keys share, others are isolated', async () => {
  const p = provider();
  // Core keys (metadata, kv) resolve to the same shared handle.
  expect(await p.obtain({ key: 'metadata' })).toBe(await p.obtain({ key: 'kv' }));
  // Same non-core key → same handle; different keys → different, isolated dbs.
  const a1 = await p.obtain({ key: 'plg:a' });
  expect(await p.obtain({ key: 'plg:a' })).toBe(a1);
  const b1 = await p.obtain({ key: 'plg:b' });
  expect(b1).not.toBe(a1);

  await a1.exec('CREATE TABLE t (x)');
  await a1.run('INSERT INTO t VALUES (?)', 1);
  expect((await a1.all('SELECT x FROM t')).length).toBe(1);
  // b is a separate database — a's table doesn't exist there.
  let leaked = true;
  try { await b1.all('SELECT x FROM t'); } catch { leaked = false; }
  expect(leaked).toBe(false);
});

test('batch is atomic — a failing statement rolls the whole thing back', async () => {
  const db = await provider().obtain({ key: 'plg:tx' });
  await db.exec('CREATE TABLE t (x UNIQUE)');
  await db.run('INSERT INTO t VALUES (1)');
  let threw = false;
  try {
    await db.batch([{ sql: 'INSERT INTO t VALUES (2)', params: [] }, { sql: 'INSERT INTO t VALUES (1)' }]);
  } catch { threw = true; }
  expect(threw).toBe(true);
  // The 2 never landed because the duplicate 1 aborted+rolled back the batch.
  expect((await db.all('SELECT x FROM t ORDER BY x')).map((r) => r.x)).toEqual([1]);
});

test('drop() destroys a key\'s database', async () => {
  const p = provider();
  const db = await p.obtain({ key: 'plg:d' });
  await db.exec('CREATE TABLE t (x)');
  await db.run('INSERT INTO t VALUES (1)');
  await p.drop({ key: 'plg:d' });
  // A fresh, empty db is created on next obtain.
  const fresh = await p.obtain({ key: 'plg:d' });
  let hasTable = true;
  try { await fresh.all('SELECT x FROM t'); } catch { hasTable = false; }
  expect(hasTable).toBe(false);
});

test('SqliteStore over the provider: create, list by collection, rename', async () => {
  const store = new SqliteStore({ provider: provider(), key: 'metadata' });
  await store.init();
  const x = await store.create({ name: 'x.txt' });
  await store.create({ name: 'a.txt' });
  await store.create({ collectionId: 'other', name: 'x.txt' }); // same name, other collection

  const listed = await store.listItems('default');
  expect(listed.items.map((n) => n.name)).toEqual(['a.txt', 'x.txt']);
  expect((await store.listItems('other')).items.map((n) => n.name)).toEqual(['x.txt']);

  expect((await store.getByName('default', 'x.txt')).id).toBe(x.id);
  const renamed = await store.rename(x.id, 'z.txt');
  expect(renamed.name).toBe('z.txt');
  expect(await store.getByName('default', 'x.txt')).toBe(null);
});

test('SqliteStore findLinksTo answers backlinks from the links contribution', async () => {
  const store = new SqliteStore({ provider: provider() });
  await store.init();
  const target = await store.create({ name: 'target.md' });
  const index = await store.create({ name: 'index.md' });
  await store.create({ name: 'unrelated.md' });
  await store.setContribution(index.id, 'core.links', {
    metadata: { links: ['trove:default?name=target.md'] },
  });

  const hits = await store.findLinksTo(['trove:default?name=target.md', `trove:default?id=${target.id}`]);
  expect(hits.map((n) => n.name)).toEqual(['index.md']);
  expect(await store.findLinksTo(['trove:default?name=nobody.md'])).toEqual([]);
  expect(await store.findLinksTo([])).toEqual([]);
});

test('SqliteStore rejects duplicate names in a collection', async () => {
  const store = new SqliteStore({ provider: provider() });
  await store.init();
  await store.create({ name: 'dup' });
  let threw = false;
  try { await store.create({ name: 'dup' }); } catch { threw = true; }
  expect(threw).toBe(true);
});

test('SqliteKV over the provider: set/get/list/delete with JSON values', async () => {
  const kv = new SqliteKV({ provider: provider(), key: 'kv' });
  await kv.init();
  await kv.set('ns', 'k1', { n: 1 });
  await kv.set('ns', 'k2', [2, 3]);
  expect(await kv.get('ns', 'k1')).toEqual({ n: 1 });
  expect((await kv.list('ns', 'k')).length).toBe(2);
  await kv.delete('ns', 'k1');
  expect(await kv.get('ns', 'k1')).toBe(null);
});

async function seedTagged(store) {
  await store.init();
  const a = await store.create({ parentId: 'root', name: 'a.txt', kind: 'file' });
  const sub = await store.create({ parentId: 'root', name: 'sub', kind: 'folder' });
  const b = await store.create({ parentId: sub.id, name: 'b.txt', kind: 'file' });
  await store.create({ parentId: 'root', name: 'plain.txt', kind: 'file' });
  await store.setContribution(a.id, 'user', { tags: { fav: 'yes', rating: '5' } });
  await store.setContribution(b.id, 'user', { tags: { fav: 'yes', rating: '2' } }); // subfolder → drive-wide
  return { a, b };
}

test('findByTags (SqliteStore): drive-wide presence + numeric + string', async () => {
  const store = new SqliteStore({ provider: provider(), key: 'metadata' });
  await seedTagged(store);
  const names = async (filters, opts) => (await store.findByTags(filters, opts)).map((n) => n.name).sort();
  expect(await names([{ key: 'fav', present: true }])).toEqual(['a.txt', 'b.txt']); // across folders
  expect(await names([{ key: 'rating', op: '>=', value: 4 }])).toEqual(['a.txt']);   // numeric via CAST
  expect(await names([{ key: 'rating', op: '<', value: 4 }])).toEqual(['b.txt']);
  expect(await names([{ key: 'fav', op: '=', value: 'no' }])).toEqual([]);            // string
  expect(await names([{ key: 'fav', present: true }], { q: 'b' })).toEqual(['b.txt']); // + name
});

test('findByTags (MemoryStore) matches the SqliteStore behaviour', async () => {
  const store = new MemoryStore();
  await seedTagged(store);
  const names = async (f) => (await store.findByTags(f)).map((n) => n.name).sort();
  expect(await names([{ key: 'fav', present: true }])).toEqual(['a.txt', 'b.txt']);
  expect(await names([{ key: 'rating', op: '>=', value: 4 }])).toEqual(['a.txt']);
  expect(await names([{ key: 'missing', present: true }])).toEqual([]);
});

for (const [label, make] of [['SqliteStore', () => new SqliteStore({ provider: provider(), key: 'metadata' })], ['MemoryStore', () => new MemoryStore()]]) {
  test(`contributions: three scopes, merged tags, per-contributor removal (${label})`, async () => {
    const store = make();
    await store.init?.();
    const f = await store.create({ parentId: 'root', name: 'book.m4b', kind: 'file' });

    // Two contributors each add tags + metadata under their own namespace.
    await store.setContribution(f.id, 'user', { tags: { fav: 'yes' } });
    await store.setContribution(f.id, 'core.audiobook', {
      tags: { language: 'en' },
      metadata: { chapters: [{ title: 'Intro', start: 0 }, { title: 'One', start: 120 }] },
    });

    let node = await store.getById(f.id);
    // Kept separate per contributor…
    expect(node.contributions.user.tags.fav).toBe('yes');
    expect(node.contributions['core.audiobook'].metadata.chapters.length).toBe(2);
    // …and merged into one queryable tag view.
    expect(node.tags).toEqual({ fav: 'yes', language: 'en' });
    // Filterable by any contributor's tag.
    expect((await store.findByTags([{ key: 'language', op: '=', value: 'en' }])).map((n) => n.id)).toContain(f.id);

    // Removing one contributor drops only its tags + metadata; the other survives.
    await store.clearContribution(f.id, 'core.audiobook');
    node = await store.getById(f.id);
    expect(node.contributions['core.audiobook']).toBeUndefined();
    expect(node.contributions.user.tags.fav).toBe('yes');
    expect(node.tags).toEqual({ fav: 'yes' });
    expect((await store.findByTags([{ key: 'language', present: true }])).length).toBe(0);
  });
}

test('assertSafePluginSql blocks ATTACH/DETACH but allows normal SQL', () => {
  expect(() => assertSafePluginSql("SELECT * FROM t WHERE name = 'attach'")).not.toThrow(); // in a literal
  expect(() => assertSafePluginSql('CREATE TABLE t (x); INSERT INTO t VALUES (1)')).not.toThrow();
  expect(() => assertSafePluginSql("ATTACH DATABASE 'other.db' AS victim")).toThrow(/ATTACH/i);
  expect(() => assertSafePluginSql('DETACH victim')).toThrow(/ATTACH|DETACH/i);
  expect(() => assertSafePluginSql('SELECT 1 -- ATTACH\n')).not.toThrow(); // in a comment
  expect(() => assertSafePluginSql('')).toThrow(); // empty
});

test('stripSqlLiterals removes strings, comments, and bracket identifiers', () => {
  expect(stripSqlLiterals("x = 'ATTACH'")).not.toMatch(/ATTACH/);
  expect(stripSqlLiterals('a /* ATTACH */ b')).not.toMatch(/ATTACH/);
  expect(stripSqlLiterals('[ATTACH]')).not.toMatch(/ATTACH/);
});

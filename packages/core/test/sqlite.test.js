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

test('SqliteStore over the provider: create, list, move rewrites descendant paths', async () => {
  const store = new SqliteStore({ provider: provider(), key: 'metadata' });
  await store.init();
  const a = await store.create({ parentId: 'root', name: 'A', kind: 'folder' });
  const sub = await store.create({ parentId: a.id, name: 'sub', kind: 'folder' });
  const x = await store.create({ parentId: sub.id, name: 'x.txt', kind: 'file' });
  const t = await store.create({ parentId: 'root', name: 'T', kind: 'folder' });
  expect(x.path).toBe('/A/sub/x.txt');

  await store.move(a.id, t.id);
  expect((await store.getById(a.id)).path).toBe('/T/A');
  expect((await store.getById(x.id)).path).toBe('/T/A/sub/x.txt');
  const kids = await store.listChildren(t.id);
  expect(kids.items.map((n) => n.name)).toContain('A');
});

test('SqliteStore rejects duplicate names in a folder', async () => {
  const store = new SqliteStore({ provider: provider() });
  await store.init();
  await store.create({ parentId: 'root', name: 'dup', kind: 'folder' });
  let threw = false;
  try { await store.create({ parentId: 'root', name: 'dup', kind: 'folder' }); } catch { threw = true; }
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
  await store.setFacet(a.id, 'tags', { fav: 'yes', rating: '5' });
  await store.setFacet(b.id, 'tags', { fav: 'yes', rating: '2' }); // in a subfolder → drive-wide
  return { a, b };
}

test('findByFacets (SqliteStore): drive-wide presence + numeric + string', async () => {
  const store = new SqliteStore({ provider: provider(), key: 'metadata' });
  await seedTagged(store);
  const names = async (filters, opts) => (await store.findByFacets(filters, opts)).map((n) => n.name).sort();
  expect(await names([{ key: 'fav', present: true }])).toEqual(['a.txt', 'b.txt']); // across folders
  expect(await names([{ key: 'rating', op: '>=', value: 4 }])).toEqual(['a.txt']);   // numeric via CAST
  expect(await names([{ key: 'rating', op: '<', value: 4 }])).toEqual(['b.txt']);
  expect(await names([{ key: 'fav', op: '=', value: 'no' }])).toEqual([]);            // string
  expect(await names([{ key: 'fav', present: true }], { q: 'b' })).toEqual(['b.txt']); // + name
});

test('findByFacets (MemoryStore) matches the SqliteStore behaviour', async () => {
  const store = new MemoryStore();
  await seedTagged(store);
  const names = async (f) => (await store.findByFacets(f)).map((n) => n.name).sort();
  expect(await names([{ key: 'fav', present: true }])).toEqual(['a.txt', 'b.txt']);
  expect(await names([{ key: 'rating', op: '>=', value: 4 }])).toEqual(['a.txt']);
  expect(await names([{ key: 'missing', present: true }])).toEqual([]);
});

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

// SQLite on Cloudflare D1.
//
// D1 itself can't run here, so this drives the adapter against a shim with D1's exact
// API shape — prepare/bind/run/first/all plus a batch — backed by a real SQLite
// database. That tests the part that is actually ours: the translation between two
// dialects that are almost, but not quite, the same. `run()` returning `meta.changes`
// instead of `changes`, `all()` returning `{results}` instead of an array, and `exec()`
// choking on multi-statement DDL are each enough to make the whole drive fail to start,
// and each is invisible until something runs against a real binding.
//
// The stores under test are the real ones — SqliteStore, SqliteKV — so if the shape is
// wrong the failure surfaces the way it would in production.

import { test, expect } from 'bun:test';
import { D1SqliteProvider, splitStatements } from '../src/sqlite-d1.js';
import { LocalSqliteProvider, SqliteStore, SqliteKV, TroveError } from '../src/index.js';

/**
 * A D1 binding, faithfully shaped, over a real local database.
 *
 * Deliberately NOT a pass-through: it returns D1's response envelopes, so the adapter
 * has to do the unwrapping D1 would require of it.
 */
function fakeD1(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    async run() {
      const r = await db.run(sql, ...params);
      return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
    },
    async first() { return (await db.get(sql, ...params)) ?? null; },
    async all() { return { success: true, results: await db.all(sql, ...params) }; },
    _sql: sql,
    _params: params,
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      // D1 batches are atomic. So is this.
      await db.batch(statements.map((s) => ({ sql: s._sql, params: s._params })));
      return statements.map(() => ({ success: true }));
    },
  };
}

async function provider() {
  const local = new LocalSqliteProvider({ path: ':memory:' });
  await local.init();
  const raw = await local.obtain({ key: 'metadata' });
  return new D1SqliteProvider({ db: fakeD1(raw) });
}

test('multi-statement DDL is split, because D1 will not take it whole', async () => {
  // Every store's init() is a multi-statement schema script. D1's own exec() is
  // documented as slow and has been inconsistent about this; a batch of prepared
  // statements is faster AND atomic, which is what schema setup wants.
  expect(splitStatements('CREATE TABLE a (x); CREATE TABLE b (y);')).toEqual([
    'CREATE TABLE a (x)', 'CREATE TABLE b (y)',
  ]);
  expect(splitStatements('  ')).toEqual([]);
  expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);

  const p = await provider();
  const db = await p.obtain({ key: 'metadata' });
  await db.exec('CREATE TABLE t (a TEXT, b INTEGER);\nCREATE INDEX t_a ON t(a);');
  await db.run('INSERT INTO t VALUES (?, ?)', 'x', 1);
  expect(await db.get('SELECT a, b FROM t')).toEqual({ a: 'x', b: 1 });
});

test('run/get/all unwrap D1 envelopes into what callers expect', async () => {
  // D1 returns { meta: { changes } } and { results: [] }; better-sqlite3 returns
  // { changes } and a bare array. Callers are written against the latter.
  const p = await provider();
  const db = await p.obtain({ key: 'metadata' });
  await db.exec('CREATE TABLE t (a TEXT)');

  const w = await db.run('INSERT INTO t VALUES (?)', 'one');
  expect(w.changes).toBe(1);

  expect(await db.get('SELECT a FROM t WHERE a = ?', 'nope')).toBe(null); // not undefined
  const rows = await db.all('SELECT a FROM t');
  expect(Array.isArray(rows)).toBe(true); // not { results: [...] }
  expect(rows).toEqual([{ a: 'one' }]);
  expect(await db.all('SELECT a FROM t WHERE a = ?', 'nope')).toEqual([]);
});

test('a batch is atomic, the same promise the local provider makes', async () => {
  const p = await provider();
  const db = await p.obtain({ key: 'metadata' });
  await db.exec('CREATE TABLE t (a TEXT PRIMARY KEY)');
  await db.batch([
    { sql: 'INSERT INTO t VALUES (?)', params: ['a'] },
    { sql: 'INSERT INTO t VALUES (?)', params: ['b'] },
  ]);
  expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 'a' }, { a: 'b' }]);
  // A batch that violates a constraint takes none of it.
  await expect(db.batch([
    { sql: 'INSERT INTO t VALUES (?)', params: ['c'] },
    { sql: 'INSERT INTO t VALUES (?)', params: ['a'] }, // duplicate key
  ])).rejects.toThrow();
  expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 'a' }, { a: 'b' }]);
  await db.batch([]); // and an empty batch is not an error
});

test('the real metadata store runs on it', async () => {
  // The point of the exercise. If the dialect translation is wrong anywhere, the drive
  // fails to start rather than failing subtly later.
  const p = await provider();
  const store = new SqliteStore({ provider: p, key: 'metadata' });
  await store.init();
  const node = await store.create({ name: 'welcome.md', storageKey: 'obj_1', size: 12, contentType: 'text/markdown' });
  expect(node.id).toBeTruthy();

  const page = await store.listItems('default', { limit: 10 });
  expect(page.items.map((i) => i.name)).toEqual(['welcome.md']);
  expect(await store.getById(node.id)).toMatchObject({ name: 'welcome.md' });
  await store.rename(node.id, 'renamed.md');
  expect((await store.getById(node.id)).name).toBe('renamed.md');
});

test('and so does the key/value store', async () => {
  const p = await provider();
  const kv = new SqliteKV({ provider: p, key: 'kv' });
  await kv.init();
  await kv.set('ns', 'k', { hello: 'world' });
  expect(await kv.get('ns', 'k')).toEqual({ hello: 'world' });
  expect((await kv.list('ns')).map((r) => r.key)).toEqual(['k']);
  await kv.delete('ns', 'k');
  expect(await kv.get('ns', 'k')).toBe(null);
});

test('D1 is durable, so the search index may live there', async () => {
  // The flag the server checks before putting the search index in SQLite. A Worker's
  // isolate is recycled constantly; the D1 database behind it is not.
  expect((await provider()).durable).toBe(true);
});

test('a plugin scope with no binding is refused, not quietly co-located', async () => {
  // The isolation boundary. D1 cannot create databases on demand, and handing back the
  // main one would put a plugin's tables next to the drive's metadata — precisely what
  // the scope exists to prevent. The error says what to do about it.
  const p = await provider();
  await expect(p.obtain({ key: 'plugin:acme.notes:plugin' })).rejects.toThrow(/needs its own binding/);
  await expect(p.obtain({ key: 'plugin:acme.notes:plugin' })).rejects.toThrow(TroveError);
});

test('a bound scope works, and dropping it empties that database only', async () => {
  const local = new LocalSqliteProvider({ path: ':memory:' });
  await local.init();
  const main = fakeD1(await local.obtain({ key: 'metadata' }));
  const scoped = fakeD1(await local.obtain({ key: 'scope-db' }));
  const p = new D1SqliteProvider({ db: main, scopes: { 'plugin:acme.notes:plugin': scoped } });

  const db = await p.obtain({ key: 'plugin:acme.notes:plugin' });
  await db.exec('CREATE TABLE notes (a TEXT)');
  await db.run('INSERT INTO notes VALUES (?)', 'kept');
  expect(await db.all('SELECT a FROM notes')).toEqual([{ a: 'kept' }]);

  // The main database has its own tables and must not be touched by the scope's drop.
  const core = await p.obtain({ key: 'metadata' });
  await core.exec('CREATE TABLE keepme (a TEXT)');

  // Uninstall: D1 has no "delete database" a request can call, so emptying it is what
  // "the plugin's data is gone" means.
  await p.drop({ key: 'plugin:acme.notes:plugin' });
  expect(await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")).toEqual([]);
  expect((await core.all("SELECT name FROM sqlite_master WHERE type='table' AND name='keepme'")).length).toBe(1);
});

test('a missing binding is refused at construction, not at first query', async () => {
  expect(() => new D1SqliteProvider({})).toThrow(/requires a D1 binding/);
});

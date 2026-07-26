// A tiny SQLite abstraction that every backend conforms to, so stores don't care
// whether they run on local files (bun:sqlite / node:sqlite), Cloudflare D1, a
// Durable Object, or an in-browser wasm build. The handle is ASYNC — the only
// shape D1/DO/wasm can satisfy — and the local backend just wraps its synchronous
// driver in resolved promises.
//
//   const db = await provider.obtain({ key: 'metadata' });
//   await db.exec('CREATE TABLE t (x)');
//   await db.all('SELECT * FROM t WHERE x = ?', x);
//
// The provider is a keyed pool: obtain() lazily creates (and memoizes) the DB for
// a key, so per-plugin / per-domain databases are just distinct keys. The shell
// injects whichever provider fits the runtime.

import { TroveError } from './errors.js';

/** The database handle. All methods are async so every backend can implement it. */
export class SqliteDatabase {
  async exec(sql) { throw TroveError.unsupported('SqliteDatabase.exec'); }
  async run(sql, ...params) { throw TroveError.unsupported('SqliteDatabase.run'); }
  async get(sql, ...params) { throw TroveError.unsupported('SqliteDatabase.get'); }
  async all(sql, ...params) { throw TroveError.unsupported('SqliteDatabase.all'); }
  /** Run statements atomically. @param {{sql:string, params?:any[]}[]} statements */
  async batch(statements) { throw TroveError.unsupported('SqliteDatabase.batch'); }
  async close() {}
}

// --- plugin SQL safety -------------------------------------------------------
// Plugins run SQL against their OWN isolated database, but on a shared-filesystem
// provider the sibling scope files are guessable, so `ATTACH DATABASE` would be an
// isolation escape (and `DETACH` its pair). Strip comments + string/identifier
// literals first so the keyword can't hide inside a value, then reject.

// ATTACH/DETACH would reach a sibling scope's file. VACUUM INTO is worse and less
// obvious: it writes a complete SQLite database to any path the server process can
// create, whose pages contain rows the caller chose — attacker-chosen bytes at an
// attacker-chosen path (a cron file, a webroot, authorized_keys). PRAGMA is refused
// because several of them (database_list, temp_store_directory) either disclose host
// paths or move where files land.
const DANGEROUS_SQL = /\b(ATTACH|DETACH|VACUUM|PRAGMA)\b/i;

/** Blank out --/**-comments and '..'/".."/`..`/[..] literals, preserving length-ish. */
export function stripSqlLiterals(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < sql.length) {
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; }
        i++;
      }
      out += ' '; continue;
    }
    if (c === '[') { const e = sql.indexOf(']', i); i = e < 0 ? sql.length : e + 1; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

/** Throw if plugin-supplied SQL tries to escape its isolated database. */
export function assertSafePluginSql(sql) {
  if (typeof sql !== 'string' || !sql) throw TroveError.invalid('SQL statement is required');
  if (DANGEROUS_SQL.test(stripSqlLiterals(sql))) {
    throw TroveError.invalid('ATTACH, DETACH, VACUUM and PRAGMA are not permitted in plugin storage');
  }
}

/** A keyed pool/factory of databases. The shell injects one. */
export class SqliteProvider {
  /**
   * Does data written through this provider survive a restart? False unless a backend
   * says otherwise, so "durable" is something a provider claims rather than something
   * callers assume. The server asks before putting the search index in SQLite: an
   * index in an ephemeral database is worse than one in memory, because it looks
   * persistent right up until the restart that proves it isn't.
   */
  get durable() { return false; }
  async init() {}
  /** @returns {Promise<SqliteDatabase>} the lazily-created, memoized db for `key`. */
  async obtain({ key }) { throw TroveError.unsupported('SqliteProvider.obtain'); }
  /** Destroy the db for `key` (close + delete its backing store). */
  async drop({ key }) {}
  async close() {}
}

// --- local backend (bun:sqlite / node:sqlite) --------------------------------
// Kept in this module but with all node-specific bits (fs) imported lazily inside
// obtain(), so importing the interfaces stays safe in a Worker that never uses it.

const CORE_KEYS = new Set(['metadata', 'kv', 'plugins']); // these share one main db file

class LocalSqliteDatabase extends SqliteDatabase {
  constructor(raw) {
    super();
    this.raw = raw;
  }
  async exec(sql) { this.raw.exec(sql); }
  async run(sql, ...params) { return this.raw.prepare(sql).run(...params); }
  async get(sql, ...params) { return this.raw.prepare(sql).get(...params) ?? null; }
  async all(sql, ...params) { return this.raw.prepare(sql).all(...params); }
  async batch(statements) {
    this.raw.exec('BEGIN');
    try {
      for (const { sql, params = [] } of statements) this.raw.prepare(sql).run(...params);
      this.raw.exec('COMMIT');
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }
  async close() { this.raw.close?.(); }
}

export class LocalSqliteProvider extends SqliteProvider {
  /**
   * @param {{ path?: string }} opts Main db file. Core keys (metadata, kv) share it;
   *   other keys (e.g. plugin scopes) get an isolated sibling file under `stores/`.
   *   Use ':memory:' for an ephemeral shared in-memory db (tests).
   */
  constructor(opts = {}) {
    super();
    this.path = opts.path || ':memory:';
    this._pool = new Map(); // resolvedPath -> LocalSqliteDatabase
  }

  get durable() { return this.path !== ':memory:'; }

  // Resolve a key to a pool token. In-memory: core keys share one db, every other
  // key gets its own isolated in-memory db (so plugin scopes never collide). On
  // disk: core keys share the main file, others get isolated sibling files.
  #resolve(key) {
    if (this.path === ':memory:') return CORE_KEYS.has(key) ? ':memory:#core' : ':memory:#' + key;
    if (CORE_KEYS.has(key)) return this.path;
    return join(dirname(this.path), 'stores', sanitize(key) + '.db');
  }

  async obtain({ key }) {
    const resolved = this.#resolve(key);
    let db = this._pool.get(resolved);
    if (!db) {
      const file = resolved.startsWith(':memory:') ? ':memory:' : resolved;
      if (file !== ':memory:') {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(file), { recursive: true });
      }
      const { openDatabase } = await import('./sqlite-driver.js');
      db = new LocalSqliteDatabase(await openDatabase(file));
      this._pool.set(resolved, db);
    }
    return db;
  }

  async drop({ key }) {
    const resolved = this.#resolve(key);
    const db = this._pool.get(resolved);
    if (db) { await db.close(); this._pool.delete(resolved); }
    if (!resolved.startsWith(':memory:')) {
      const { rm } = await import('node:fs/promises');
      for (const suffix of ['', '-wal', '-shm']) await rm(resolved + suffix, { force: true }).catch(() => {});
    }
  }

  async close() {
    for (const db of this._pool.values()) await db.close();
    this._pool.clear();
  }
}

// Pure path helpers (no node:path, so this module loads anywhere).
function dirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '.' : p.slice(0, i);
}
function join(...parts) {
  return parts.join('/').replace(/\/{2,}/g, '/');
}
function sanitize(key) {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

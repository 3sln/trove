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

/** A keyed pool/factory of databases. The shell injects one. */
export class SqliteProvider {
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

const CORE_KEYS = new Set(['metadata', 'kv']); // these share one main db file

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

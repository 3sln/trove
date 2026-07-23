// KeyValueStore — a tiny namespaced key/value store for server-side state that
// isn't the file tree: push subscriptions, pending mention batches, cached user
// profiles. Pluggable like everything else (memory + SQLite bundled; implement
// the interface over D1/Redis/etc). Values are JSON-serialisable.

import { TroveError } from './errors.js';

export class KeyValueStore {
  async get(ns, key) {
    throw TroveError.unsupported('get not implemented');
  }
  async set(ns, key, value) {
    throw TroveError.unsupported('set not implemented');
  }
  async delete(ns, key) {
    throw TroveError.unsupported('delete not implemented');
  }
  /** @returns {Promise<Array<{key, value}>>} */
  async list(ns, prefix = '') {
    throw TroveError.unsupported('list not implemented');
  }
  async init() {}
}

export class MemoryKV extends KeyValueStore {
  constructor() {
    super();
    this.map = new Map(); // ns -> Map<key, value>
  }
  #ns(ns) {
    let m = this.map.get(ns);
    if (!m) this.map.set(ns, (m = new Map()));
    return m;
  }
  async get(ns, key) {
    return this.#ns(ns).get(key) ?? null;
  }
  async set(ns, key, value) {
    this.#ns(ns).set(key, value);
  }
  async delete(ns, key) {
    this.#ns(ns).delete(key);
  }
  async list(ns, prefix = '') {
    return [...this.#ns(ns).entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
  }
}

export class SqliteKV extends KeyValueStore {
  /** @param {{db?: object, path?: string}} opts pass the SqliteStore's db to share it */
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this.db = opts.db || null;
  }
  async init() {
    if (!this.db) {
      const { DatabaseSync } = await import('node:sqlite');
      this.db = new DatabaseSync(this._opts.path ?? ':memory:');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS kv (
      ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY (ns, key)
    )`);
  }
  async get(ns, key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE ns=? AND key=?').get(ns, key);
    return row ? JSON.parse(row.value) : null;
  }
  async set(ns, key, value) {
    this.db.prepare('INSERT INTO kv (ns,key,value,updatedAt) VALUES (?,?,?,?) ON CONFLICT(ns,key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt')
      .run(ns, key, JSON.stringify(value), Date.now());
  }
  async delete(ns, key) {
    this.db.prepare('DELETE FROM kv WHERE ns=? AND key=?').run(ns, key);
  }
  async list(ns, prefix = '') {
    const rows = this.db.prepare("SELECT key, value FROM kv WHERE ns=? AND key LIKE ? ESCAPE '\\'")
      .all(ns, prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }
}

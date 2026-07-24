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
  /**
   * @param {{ provider?: object, key?: string, database?: object }} opts
   *   Pass a SqliteProvider + `key` (default 'kv', which shares the main db file),
   *   or a ready `database` (SqliteDatabase) directly.
   */
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this.key = opts.key ?? 'kv';
    this.db = opts.database ?? null;
  }
  async init() {
    if (!this.db) {
      if (!this._opts.provider) throw TroveError.invalid('SqliteKV needs a provider or database');
      this.db = await this._opts.provider.obtain({ key: this.key });
    }
    await this.db.exec(`CREATE TABLE IF NOT EXISTS kv (
      ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY (ns, key)
    )`);
  }
  async get(ns, key) {
    const row = await this.db.get('SELECT value FROM kv WHERE ns=? AND key=?', ns, key);
    return row ? JSON.parse(row.value) : null;
  }
  async set(ns, key, value) {
    await this.db.run(
      'INSERT INTO kv (ns,key,value,updatedAt) VALUES (?,?,?,?) ON CONFLICT(ns,key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
      ns, key, JSON.stringify(value), Date.now(),
    );
  }
  async delete(ns, key) {
    await this.db.run('DELETE FROM kv WHERE ns=? AND key=?', ns, key);
  }
  async list(ns, prefix = '') {
    const rows = await this.db.all(
      "SELECT key, value FROM kv WHERE ns=? AND key LIKE ? ESCAPE '\\'",
      ns, prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%',
    );
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }
}

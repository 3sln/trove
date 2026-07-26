// Client-side plugin storage: an on-device SQLite database per scope, run in the
// HOST with sql.js (wasm) and persisted to IndexedDB. The sandboxed iframe can't
// touch IndexedDB (opaque origin), so — like everything else — the host holds the
// store and the plugin reaches it over RPC. It exposes the SAME async
// SqliteDatabase surface as the server side, so ctx.storage.*.client mirrors
// .server. Lazy: the wasm only loads the first time a plugin uses client storage.

let sqlPromise = null;
function loadSql() {
  // locateFile points at the wasm we serve at the app root (build copies it; dev &
  // test serve it via middleware). Only fetched on first use. On failure we clear
  // the cached promise so a later attempt can retry rather than wedging forever.
  if (!sqlPromise) {
    sqlPromise = import('sql.js')
      .then((m) => (m.default || m)({ locateFile: () => '/sql-wasm.wasm' }))
      .catch((err) => { sqlPromise = null; throw err; });
  }
  return sqlPromise;
}

// --- IndexedDB blob persistence (host origin) --------------------------------

const IDB = 'trove-plugin-clientdb';
const STORE = 'dbs';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbOp(mode, fn) {
  return openIdb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    let out;
    Promise.resolve(fn(t.objectStore(STORE))).then((r) => (out = r));
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const loadBytes = (key) => idbOp('readonly', (s) => reqP(s.get(key)));
const saveBytes = (key, bytes) => idbOp('readwrite', (s) => s.put(bytes, key));
const dropBytes = (key) => idbOp('readwrite', (s) => s.delete(key));

// --- a single scoped database (conforms to SqliteDatabase) -------------------

class ClientDatabase {
  constructor(key, db) {
    this.key = key;
    this.db = db;
    this._saveTimer = null;
  }
  // Debounce persistence: export the whole (small, per-scope) db to IndexedDB
  // shortly after the last write.
  //
  // The write already returned `{ok:true}` to the plugin by the time this runs, so a
  // failure here is data the plugin believes it saved and hasn't. Nothing can be
  // returned to it any more — but it must at least be visible, not swallowed.
  #dirty() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.flush().catch((err) => {
        console.error(`persisting plugin storage "${this.key}" failed`, err);
        this.onError?.(err, this.key);
      });
    }, 150);
  }
  async flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    await saveBytes(this.key, this.db.export());
  }
  async exec(sql) { this.db.exec(sql); this.#dirty(); return { ok: true }; }
  async run(sql, ...params) { this.db.run(sql, params); this.#dirty(); return { ok: true }; }
  async get(sql, ...params) {
    const stmt = this.db.prepare(sql);
    try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : null; }
    finally { stmt.free(); }
  }
  async all(sql, ...params) {
    const stmt = this.db.prepare(sql);
    const out = [];
    try { stmt.bind(params); while (stmt.step()) out.push(stmt.getAsObject()); }
    finally { stmt.free(); }
    return out;
  }
  async batch(statements = []) {
    this.db.run('BEGIN');
    try {
      for (const { sql, params = [] } of statements) this.db.run(sql, params);
      this.db.run('COMMIT');
    } catch (err) {
      try { this.db.run('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    this.#dirty();
    return { ok: true };
  }
  close() { clearTimeout(this._saveTimer); this.db.close(); }
}

// --- the pool ----------------------------------------------------------------

export class ClientSqlProvider {
  constructor({ onError } = {}) { this._pool = new Map(); this.onError = onError || null; }

  async obtain(key) {
    let db = this._pool.get(key);
    if (!db) {
      const SQL = await loadSql();
      const bytes = await loadBytes(key);
      db = new ClientDatabase(key, new SQL.Database(bytes || undefined));
      db.onError = this.onError;
      this._pool.set(key, db);
    }
    return db;
  }

  /** Drop a scope's database. Throws if the bytes can't be deleted — the caller
   *  (uninstall) reports leftover on-device data rather than claiming a clean wipe. */
  async drop(key) {
    const db = this._pool.get(key);
    if (db) { db.close(); this._pool.delete(key); }
    await dropBytes(key);
  }
}

// PluginRegistry — install records (manifest, package files, granted caps, trust
// status, settings, secrets) persisted in IndexedDB so plugins survive reloads on
// this device. Package bytes stay on-device (they can be large); non-secret
// settings can also be mirrored to the server (see the settings service) so they
// follow the user. A plugin's OWN data lives in per-scope SQLite databases (server
// via the host API; on-device via the wasm store) — not here.

const DB = 'trove-plugins';
const STORE = 'installs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class PluginRegistry {
  constructor() {
    this._db = null;
  }
  async #db() {
    return (this._db ??= await openDb());
  }
  /** record: { id, manifest, files:{path:Uint8Array}, grants, trust, settings, secrets, installedAt } */
  async save(record) {
    const db = await this.#db();
    await tx(db, 'readwrite', (s) => s.put(record));
    return record;
  }
  async get(id) {
    const db = await this.#db();
    return tx(db, 'readonly', (s) => reqP(s.get(id)));
  }
  async list() {
    const db = await this.#db();
    return tx(db, 'readonly', (s) => reqP(s.getAll()));
  }
  async remove(id) {
    const db = await this.#db();
    await tx(db, 'readwrite', (s) => s.delete(id));
  }
  async patch(id, patch) {
    const rec = await this.get(id);
    if (!rec) return null;
    const next = { ...rec, ...patch };
    await this.save(next);
    return next;
  }
}


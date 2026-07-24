// Where installed plugins live. Two layers:
//   • PluginRegistry — install records (manifest, package files, granted caps,
//     trust status, settings, secrets) persisted in IndexedDB so plugins survive
//     reloads on this device.
//   • PluginDataStore — a plugin's OWN persistent data, namespaced by plugin id
//     (local IndexedDB; the host also mediates a server-backed scope). Keyed by
//     the plugin id so the host can wipe everything a plugin owns on uninstall.
//
// Package bytes stay on-device (they can be large); non-secret settings can also
// be mirrored to the server (see the settings service) so they follow the user.

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

// --- per-plugin local data (moderated via the host over postMessage) --------

const DATA_DB = 'trove-plugin-data';

function openDataDb(pluginId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${DATA_DB}.${pluginId}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dtx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const s = t.objectStore('kv');
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

export class PluginDataStore {
  constructor(pluginId) {
    this.pluginId = pluginId;
    this._db = null;
  }
  async #db() {
    return (this._db ??= await openDataDb(this.pluginId));
  }
  async get(key) {
    return dtx(await this.#db(), 'readonly', (s) => reqP(s.get(key)));
  }
  async set(key, value) {
    await dtx(await this.#db(), 'readwrite', (s) => s.put(value, key));
    return { ok: true };
  }
  async delete(key) {
    await dtx(await this.#db(), 'readwrite', (s) => s.delete(key));
    return { ok: true };
  }
  async query(prefix = '') {
    return dtx(await this.#db(), 'readonly', (store) =>
      new Promise((resolve, reject) => {
        const out = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(out);
          if (String(cur.key).startsWith(prefix)) out.push({ key: cur.key, value: cur.value });
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      }),
    );
  }
  /** Wipe everything this plugin stored locally (uninstall cleanup). */
  async destroy() {
    this._db?.close();
    this._db = null;
    await new Promise((res) => {
      const req = indexedDB.deleteDatabase(`${DATA_DB}.${this.pluginId}`);
      req.onsuccess = req.onerror = req.onblocked = () => res();
    });
  }
}

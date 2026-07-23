// PluginDataStore — a separate persistent database per plugin *domain*, exposed
// to plugins (that declared the "storage" capability) over RPC. This is where an
// audiobook plugin keeps playback progress, chapter caches, bookmarks, etc.
//
// Each domain gets its own IndexedDB database (`trove.plugin.<domain>`), so
// plugins are isolated from one another and can be wiped independently. The API
// is a small async key/value + prefix-query surface — enough for real apps,
// and a natural fit for a SQLite-backed store if you later swap the
// implementation (the plugin-facing shape stays identical).

const dbs = new Map(); // domain -> Promise<IDBDatabase>

function openDb(domain) {
  if (dbs.has(domain)) return dbs.get(domain);
  const p = new Promise((resolve, reject) => {
    const name = `trove.plugin.${domain}`;
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbs.set(domain, p);
  return p;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const store = t.objectStore('kv');
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class PluginDataStore {
  constructor(domain) {
    if (!domain) throw new Error('PluginDataStore requires a domain');
    this.domain = domain;
  }
  async get(key) {
    const db = await openDb(this.domain);
    return tx(db, 'readonly', (s) => reqP(s.get(key)));
  }
  async set(key, value) {
    const db = await openDb(this.domain);
    await tx(db, 'readwrite', (s) => s.put(value, key));
    return { ok: true };
  }
  async delete(key) {
    const db = await openDb(this.domain);
    await tx(db, 'readwrite', (s) => s.delete(key));
    return { ok: true };
  }
  async query(prefix = '') {
    const db = await openDb(this.domain);
    return tx(db, 'readonly', (store) =>
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
}

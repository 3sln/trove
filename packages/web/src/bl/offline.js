// OfflineService — a limited but real offline mode.
//   • Pin ("make available offline"): file bytes go into the SW's trove-files
//     cache (so every opener reads them with no network), and — for text — the
//     content is chunked, embedded with the same LocalHash model the server can
//     use, and stored in IndexedDB for offline search.
//   • Offline search: lexical (names/paths/tags/content) blended with local
//     semantic (cosine over the cached chunk vectors) — the same hybrid shape as
//     the server, just over what you took offline.
//   • Sidecar op queue: while offline, comment/tag mutations are queued and
//     replayed on reconnect. Because the sidecar is a CRDT, replay merges cleanly
//     with whatever changed server-side meanwhile.
// Reactive: the workbench watches `online`, the pinned set, and the queue depth.

import { ObservableSubject } from '../runtime.js';
import { LocalHashEmbedding } from '@trove/core/search/embeddings.js';

const DB = 'trove-offline';
const FILES_CACHE = 'trove-files-v1';
const embed = new LocalHashEmbedding({ dimensions: 256 });

export class OfflineService {
  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.db = null;
    this.state = { online: navigator.onLine, pins: [], queued: 0, syncing: false };
    this.subject = new ObservableSubject(this.state);
  }
  observe() {
    return this.subject;
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
  }

  async init() {
    this.db = await openDb();
    await this.#refreshPins();
    await this.#refreshQueue();
    window.addEventListener('online', () => this.#onOnline());
    window.addEventListener('offline', () => this.#onOffline());
    // `navigator.onLine` only reflects that an interface is up — on a captive portal or
    // dead uplink it's `true` while the server is unreachable, which would leave us
    // falsely "online" with every request silently failing. Confirm real reachability.
    if (this.state.online && !(await this.api.reachable())) this.#set({ online: false });
    // Tell the plugin host our initial connectivity so it can probe plugins.
    this.platform.plugins?.setOnline?.(this.state.online);
    if (this.state.online) this.flushQueue();
  }

  async #onOnline() {
    // The interface came up, but verify the server is actually reachable before
    // declaring online — a captive portal fires 'online' with no real connectivity.
    if (!(await this.api.reachable())) { this.#set({ online: false }); await this.platform.plugins?.setOnline?.(false); return; }
    this.#set({ online: true });
    // Plugins re-announce what works now that we're back online.
    await this.platform.plugins?.setOnline?.(true);
    await this.flushQueue();
  }
  async #onOffline() {
    this.#set({ online: false });
    // Plugins re-announce; network-only features become unavailable.
    await this.platform.plugins?.setOnline?.(false);
  }

  isPinned(id) {
    return this.state.pins.some((p) => p.id === id);
  }

  // --- pinning ---------------------------------------------------------------

  async pin(node) {
    if (node.kind !== 'file') return;
    try {
      const url = this.api.downloadUrl(node.id);
      // Cache the bytes for offline opening (SW serves them cache-first).
      if ('caches' in window) {
        const cache = await caches.open(FILES_CACHE);
        await cache.add(url);
      }
      // Index text content for offline search.
      let chunks = [];
      let text = '';
      if (isTexty(node)) {
        try {
          text = await this.api.readText(node.id);
          const parts = chunkText(text, 1000, 150);
          const vectors = await embed.embed(parts.length ? parts : [node.name]);
          chunks = (parts.length ? parts : [node.name]).map((t, i) => ({ text: t, vector: vectors[i] }));
        } catch { /* keep name-only */ }
      }
      const nameVec = (await embed.embed([node.name + ' ' + node.path]))[0];
      await idbPut(this.db, 'pins', node.id, { node, text, chunks, nameVec, pinnedAt: Date.now() });
      await this.#refreshPins();
      this.platform.notifications.success(`“${node.name}” is available offline`);
    } catch (err) {
      this.platform.notifications.error(`Couldn't make available offline: ${err.message}`);
    }
  }

  async unpin(id) {
    const pin = this.state.pins.find((p) => p.id === id);
    if (pin && 'caches' in window) {
      const cache = await caches.open(FILES_CACHE);
      await cache.delete(this.api.downloadUrl(id), { ignoreVary: true }).catch(() => {});
    }
    await idbDelete(this.db, 'pins', id);
    await this.#refreshPins();
  }

  async #refreshPins() {
    const all = await idbAll(this.db, 'pins');
    this.#set({ pins: all.map((r) => ({ id: r.node.id, name: r.node.name, path: r.node.path, contentType: r.node.contentType, collectionId: r.node.collectionId, pinnedAt: r.pinnedAt })) });
  }

  // --- offline search --------------------------------------------------------

  async searchOffline(query, { limit = 40 } = {}) {
    const rows = await idbAll(this.db, 'pins');
    if (!rows.length) return [];
    const qTokens = tokenize(query);
    const qv = (await embed.embed([query]))[0];
    const results = [];
    for (const r of rows) {
      const hay = tokenize(`${r.node.name} ${r.node.path} ${r.text || ''}`);
      const lex = lexicalScore(qTokens, new Set(hay));
      let dense = cosine(qv, r.nameVec);
      for (const c of r.chunks || []) dense = Math.max(dense, cosine(qv, c.vector));
      const score = 0.6 * dense + 0.4 * lex;
      if (score > 0.02) results.push({ nodeId: r.node.id, node: r.node, score, snippet: snippet(r.text, qTokens), indexerId: 'offline' });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // --- offline sidecar op queue ---------------------------------------------

  async queueOp(op) {
    await idbAdd(this.db, 'queue', { ...op, at: Date.now() });
    await this.#refreshQueue();
  }

  async #refreshQueue() {
    const q = await idbAll(this.db, 'queue');
    this.#set({ queued: q.length });
  }

  async flushQueue() {
    if (!this.state.online || this.state.syncing) return;
    // Claim the sync BEFORE any await — two 'online' events (or init + an event) can
    // fire concurrently, and a check-then-act guard after an await let both pass and
    // replay the queue twice (double-posting). Setting syncing synchronously here makes
    // the second caller bail at the guard above.
    this.#set({ syncing: true });
    let synced = 0;
    let dropped = 0;
    try {
      const q = await idbAllWithKeys(this.db, 'queue');
      for (const { key, value } of q) {
        try {
          await this.api.request(value.method, value.path, { body: value.body });
          await idbDelete(this.db, 'queue', key);
          synced++;
        } catch (err) {
          if (err.code === 'transient' || err.code === 'timeout') break; // retry later
          // A permanent failure (e.g. the file was deleted) — drop it so we don't loop,
          // but don't pretend it synced.
          await idbDelete(this.db, 'queue', key);
          dropped++;
        }
      }
    } finally {
      await this.#refreshQueue();
      this.#set({ syncing: false });
      // Be honest: only claim success for what actually applied, and surface drops.
      if (dropped) this.platform.notifications.warn(`${dropped} offline change${dropped > 1 ? 's' : ''} couldn't be applied and ${dropped > 1 ? 'were' : 'was'} discarded.`);
      if (synced && this.state.queued === 0) this.platform.notifications.info(`${synced} offline change${synced > 1 ? 's' : ''} synced.`);
    }
  }
}

// --- IndexedDB helpers ------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbPut = (db, store, key, val) => tx(db, store, 'readwrite', (s) => s.put(val, key));
const idbAdd = (db, store, val) => tx(db, store, 'readwrite', (s) => s.add(val));
const idbDelete = (db, store, key) => tx(db, store, 'readwrite', (s) => s.delete(key));
const idbAll = (db, store) => tx(db, store, 'readonly', (s) => reqP(s.getAll()));
function idbAllWithKeys(db, store) {
  return tx(db, store, 'readonly', (s) =>
    new Promise((resolve, reject) => {
      const out = [];
      const req = s.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(out);
        out.push({ key: cur.key, value: cur.value });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    }),
  );
}

// --- search math (mirrors the server's LocalHash hybrid) --------------------

const STOP = new Set('a an the of to in on for and or is are be as at by with from this that it'.split(' '));
function tokenize(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x.length > 1 && !STOP.has(x));
}
function lexicalScore(q, docTokens) {
  if (!q.length || !docTokens.size) return 0;
  let hit = 0;
  for (const t of q) if (docTokens.has(t)) hit++;
  return hit / q.length;
}
function cosine(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // both L2-normalised
}
function chunkText(text, size, overlap) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return out.filter((s) => s.trim());
}
function snippet(text, qTokens) {
  if (!text) return null;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of qTokens) { const i = lower.indexOf(t); if (i >= 0) { at = i; break; } }
  if (at < 0) return text.slice(0, 160).trim();
  const start = Math.max(0, at - 60);
  return (start > 0 ? '…' : '') + text.slice(start, start + 200).trim() + '…';
}
function isTexty(node) {
  const ct = node.contentType || '';
  if (ct.startsWith('text/') || ct === 'application/json') return true;
  const ext = (node.name || '').slice((node.name || '').lastIndexOf('.')).toLowerCase();
  return ['.txt', '.md', '.json', '.js', '.ts', '.css', '.html', '.csv', '.log', '.yaml', '.yml', '.py'].includes(ext);
}

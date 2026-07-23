// SidecarManager — the "hot" side of the cold/hot split. It keeps recently-used
// sidecar documents in memory, applies mutations against the live copy for
// instant reads, and flushes to cold storage on a short debounce. Every flush
// does a read-merge-write against the cold copy (the doc is a CRDT), so a
// concurrent writer on another instance never clobbers this one's changes.
// Idle documents are flushed and evicted to bound memory.

import { mergeDoc } from './document.js';

export class SidecarManager {
  /**
   * @param {object} deps
   * @param {import('./store.js').SidecarStore} deps.store
   * @param {number} [deps.flushDelayMs] debounce before writing back (default 1500)
   * @param {number} [deps.idleEvictMs]  evict after this idle time (default 60s)
   */
  constructor({ store, flushDelayMs = 1500, idleEvictMs = 60_000 }) {
    this.store = store;
    this.flushDelayMs = flushDelayMs;
    this.idleEvictMs = idleEvictMs;
    this.hot = new Map(); // nodeId -> { doc, dirty, timer, loading, lastAccess }
  }

  async #entry(nodeId) {
    let e = this.hot.get(nodeId);
    if (e) {
      if (e.loading) await e.loading;
      e.lastAccess = now();
      return e;
    }
    e = { doc: null, dirty: false, timer: null, lastAccess: now() };
    this.hot.set(nodeId, e);
    e.loading = (async () => {
      e.doc = (await this.store.load(nodeId)) || this.store.emptyDoc(nodeId);
      e.loading = null;
    })();
    await e.loading;
    return e;
  }

  /** Read the live document (loading it if cold). */
  async get(nodeId) {
    return (await this.#entry(nodeId)).doc;
  }

  /**
   * Apply `fn(doc)` to the live document, mark dirty, and schedule a flush.
   * @returns whatever `fn` returns (e.g. the affected comment).
   */
  async mutate(nodeId, fn) {
    const e = await this.#entry(nodeId);
    const result = await fn(e.doc);
    e.dirty = true;
    this.#schedule(nodeId, e);
    return result;
  }

  #schedule(nodeId, e) {
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      this.flush(nodeId).catch((err) => console.error('sidecar flush failed', err));
    }, this.flushDelayMs);
    if (e.timer.unref) e.timer.unref();
  }

  /** Write the live doc back, merging with the cold copy first. */
  async flush(nodeId) {
    const e = this.hot.get(nodeId);
    if (!e || !e.doc) return;
    if (e.loading) await e.loading;
    if (!e.dirty) return;
    const cold = await this.store.load(nodeId);
    const merged = cold ? mergeDoc(cold, e.doc) : e.doc;
    await this.store.save(nodeId, merged);
    e.doc = merged;
    e.dirty = false;
  }

  async flushAll() {
    await Promise.all([...this.hot.keys()].map((id) => this.flush(id).catch(() => {})));
  }

  /** Flush + drop documents idle longer than idleEvictMs. */
  async sweep() {
    const cutoff = now() - this.idleEvictMs;
    for (const [id, e] of this.hot) {
      if (e.lastAccess < cutoff && !e.timer) {
        if (e.dirty) await this.flush(id).catch(() => {});
        this.hot.delete(id);
      }
    }
  }

  async dispose() {
    for (const e of this.hot.values()) if (e.timer) clearTimeout(e.timer);
    await this.flushAll();
    this.hot.clear();
  }
}

function now() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

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
  constructor({ store, flushDelayMs = 1500, idleEvictMs = 60_000, issues = null, maxFlushRetries = 5 }) {
    this.store = store;
    this.flushDelayMs = flushDelayMs;
    this.idleEvictMs = idleEvictMs;
    this.issues = issues;
    this.maxFlushRetries = maxFlushRetries;
    this.hot = new Map(); // nodeId -> { doc, dirty, timer, loading, lastAccess, retries }
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
    // Stamp the change. A flush that is already awaiting `store.save()` computed its
    // merged document BEFORE this ran, so it must not adopt that result wholesale or
    // mark the entry clean — see #flushOnce.
    e.gen = (e.gen || 0) + 1;
    this.#schedule(nodeId, e);
    return result;
  }

  /**
   * Debounce a write-back, and keep trying if it fails.
   *
   * Between `mutate` and a successful flush, memory holds the ONLY copy of what the
   * user just wrote — the API has already replied 200 and their comment is on screen.
   * A flush that fails and is merely logged means that copy is unreferenced by anything
   * that will ever write it, so the retry here is not politeness, it is the difference
   * between a durable comment and one that disappears when the process does.
   */
  #schedule(nodeId, e, delay = this.flushDelayMs) {
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      this.flush(nodeId).then(() => {
        if (e.retries) {
          e.retries = 0;
          this.issues?.clear?.('sidecar-flush', nodeId).catch(() => {});
        }
      }).catch((err) => {
        e.retries = (e.retries || 0) + 1;
        console.error(`sidecar flush failed for ${nodeId} (attempt ${e.retries})`, err);
        if (e.retries <= this.maxFlushRetries) {
          // Back off, but stay dirty and stay hot — sweep() will not evict it.
          this.#schedule(nodeId, e, Math.min(this.flushDelayMs * 2 ** e.retries, 60_000));
        } else {
          // Out of retries. The comment is still in memory and still served, but it will
          // not survive a restart, and the person who wrote it has been told it saved.
          // That is a standing problem, which is exactly what the issue registry is for.
          this.issues?.raise?.({
            kind: 'sidecar-flush',
            subject: nodeId,
            severity: 'error',
            title: 'A comment or tag could not be saved',
            detail: `Changes to this item's conversation are held in memory only — ${err?.message || err}`,
            // The op the server registers via issues.handle('sidecar-flush', …), which
            // is what makes the Retry button appear and do the right thing.
            retry: 'sidecar-flush',
          }).catch(() => {});
        }
      });
    }, delay);
    if (e.timer.unref) e.timer.unref();
  }

  /** Retry every document that is still holding unsaved changes. */
  async retryPending() {
    const pending = [...this.hot.entries()].filter(([, e]) => e.dirty);
    for (const [id, e] of pending) {
      e.retries = 0;
      // This IS the write the pending timer was going to do; leaving it armed would
      // keep sweep() from ever evicting the entry.
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      await this.flush(id);
      this.issues?.clear?.('sidecar-flush', id).catch(() => {});
    }
    return { flushed: pending.length };
  }

  /**
   * Write the live doc back, merging with the cold copy first.
   *
   * Serialized per document. Two flushes of the same sidecar overlapping is how one of
   * them computes a merge from a document the other is about to replace — and the
   * replacement wins, silently, after the API has already replied 200.
   */
  flush(nodeId) {
    const e = this.hot.get(nodeId);
    if (!e || !e.doc) return Promise.resolve();
    const run = () => this.#flushOnce(nodeId, e);
    const next = (e.chain || Promise.resolve()).then(run, run);
    // The chain itself must never stay rejected, or one failure poisons every later
    // flush of this document. Callers still see their own rejection through `next`.
    e.chain = next.catch(() => {});
    return next;
  }

  async #flushOnce(nodeId, e) {
    if (e.loading) await e.loading;
    if (!e.dirty || !e.doc) return;
    // The generation this write covers. `store.load` and `store.save` are object-store
    // round trips — hundreds of milliseconds — and `mutate` applies its change in place
    // on `e.doc` throughout. So a comment accepted during the save lands in `e.doc`,
    // is NOT in `merged` (computed before it), and used to be erased by `e.doc = merged`
    // and then guaranteed never to be retried by `e.dirty = false`.
    const gen = e.gen || 0;
    const cold = await this.store.load(nodeId);
    const merged = cold ? mergeDoc(cold, e.doc) : e.doc;
    await this.store.save(nodeId, merged);
    if ((e.gen || 0) !== gen) {
      // Something arrived while we were saving. Fold what we just persisted back INTO
      // the live document rather than over it, and leave the entry dirty so the next
      // flush carries the newcomer.
      e.doc = merged === e.doc ? e.doc : mergeDoc(merged, e.doc);
      return;
    }
    e.doc = merged;
    e.dirty = false;
  }

  /** @returns {Promise<{flushed: number, failed: Array<{nodeId, error}>}>} */
  async flushAll() {
    const failed = [];
    let flushed = 0;
    await Promise.all([...this.hot.keys()].map((id) => this.flush(id)
      .then(() => { flushed++; })
      .catch((error) => failed.push({ nodeId: id, error }))));
    return { flushed, failed };
  }

  /**
   * Flush + drop documents idle longer than idleEvictMs.
   *
   * A document is evicted only once it is CLEAN. Dropping a dirty one discards the only
   * copy of a change the user was told had saved — and the failure that made it dirty is
   * exactly the moment that would happen, so "flush, then delete regardless" turns a
   * transient storage blip into silent data loss a minute later.
   */
  async sweep() {
    const cutoff = now() - this.idleEvictMs;
    for (const [id, e] of this.hot) {
      if (e.lastAccess >= cutoff || e.timer) continue;
      if (e.dirty) {
        try {
          await this.flush(id);
        } catch {
          // Still unsaved: keep it in memory and let the retry schedule own it. Memory
          // growth is bounded by the store being broken, which is a loud condition.
          this.#schedule(id, e);
          continue;
        }
      }
      this.hot.delete(id);
    }
  }

  /**
   * Flush everything and let go.
   *
   * Returns what could not be written rather than swallowing it: the caller is a
   * shutdown path, and exiting 0 after dropping someone's comments is a lie the process
   * tells on its way out.
   */
  async dispose() {
    for (const e of this.hot.values()) if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    const result = await this.flushAll();
    if (result.failed.length) {
      console.error(`[trove] ${result.failed.length} sidecar document(s) could not be saved on shutdown:`,
        result.failed.map((f) => `${f.nodeId}: ${f.error?.message || f.error}`).join('; '));
    }
    this.hot.clear();
    return result;
  }
}

function now() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

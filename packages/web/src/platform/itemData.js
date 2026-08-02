// A plugin's key/value data for an item, local first and merged with the server.
//
// The plugin sees one interface and is told nothing about where the bytes are — see the
// SDK's `files.data(id)`. That is the point: a viewer saving a listening position should
// not have to know whether the drive is reachable, and should not lose the position when
// it is not.
//
// SHAPE. Every write lands in a local map immediately, stamped, and is queued. The queue
// flushes to `/api/items/:id/data` when it can; the server merges into the item's sidecar,
// which is a CRDT, and answers with the merged view. A read is the local map merged over
// whatever the server last said.
//
// The merge rule is last-write-wins on a wall-clock stamp, with the actor breaking ties —
// the same rule the sidecar uses, so both ends agree without either being authoritative.
// Wall clock rather than the sidecar's Lamport counter because these writes originate on
// devices that have never spoken to each other: two phones, one of them offline for a day.
// A Lamport clock cannot order those; a timestamp can, imperfectly and good enough for
// "where was I in this book".
//
// PERSISTENCE is localStorage, not IndexedDB. This is a handful of small values per item
// — a position, a rate, a bookmark — and localStorage is synchronous, which means a write
// survives the tab being closed a millisecond later. An async store would not.

const KEY = 'trove.itemData';
const FLUSH_MS = 2000;
const MAX_ENTRIES = 5000;

export class ItemDataService {
  /**
   * @param {object} deps
   * @param {import('./api.js').Api} deps.api
   * @param {() => string} [deps.actor] who is writing, for tie-breaks
   */
  constructor({ api, actor = () => 'local' } = {}) {
    this.api = api;
    this.actor = actor;
    this.local = load();          // scope -> nodeId -> key -> { value, present, at, actor }
    this.pending = new Set();     // `${scope}\0${nodeId}` awaiting a flush
    this.server = new Map();      // `${scope}\0${nodeId}` -> plain object last seen
    this.timer = null;
  }

  /**
   * Everything this plugin knows about this item.
   *
   * Local over server, because local includes writes the server has not seen yet. A
   * server fetch is kicked off but not waited on: a viewer opening a book should draw
   * immediately from what this device already knows, and correct itself a moment later
   * if another device got further.
   */
  async get(scope, nodeId) {
    const merged = { ...(this.server.get(k(scope, nodeId)) || {}) };
    for (const [key, cell] of Object.entries(this.local[scope]?.[nodeId] || {})) {
      if (cell.present) merged[key] = cell.value;
      else delete merged[key];
    }
    this.#refresh(scope, nodeId);
    return merged;
  }

  /** Write now, locally; tell the server when there is one. */
  async set(scope, nodeId, key, value) {
    if (!key) return { ok: false };
    this.#put(scope, nodeId, key, { value, present: true });
    return { ok: true };
  }

  async remove(scope, nodeId, key) {
    if (!key) return { ok: false };
    // A tombstone, not a delete: the server may still hold the old value, and an absence
    // has to be a fact with a stamp or the merge will bring it back.
    this.#put(scope, nodeId, key, { value: null, present: false });
    return { ok: true };
  }

  #put(scope, nodeId, key, cell) {
    this.local[scope] ||= {};
    this.local[scope][nodeId] ||= {};
    this.local[scope][nodeId][key] = { ...cell, at: Date.now(), actor: this.actor() };
    save(this.local);
    this.pending.add(k(scope, nodeId));
    this.#schedule();
  }

  #schedule() {
    if (this.timer) return;
    // Coalesced: a scrubbing listener writes a position several times a second, and one
    // request per write would be a request per frame.
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, FLUSH_MS);
  }

  /**
   * Push what is queued and take back what the server merged.
   *
   * A failure keeps the item queued — that is the whole reason writes are local first, and
   * dropping the queue on a flaky network would defeat it. Nothing is retried immediately;
   * the next write, or the next flush, carries it.
   */
  async flush() {
    for (const id of [...this.pending]) {
      const [scope, nodeId] = id.split('\0');
      const cells = this.local[scope]?.[nodeId];
      if (!cells) { this.pending.delete(id); continue; }
      const entries = Object.entries(cells).map(([key, c]) => ({ key, value: c.value, remove: !c.present }));
      try {
        const res = await this.api.request('POST', `/api/items/${encodeURIComponent(nodeId)}/data`, {
          query: { scope }, body: { entries },
        });
        this.pending.delete(id);
        this.server.set(id, res?.data || {});
        // The local copy has served its purpose once the server has it: keeping it would
        // make a stale local value outlive a newer one written elsewhere.
        delete this.local[scope][nodeId];
        save(this.local);
      } catch {
        // Left queued deliberately. See above.
      }
    }
  }

  /** Ask the server what it has, without blocking the caller that wanted a value. */
  #refresh(scope, nodeId) {
    const id = k(scope, nodeId);
    if (this.inflight?.has(id)) return;
    (this.inflight ||= new Set()).add(id);
    this.api.request('GET', `/api/items/${encodeURIComponent(nodeId)}/data`, { query: { scope } })
      .then((res) => { this.server.set(id, res?.data || {}); })
      .catch(() => {})
      .finally(() => this.inflight.delete(id));
  }
}

const k = (scope, nodeId) => `${scope}\0${nodeId}`;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY)) || {};
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function save(local) {
  try {
    // Bounded, because this is localStorage and a plugin writing per-item state across a
    // large drive would otherwise fill it and start throwing on every write — including
    // the writes of every other feature that shares the quota. Oldest stamps go first.
    const flat = [];
    for (const [scope, nodes] of Object.entries(local)) {
      for (const [nodeId, cells] of Object.entries(nodes)) {
        for (const [key, cell] of Object.entries(cells)) flat.push({ scope, nodeId, key, cell });
      }
    }
    if (flat.length > MAX_ENTRIES) {
      flat.sort((a, b) => (a.cell.at || 0) - (b.cell.at || 0));
      for (const { scope, nodeId, key } of flat.slice(0, flat.length - MAX_ENTRIES)) {
        delete local[scope][nodeId][key];
      }
    }
    localStorage.setItem(KEY, JSON.stringify(local));
  } catch { /* private mode, or full: the in-memory copy still works for this session */ }
}

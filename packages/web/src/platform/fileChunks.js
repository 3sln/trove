// Where a file's bytes come from, and which of them are worth keeping.
//
// A viewer reading a range asks here rather than asking the network, and the answer comes
// from the first of three places that has it:
//
//   1. A PINNED whole-file copy. bl/offline.js already puts the whole Response into Cache
//      Storage under `mediaUrls.cacheKey(id)` — a deliberately stable key, so `unpin` can
//      find what `pin` stored. Slicing that cached blob is disk-backed and costs nothing,
//      so a pinned book plays with the network off and this tier comes almost free.
//   2. CHUNKS of a download in progress. Playing from the middle fetches the middle, and
//      if that file is also being taken offline those bytes are worth keeping — so the
//      read contributes them and the background filler skips them later.
//   3. The network, keeping NOTHING.
//
// THE THIRD CASE IS THE DEFAULT, and it is the rule the whole design hangs off: a plugin
// ranging over a file nobody asked to keep must not quietly fill the disk with it. Bytes
// are retained only for an item someone has actually asked to have offline, and `start(id)`
// is that asking. Until it is called this is a plain ranged reader with a cache lookup in
// front of it.
//
// THE ETAG IS IN THE KEY. A file overwritten in place keeps its id, so an id-keyed chunk
// cache would hand a reader the head of the old file and the tail of the new one. For a
// container format that is a parse failure, and a confusing one — the bytes are all valid,
// they are just from two different files. A changed etag makes every old chunk stop
// matching, and the sweep reclaims them.

const CHUNKS_CACHE = 'trove-chunks-v1';

/**
 * 4 MiB.
 *
 * A long audiobook is a few hundred entries at this size rather than a few thousand, and
 * Cache Storage is a real database — the per-entry overhead is what makes a small chunk
 * size expensive, not the bytes. Big enough that one chunk usually covers a seek, small
 * enough that the first one arrives quickly.
 */
export const CHUNK_SIZE = 4 * 1024 * 1024;

const chunkOf = (offset) => Math.floor(offset / CHUNK_SIZE);
const concat = (parts, total) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

export class FileChunks {
  /** @param {{api: object, mediaUrls: object}} deps */
  constructor({ api, mediaUrls }) {
    this.api = api;
    this.mediaUrls = mediaUrls;
    // What someone asked to keep: id -> { etag, total, cancel, filling, done, failed }.
    // In memory because it is about THIS session's background work; what survives a reload
    // is the chunks themselves, which is the durable half.
    this.kept = new Map();
    this.listeners = new Set();
  }

  /** Progress, for a viewer drawing a bar. `off()` to stop listening. */
  onProgress(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  #emit(id) {
    const s = this.status(id);
    for (const fn of [...this.listeners]) { try { fn(id, s); } catch { /* a listener is not our problem */ } }
  }

  #key(id, etag, index) {
    // The stable download URL as the prefix, so a chunk key reads as "part of this file"
    // in devtools and sorts beside the pinned whole-file entry.
    return `${this.mediaUrls.cacheKey(id)}#chunk=${etag || 'none'}:${CHUNK_SIZE}:${index}`;
  }

  async #cache(name) {
    if (!('caches' in globalThis)) return null;
    return caches.open(name).catch(() => null);
  }

  /**
   * The pinned whole-file copy, if there is one.
   *
   * Tier 1, and the reason it is first: it needs no chunking, no etag bookkeeping and no
   * network, because `bl/offline.js` already put the entire Response there.
   */
  async #pinned(id) {
    const cache = await this.#cache('trove-files-v1');
    if (!cache) return null;
    return cache.match(this.mediaUrls.cacheKey(id), { ignoreVary: true }).catch(() => null);
  }

  /**
   * Read `[start, end)`.
   *
   * @param {string} id
   * @param {{start?: number, end?: number, signal?: AbortSignal}} range
   * @returns {Promise<{bytes: Uint8Array, etag: string|null, total: number|null}>}
   */
  async read(id, { start = 0, end, signal } = {}) {
    const whole = await this.#pinned(id);
    if (whole) {
      const blob = await whole.blob();
      const stop = end == null ? blob.size : Math.min(end, blob.size);
      const bytes = new Uint8Array(await blob.slice(start, stop).arrayBuffer());
      return { bytes, etag: whole.headers.get('etag'), total: blob.size };
    }

    const keep = this.kept.get(id);
    // Not kept: a plain ranged read, and nothing is written anywhere. This is the branch
    // that runs for every file nobody asked to keep, which is almost all of them.
    if (!keep) return this.api.readRange(id, { start, end, signal });

    return this.#readChunked(id, keep, start, end, signal);
  }

  /** The kept path: whole chunks, from the cache where possible, contributed on a miss. */
  async #readChunked(id, keep, start, end, signal) {
    const cache = await this.#cache(CHUNKS_CACHE);
    if (!cache) return this.api.readRange(id, { start, end, signal });

    // The total has to be known before the last chunk can be sized, and the cheapest way
    // to learn it is the first read — which we were doing anyway.
    if (keep.total == null) {
      const head = await this.api.readRange(id, { start: 0, end: 1, signal });
      keep.total = head.total;
      keep.etag = head.etag;
    }
    const stop = Math.min(end == null ? keep.total : end, keep.total);
    if (stop <= start) return { bytes: new Uint8Array(0), etag: keep.etag, total: keep.total };

    const parts = [];
    let got = 0;
    for (let i = chunkOf(start); i <= chunkOf(stop - 1); i++) {
      const chunk = await this.#chunk(id, keep, i, cache, signal);
      // The window this chunk contributes, in the chunk's own coordinates.
      const from = Math.max(0, start - i * CHUNK_SIZE);
      const to = Math.min(chunk.length, stop - i * CHUNK_SIZE);
      const piece = chunk.subarray(from, to);
      parts.push(piece);
      got += piece.length;
    }
    return { bytes: concat(parts, got), etag: keep.etag, total: keep.total };
  }

  /** One chunk: cached if it is there, fetched and KEPT if it is not. */
  async #chunk(id, keep, index, cache, signal) {
    const key = this.#key(id, keep.etag, index);
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      keep.have.add(index);
      return new Uint8Array(await hit.arrayBuffer());
    }

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, keep.total);
    const res = await this.api.readRange(id, { start, end, signal });
    // The etag can change under us mid-download — someone replaced the file. Everything
    // already stored is from a file that no longer exists, so it is dropped rather than
    // mixed with what is arriving.
    if (res.etag && keep.etag && res.etag !== keep.etag) {
      await this.#dropChunks(id);
      keep.have.clear();
      keep.etag = res.etag;
      keep.total = res.total ?? keep.total;
    }
    await cache.put(key, new Response(res.bytes)).catch(() => {});
    keep.have.add(index);
    this.#emit(id);
    return res.bytes;
  }

  /**
   * Keep this item offline, and fill in what is missing in the background.
   *
   * IDEMPOTENT: starting a download that is already running returns its status rather than
   * racing a second filler over the same chunks — two fillers would each fetch every chunk
   * the other had not written yet, which is the whole file twice.
   */
  async start(id) {
    const running = this.kept.get(id);
    if (running) return this.status(id);

    const head = await this.api.readRange(id, { start: 0, end: 1 });
    const controller = new AbortController();
    const keep = {
      etag: head.etag, total: head.total, filling: true, done: false, failed: null,
      // Which chunk indices are stored. `loaded` is DERIVED from this rather than counted
      // up as bytes arrive, so a chunk written by a viewer's seek and a chunk written by
      // the background filler are the same fact and neither double-counts the other.
      have: new Set(),
      controller,
    };
    this.kept.set(id, keep);
    this.#emit(id);
    // Not awaited: `start` answers immediately so a viewer can begin playing while the
    // rest arrives. Failures land on the status, which is what a progress bar reads.
    this.#fill(id, keep, controller.signal).catch((err) => {
      keep.filling = false;
      keep.failed = err?.message || String(err);
      this.#emit(id);
    });
    return this.status(id);
  }

  /** In order, skipping what is already there — which is what makes a seek pay for itself. */
  async #fill(id, keep, signal) {
    const cache = await this.#cache(CHUNKS_CACHE);
    if (!cache) throw new Error('This browser has no Cache Storage, so nothing can be kept offline');
    const count = Math.max(1, Math.ceil((keep.total || 0) / CHUNK_SIZE));
    for (let i = 0; i < count; i++) {
      if (signal.aborted) return;
      await this.#chunk(id, keep, i, cache, signal);
    }
    keep.filling = false;
    keep.done = true;
    this.#emit(id);
  }

  /**
   * How much of it is here.
   *
   * `loaded` counts what has been WRITTEN, not what has been asked for, so a bar built on
   * it never runs ahead of the bytes.
   */
  status(id) {
    const keep = this.kept.get(id);
    if (!keep) return { kept: false, loaded: 0, total: null, ratio: 0, filling: false, done: false, error: null };
    const total = keep.total ?? null;
    // The last chunk is short, so counting every stored chunk as a whole one would report
    // more bytes than the file has.
    const last = total ? Math.ceil(total / CHUNK_SIZE) - 1 : -1;
    let loaded = 0;
    for (const i of keep.have) loaded += i === last ? total - last * CHUNK_SIZE : CHUNK_SIZE;
    return {
      kept: true,
      total,
      loaded,
      ratio: total ? Math.min(1, loaded / total) : 0,
      filling: keep.filling,
      done: keep.done,
      error: keep.failed,
    };
  }

  /** Stop filling. What is already stored stays — a resumed download starts from it. */
  cancel(id) {
    const keep = this.kept.get(id);
    if (!keep) return;
    keep.controller?.abort();
    keep.filling = false;
    this.#emit(id);
  }

  /** Stop keeping it, and reclaim the bytes. */
  async remove(id) {
    const keep = this.kept.get(id);
    this.cancel(id);
    this.kept.delete(id);
    keep?.have?.clear();
    await this.#dropChunks(id);
    this.#emit(id);
  }

  /**
   * Drop every chunk for this file, whatever etag they were stored under.
   *
   * Prefix-matched rather than index-counted: after an etag change we no longer know how
   * many chunks the old file had, and leaving them would be a leak nothing ever reclaims.
   */
  async #dropChunks(id) {
    const cache = await this.#cache(CHUNKS_CACHE);
    if (!cache) return;
    const prefix = `${this.mediaUrls.cacheKey(id)}#chunk=`;
    const keys = await cache.keys().catch(() => []);
    for (const req of keys) {
      if (req.url.startsWith(prefix)) await cache.delete(req).catch(() => {});
    }
  }
}

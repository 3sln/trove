// URLs for things that cannot send a header.
//
// An `<img src>`, a `<video src>` and `cache.add()` all fetch without our Authorization
// header, so on a token-authenticated deployment they 401 and the preview shows a
// fallback. The server can mint a URL that carries its own grant (see
// docs/design/signed-urls.md); this is the client half.
//
// Two things it exists to get right:
//
//   BATCHING — a gallery draws hundreds of tiles at once. Per-object signing is right for
//   scoping and hopeless as one round trip each, so ids asked for in the same tick go out
//   together.
//
//   EXPIRY — a minted URL dies. Callers get `expiresAt` alongside and are expected to
//   cycle (see ui/media.js); this service will not hand back a URL that is about to
//   expire, so a caller that re-asks always gets something usable.

// Re-mint at 80% of the remaining life rather than at the end: a URL handed out at 99%
// of its life is one the caller will be back for almost immediately.
const FRESH_ENOUGH = 0.8;
// Ids asked for within this window go out as one request. A frame is 16ms; this is long
// enough to collect a grid's first paint and short enough not to be felt.
const BATCH_MS = 20;
const MAX_BATCH = 200;

export class MediaUrlService {
  /** @param {{api: object, settings?: object}} deps */
  constructor({ api, settings = null }) {
    this.api = api;
    this.settings = settings;
    this.cache = new Map(); // `${op}:${id}` -> { url, expiresAt }
    this._queue = new Map(); // op -> Map(id -> {resolve, reject})
    this._timer = null;
  }

  /**
   * Whether URLs need minting at all.
   *
   * With no bearer token the browser authenticates itself — a cookie or a proxy header
   * rides along on a subresource load — so the plain route URL works, needs no round
   * trip, and stays stable enough to be a cache key. Minting there would be a cost with
   * nothing bought. This is the one branch, and it lives here so callers have none.
   *
   * `media.signedUrls` overrides the guess: a deployment behind a proxy that still wants
   * media fetched straight from S3 sets `always`.
   */
  get needed() {
    const mode = this.settings?.get('media.signedUrls');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return !!this.api.token?.();
  }

  /**
   * A stable identifier for this node's bytes.
   *
   * NOT the URL to fetch — a minted one carries a signature and changes every time. The
   * offline cache keys on this, because a key that changes per mint means `unpin` stops
   * matching what `pin` stored and the bytes are never reclaimed.
   */
  cacheKey(id) {
    return this.api.downloadUrl(id);
  }

  /**
   * A URL for this node's bytes, good for a while.
   *
   * @returns {Promise<{url: string, expiresAt: number}>} `expiresAt` is Infinity when
   *   nothing was minted, so a caller's cycling logic simply never fires.
   */
  async url(id, { op = 'media' } = {}) {
    if (!this.needed) return { url: this.api.downloadUrl(id, { attachment: op === 'download' }), expiresAt: Infinity };
    const key = `${op}:${id}`;
    const hit = this.cache.get(key);
    if (hit && this.#fresh(hit)) return hit;
    return this.#enqueue(id, op);
  }

  /** Forget what we hold for a node, so the next ask re-mints. */
  invalidate(id, op = 'media') {
    if (id == null) this.cache.clear();
    else this.cache.delete(`${op}:${id}`);
  }

  #fresh(entry) {
    if (entry.expiresAt === Infinity) return true;
    const life = entry.expiresAt - entry.mintedAt;
    return Date.now() < entry.mintedAt + life * FRESH_ENOUGH;
  }

  #enqueue(id, op) {
    if (!this._queue.has(op)) this._queue.set(op, new Map());
    const forOp = this._queue.get(op);
    const existing = forOp.get(id);
    if (existing) return existing.promise;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    forOp.set(id, { resolve, reject, promise });

    // Flush immediately at the cap rather than waiting out the window — a drive view that
    // asks for a thousand tiles should not hold the first two hundred hostage.
    if (forOp.size >= MAX_BATCH) this.#flush();
    else if (!this._timer) this._timer = setTimeout(() => this.#flush(), BATCH_MS);
    return promise;
  }

  async #flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const queue = this._queue;
    this._queue = new Map();

    for (const [op, waiting] of queue) {
      const ids = [...waiting.keys()];
      try {
        const res = await this.api.mintUrls(ids, op);
        const now = Date.now();
        // Sweep before inserting. An expired entry can never be served again — `#fresh`
        // only decides whether a HIT is usable — and nothing else ever removed one: the
        // sole `invalidate` caller is a media element's error handler. Browsing a large
        // collection mints per pictorial tile, so the map grew an entry per image, none
        // reachable and none collectable for the life of the page. Two lines, and unlike
        // the interning table in bl/intern.js, evicting here costs a re-mint rather than a
        // duplicate realization.
        for (const [key, entry] of this.cache) {
          if (entry.expiresAt && entry.expiresAt < now) this.cache.delete(key);
        }
        for (const [id, w] of waiting) {
          const got = res.urls?.[id];
          if (got) {
            const entry = { url: got.url, expiresAt: got.expiresAt, mintedAt: now };
            this.cache.set(`${op}:${id}`, entry);
            w.resolve(entry);
          } else {
            // Absent from the answer means this caller may not read it. A rejection, not
            // a broken URL — the tile shows its icon rather than a broken-image glyph.
            w.reject(new Error(res.failed?.[id] === 'not_found' ? 'That file is gone' : 'You cannot open that file'));
          }
        }
      } catch (err) {
        for (const w of waiting.values()) w.reject(err);
      }
    }
  }
}

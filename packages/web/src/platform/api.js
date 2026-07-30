// TroveApiClient — the browser's view of the server API. Thin JSON calls with
// transient-error retry, plus the upload orchestrator, which is where the "handle
// large uploads well" requirement lives:
//
//   • Chooses nothing itself — it follows the plan the server returns (single /
//     presigned-multipart / direct-multipart), so an S3 deployment uploads parts
//     straight to S3 and a filesystem deployment streams through the server, with
//     the same client code.
//   • Uploads parts concurrently (bounded), each with its own retry, and reports
//     aggregate byte progress for a live progress bar.
//   • Resumable: on retry it asks the server which parts already landed and skips
//     them, so a dropped connection doesn't restart a 4 GB upload.
//
// Uploads use XMLHttpRequest because fetch can't report upload progress.

import { withRetry } from '@3sln/trove/core/retry.js';
import { TroveError } from '@3sln/trove/core/errors.js';

export class TroveApiClient {
  /**
   * @param {{baseUrl?: string, fetch?: Function, token?: string|(() => string|null)}} [opts]
   *   `token` is a bearer JWT, or a function returning one. Optional because the common
   *   deployment puts an authenticating proxy in front (Cloudflare Access sets its own
   *   header and the browser sends nothing) — but a deployment where the user HOLDS a
   *   token has no way to present it otherwise, which is why this exists.
   */
  constructor({ baseUrl = '', fetch: f = globalThis.fetch.bind(globalThis), token = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this._fetch = f;
    this._token = token;
  }

  /** The bearer token to present, if any. Read per request so a refresh takes effect. */
  token() {
    const t = typeof this._token === 'function' ? this._token() : this._token;
    return t || null;
  }
  /** Auth headers for a request, or nothing at all when there is no token to send. */
  authHeaders() {
    const t = this.token();
    return t ? { authorization: `Bearer ${t}` } : {};
  }

  async request(method, path, { body, query, signal, raw } = {}) {
    const url = this.baseUrl + path + (query ? '?' + new URLSearchParams(query) : '');
    return withRetry(
      async () => {
        const res = await this._fetch(url, {
          method,
          headers: { ...this.authHeaders(), ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });
        if (res.status === 429 || res.status >= 500) {
          // Read the structured error to decide retry: an explicitly non-retryable
          // failure (e.g. a per-file size limit) must fail fast with its real message,
          // not be retried 3× into a generic "Server 429". `raw` requests can't consume
          // the body here, so they stay status-based.
          if (!raw) {
            let e;
            try { const t = await res.text(); e = (t ? JSON.parse(t) : null)?.error; } catch { /* non-JSON body */ }
            if (e && e.retryable === false) throw new TroveError(e.code, e.message, { retryable: false, details: e.details });
            throw TroveError.transient(e?.message || `Server ${res.status}`);
          }
          throw TroveError.transient(`Server ${res.status}`);
        }
        if (raw) return res;
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) {
          const e = json?.error || { code: 'internal', message: `Request failed (${res.status})` };
          throw new TroveError(e.code, e.message, { retryable: e.retryable, details: e.details });
        }
        return json;
      },
      { signal, retries: 3 },
    );
  }

  // --- browse / mutate -------------------------------------------------------

  capabilities() {
    return this.request('GET', '/api/capabilities');
  }
  /** Single-shot reachability probe (short timeout, no retries) — is the server
   *  actually reachable, vs. `navigator.onLine` merely reporting an up interface? */
  async reachable(timeoutMs = 4000) {
    try {
      const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      const res = await this._fetch(this.baseUrl + '/api/capabilities', { method: 'GET', signal, headers: this.authHeaders() });
      return res.ok;
    } catch { return false; }
  }
  // Collection-scoped calls name their collection in the PATH. There is no default and
  // no `?collection=`: the server refuses a request that does not say which collection it
  // means, so a caller that forgets gets an error here rather than silently reaching one.
  /** Every item in a collection. */
  list(collection, opts = {}) {
    return this.request('GET', `${this.#scope(collection)}/items`, { query: opts });
  }
  /** Resolve an item by id, by `trove:` URI, or by name within a collection. */
  stat(ref, { collection, ...opts } = {}) {
    const key = String(ref).startsWith('trove:') ? 'uri' : 'id';
    // A name is only unique inside a collection, so resolving one needs the scope. An id
    // or a trove: URI names itself, and the flat resolve is fine for those.
    const base = collection ? `${this.#scope(collection)}/items/resolve` : '/api/items/resolve';
    return this.request('GET', base, { query: { [key]: ref, ...opts } });
  }
  #scope(collection) {
    if (!collection) throw new Error('This call is scoped to a collection — pass one');
    return `/api/collections/${encodeURIComponent(collection)}`;
  }
  /** What links to this item. */
  backlinks(id, opts = {}) {
    return this.request('GET', '/api/items/backlinks', { query: { id, ...opts } });
  }
  rename(id, newName) {
    return this.request('POST', '/api/items/rename', { body: { id, newName } });
  }
  remove(id) {
    return this.request('POST', '/api/items/delete', { body: { id } });
  }
  /** What's been deleted but not yet destroyed. */
  trash(collection) {
    return this.request('GET', `${this.#scope(collection)}/trash`);
  }
  restore(id) {
    return this.request('POST', '/api/trash/restore', { body: { id } });
  }
  /** Destroy for real — one item, or everything in a collection's trash. */
  purgeTrash({ id, collection } = {}) {
    // One item names itself; emptying a whole collection has to name the collection, and
    // says so in the URL — "everything in here" is the request that must never be able
    // to mean somewhere you did not point at.
    return id
      ? this.request('POST', '/api/trash/purge', { body: { id } })
      : this.request('POST', `${this.#scope(collection)}/trash/purge`);
  }
  search(q, { collection, ...opts } = {}) {
    const base = collection ? `${this.#scope(collection)}/search` : '/api/search';
    return this.request('GET', base, { query: { q, ...opts } });
  }
  // Unified query: server transforms the raw string (parse/LLM) → runs it → returns
  // { query, results, resolved }. `resolved` is what was actually searched.
  query(q, { collection, ...opts } = {}) {
    const base = collection ? `${this.#scope(collection)}/query` : '/api/query';
    return this.request('POST', base, { body: { q, ...opts } });
  }
  // Drive-wide tag/property filter (launcher #tag / #key:op:value).
  tagSearch(filters, q, { collection, ...opts } = {}) {
    const base = collection ? `${this.#scope(collection)}/tags/search` : '/api/tags/search';
    return this.request('POST', base, { body: { filters, q, ...opts } });
  }
  indexers() {
    return this.request('GET', '/api/indexers');
  }

  // --- background work + standing problems -----------------------------------
  // Tasks are in-flight and ephemeral; issues are what a failure left behind and are
  // durable. Ids can contain anything (an issue id embeds a node id), so every one of
  // these encodes before it becomes a path segment.
  tasks() {
    return this.request('GET', '/api/tasks');
  }
  cancelTask(id) {
    return this.request('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`);
  }
  dismissTask(id) {
    return this.request('DELETE', `/api/tasks/${encodeURIComponent(id)}`);
  }
  issues() {
    return this.request('GET', '/api/issues');
  }
  retryIssue(id) {
    return this.request('POST', `/api/issues/${encodeURIComponent(id)}/retry`);
  }
  dismissIssue(id) {
    return this.request('DELETE', `/api/issues/${encodeURIComponent(id)}`);
  }
  reindex() {
    return this.request('POST', '/api/reindex');
  }
  /** Reconcile a collection against its object store (changes made outside Trove). */
  scanCollection(id) {
    return this.request('POST', `/api/collections/${encodeURIComponent(id)}/scan`);
  }

  /**
   * Check every collection's backing store for problems a browser would hit — chiefly a
   * missing CORS policy, which leaves the file list and search working while every file
   * fails to open.
   *
   * Worth asking from the browser rather than only on a timer: the server checks against
   * the origin of THIS request, and a bucket policy may name exactly one origin.
   */
  checkStorage() {
    return this.request('POST', '/api/diagnostics/storage');
  }

  // --- server plugin installs (account-scoped, synced across devices) ---------
  /** Upload a package zip for account install; returns the server install record. */
  async installPlugin(bytes, grants) {
    const q = grants && grants.length ? '?grants=' + encodeURIComponent(grants.join(',')) : '';
    const res = await this._fetch(this.baseUrl + '/api/plugins/install' + q, { method: 'POST', body: bytes, headers: this.authHeaders() });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = json?.error || { code: 'internal', message: `Install failed (${res.status})` };
      throw new TroveError(e.code, e.message, { details: e.details });
    }
    return json.install;
  }
  installedPlugins() {
    return this.request('GET', '/api/plugins/installed');
  }
  async pluginPackage(id) {
    const res = await this._fetch(`${this.baseUrl}/api/plugins/${encodeURIComponent(id)}/package`, { headers: this.authHeaders() });
    if (!res.ok) throw new TroveError('not_found', `Package for "${id}" not found`);
    return new Uint8Array(await res.arrayBuffer());
  }
  uninstallPluginServer(id) {
    return this.request('DELETE', `/api/plugins/${encodeURIComponent(id)}/install`);
  }
  // contribution: { semanticTexts?, tags?, metadata? } (legacy { documents, facet } ok).
  pushIndex(indexerId, nodeId, contribution) {
    return this.request('POST', `/api/index/${encodeURIComponent(indexerId)}`, { body: { nodeId, ...contribution } });
  }

  // --- identity --------------------------------------------------------------
  me() {
    return this.request('GET', '/api/me');
  }

  // --- collections -----------------------------------------------------------
  collections() {
    return this.request('GET', '/api/collections');
  }
  createCollection(body) {
    return this.request('POST', '/api/collections', { body });
  }

  // --- conversations, tags, sidecar ------------------------------------------
  sidecar(id) {
    return this.request('GET', `/api/items/${encodeURIComponent(id)}/sidecar`);
  }
  addComment(id, { body, parentId, mentions } = {}) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/comments`, { body: { body, parentId, mentions } });
  }
  editComment(id, cid, body) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/edit`, { body: { body } });
  }
  deleteComment(id, cid) {
    return this.request('DELETE', `/api/items/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}`);
  }
  reactComment(id, cid, emoji, on) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/comments/${encodeURIComponent(cid)}/react`, { body: { emoji, on } });
  }
  setTag(id, name, value) {
    return this.request('POST', `/api/items/${encodeURIComponent(id)}/tags`, { body: { name, value } });
  }
  removeTag(id, name) {
    return this.request('DELETE', `/api/items/${encodeURIComponent(id)}/tags/${encodeURIComponent(name)}`);
  }

  // --- notifications & push --------------------------------------------------
  notifications() {
    return this.request('GET', '/api/notifications');
  }
  markNotificationsRead(ids) {
    return this.request('POST', '/api/notifications/read', { body: { ids } });
  }
  vapidKey() {
    return this.request('GET', '/api/push/vapid');
  }

  // --- API keys (admin) -------------------------------------------------------
  // Capability-only credentials; see core/apiKeys.js. `mintApiKey` is the one call in
  // this client whose response contains a secret, and it is the only chance to see it.
  apiKeys() {
    return this.request('GET', '/api/keys');
  }
  mintApiKey({ name, scopes, expiresAt = null }) {
    return this.request('POST', '/api/keys', { body: { name, scopes, expiresAt } });
  }
  revokeApiKey(id) {
    return this.request('DELETE', `/api/keys/${encodeURIComponent(id)}`);
  }
  subscribePush(subscription) {
    return this.request('POST', '/api/push/subscribe', { body: { subscription } });
  }

  /** URL for GET-ing bytes (used by <img>/<audio>/<video> and downloads). */
  downloadUrl(id, { attachment } = {}) {
    return `${this.baseUrl}/api/items/download?id=${encodeURIComponent(id)}${attachment ? '&disposition=attachment' : ''}`;
  }

  /**
   * Mint URLs that carry their own authorization, for the things that cannot send a
   * header — an <img src>, a <video src>, cache.add(). Batched: a gallery asks for what
   * it is about to draw, in one request. See platform/mediaUrls.js.
   */
  mintUrls(ids, op = 'media') {
    return this.request('POST', '/api/items/urls', { body: { ids, op } });
  }

  /**
   * Start a download in the browser.
   *
   * With no bearer token this is a plain navigation to the download URL — the browser
   * streams it, handles Range, and never buffers a 4 GB file in a tab. When a token IS
   * in play that isn't possible: an `<a href>` cannot carry an Authorization header, so
   * the navigation would arrive unauthenticated and 401. Rather than move the token into
   * the query string (where it lands in logs, history, and referrers), fetch the bytes
   * with the header and hand the browser a blob.
   *
   * The cost is honest and worth stating: the blob path holds the file in memory. It is
   * the price of bearer auth without a token-bearing URL, and it does not apply to the
   * common proxy-authenticated deployment, which takes the streaming path.
   */
  async download(id, name, { attachment = true } = {}) {
    const url = this.downloadUrl(id, { attachment });
    if (!this.token()) return { url, streamed: true };
    const res = await this._fetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new TroveError('internal', `Download failed (${res.status})`);
    return { url: URL.createObjectURL(await res.blob()), streamed: false, revoke: true };
  }

  /** Read a whole file as text/bytes (small files, indexers). */
  async readBytes(id, { signal } = {}) {
    const res = await this._fetch(this.downloadUrl(id), { signal, headers: this.authHeaders() });
    if (!res.ok) throw new TroveError('internal', `Download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async readText(id, opts) {
    return new TextDecoder().decode(await this.readBytes(id, opts));
  }

  /**
   * Read at most `maxBytes` of a file as text.
   *
   * A viewer must never pull a whole file just to show the top of it. A drive holds
   * logs, exports and dumps that are hundreds of megabytes; `readText` on one of those
   * buffers the entire thing in the tab before a single character is drawn, and the
   * browser is gone before the user learns anything. A Range request costs one extra
   * byte over the wire and bounds the damage at the transfer rather than the render.
   *
   * The cut is at a BYTE boundary, which can land mid-character in UTF-8, so the
   * decoder is told to tolerate it — a trailing replacement glyph beats throwing away
   * the read. The last partial line is dropped for the same reason.
   *
   * @returns {Promise<{text: string, truncated: boolean, total: number|null}>}
   */
  async readTextCapped(id, { maxBytes = 512 * 1024, size = null, signal } = {}) {
    // Skip the Range when we already know the file fits. An empty file has no
    // satisfiable range, so asking for one turned "open an empty note" into an error
    // page; a 416 from any backend would do the same.
    const ranged = size == null || size > maxBytes;
    const res = await this._fetch(this.downloadUrl(id), {
      signal,
      headers: { ...this.authHeaders(), ...(ranged ? { range: `bytes=0-${maxBytes - 1}` } : {}) },
    });
    if (res.status === 416) return { text: '', truncated: false, total: 0 };
    if (!res.ok && res.status !== 206) throw new TroveError('internal', `Download failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // `Content-Range: bytes 0-N/TOTAL` is how we learn the real size; a server that
    // ignored the Range header just sent everything, which is also fine.
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]) || null;
    const truncated = bytes.length >= maxBytes && (total == null || total > bytes.length);
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (truncated) {
      const lastBreak = text.lastIndexOf('\n');
      if (lastBreak > 0) text = text.slice(0, lastBreak);
    }
    return { text, truncated, total };
  }

  /**
   * Upload a File/Blob with progress + resume.
   * @param {Blob & {name?:string}} file
   * @param {object} opts
   * @param {string} opts.parentId
   * @param {string} [opts.name]
   * @param {(p:{loaded:number,total:number,ratio:number}) => void} [opts.onProgress]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.concurrency]
   * @returns {Promise<object>} the created node
   */
  async upload(file, opts) {
    const name = opts.name || file.name || 'untitled';
    const size = file.size;
    const plan = await this.request('POST', `${this.#scope(opts.collection)}/uploads`, {
      body: { name, size, contentType: file.type || undefined },
      signal: opts.signal,
    });
    // Hand the caller the server upload id so a cancel/failure can abort the session
    // (otherwise a multipart upload leaks server + storage state).
    if (plan.uploadId) opts.onStart?.(plan.uploadId);

    const progress = new ProgressAggregator(size, opts.onProgress);
    const t = plan.transfer || {};
    const completeUrl = plan.endpoints?.complete || `/api/uploads/${plan.uploadId}/complete`;

    if (plan.strategy === 'single') {
      // One presigned PUT straight to storage (bytes never touch our server).
      await xhrPut(t.url || plan.url, file, { headers: t.requiredHeaders, signal: opts.signal, onProgress: (l) => progress.set('single', l) });
      const done = await this.request('POST', completeUrl, { body: {}, signal: opts.signal });
      return done.node;
    }
    if (plan.strategy === 'direct-single') {
      await xhrPut(this.baseUrl + this.#partUrl(plan, 1), file, {
        // Our own server, so it needs our bearer token; `t.authHeaders` lets the plan
        // add its own and wins on a clash.
        headers: { ...this.authHeaders(), ...t.authHeaders },
        signal: opts.signal, onProgress: (l) => progress.set(1, l),
      });
      const done = await this.request('POST', completeUrl, { body: {}, signal: opts.signal });
      return done.node;
    }

    // Multipart (presign or direct).
    const partSize = plan.partSize;
    const partCount = plan.partCount ?? Math.ceil(size / partSize);
    // Resume: which parts already exist?
    let received = new Set();
    try {
      const statusUrl = plan.endpoints?.status || `/api/uploads/${plan.uploadId}/status`;
      const status = await this.request('GET', statusUrl, { signal: opts.signal });
      received = new Set(status.received || []);
    } catch { /* fresh upload */ }

    const parts = [];
    const jobs = [];
    for (let n = 1; n <= partCount; n++) {
      const start = (n - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, size));
      jobs.push({ n, blob });
    }

    const results = new Array(partCount);
    const concurrency = Math.min(opts.concurrency ?? 4, jobs.length);
    let cursor = 0;
    // When one part fails for good, abort the sibling workers' in-flight parts instead
    // of letting them keep PUTting bytes whose result we're about to discard. The inner
    // controller is chained to the caller's signal so a user cancel still propagates.
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    if (opts.signal) {
      if (opts.signal.aborted) inner.abort();
      else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const worker = async () => {
      while (cursor < jobs.length) {
        if (inner.signal.aborted) return;
        const { n, blob } = jobs[cursor++];
        if (received.has(n)) {
          progress.set(n, blob.size);
          continue;
        }
        const etag = await withRetry(
          () => this.#uploadPart(plan, n, blob, {
            signal: inner.signal, onProgress: (l) => progress.set(n, l),
          }),
          { signal: inner.signal, retries: 4 },
        );
        results[n - 1] = { partNumber: n, etag };
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } catch (err) {
      inner.abort(); // stop the other workers before surfacing the failure
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    const reportedParts = results.filter(Boolean);
    const done = await this.request('POST', completeUrl, {
      body: { parts: reportedParts }, signal: opts.signal,
    });
    return done.node;
  }

  // Expand an endpoint/transfer URL template's {partNumber} placeholder.
  #partUrl(plan, n) {
    const tmpl = plan.transfer?.partUrl || `/api/uploads/${plan.uploadId}/parts/{partNumber}`;
    return tmpl.replace('{partNumber}', String(n));
  }

  async #uploadPart(plan, n, blob, { signal, onProgress }) {
    const t = plan.transfer || {};
    if (plan.strategy === 'presign') {
      const part = (t.parts || plan.parts)?.find((p) => p.partNumber === n);
      let url = part?.url;
      if (!url) {
        const signTmpl = plan.endpoints?.sign || `/api/uploads/${plan.uploadId}/parts/{partNumber}/sign`;
        const r = await this.request('POST', signTmpl.replace('{partNumber}', String(n)), { signal });
        url = r.url;
      }
      const res = await xhrPut(url, blob, { signal, onProgress, wantEtag: true });
      const etag = res.etag;
      const reportTmpl = plan.endpoints?.report || `/api/uploads/${plan.uploadId}/parts/{partNumber}/report`;
      await this.request('POST', reportTmpl.replace('{partNumber}', String(n)), { body: { etag }, signal });
      return etag;
    }
    // proxied: server records the etag; response body has it.
    const res = await xhrPut(this.baseUrl + this.#partUrl(plan, n), blob, {
      headers: { ...this.authHeaders(), ...t.authHeaders },
      signal, onProgress, wantJson: true,
    });
    return res.json?.etag;
  }

  async abortUpload(uploadId) {
    return this.request('DELETE', `/api/uploads/${uploadId}`);
  }
}

class ProgressAggregator {
  constructor(total, cb) {
    this.total = total;
    this.cb = cb;
    this.parts = new Map();
  }
  set(key, loaded) {
    // Monotonic per part: a retried part restarts its XHR progress at 0, which would
    // otherwise pull the aggregate bar backwards. Never let a part's reported bytes drop.
    const prev = this.parts.get(key) || 0;
    if (loaded < prev) return;
    this.parts.set(key, loaded);
    if (!this.cb) return;
    let sum = 0;
    for (const v of this.parts.values()) sum += v;
    const loadedTotal = Math.min(sum, this.total);
    this.cb({ loaded: loadedTotal, total: this.total, ratio: this.total ? loadedTotal / this.total : 1 });
  }
}

// XHR PUT with upload progress + abort. Returns { status, etag?, json? }.
function xhrPut(url, body, { signal, onProgress, wantEtag, wantJson, headers } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers || {})) { try { xhr.setRequestHeader(k, v); } catch { /* forbidden header */ } }
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return reject(TroveError.aborted());
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const out = { status: xhr.status };
        if (wantEtag) out.etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
        if (wantJson) {
          try {
            out.json = JSON.parse(xhr.responseText);
          } catch { /* ignore */ }
        }
        resolve(out);
      } else if (xhr.status === 429 || xhr.status >= 500) {
        reject(TroveError.transient(`Upload part failed (${xhr.status})`));
      } else {
        reject(new TroveError('internal', `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(TroveError.transient('Network error during upload'));
    xhr.onabort = () => reject(TroveError.aborted());
    xhr.send(body);
  });
}

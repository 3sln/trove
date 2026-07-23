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

import { withRetry } from '@trove/core/retry.js';
import { TroveError } from '@trove/core/errors.js';

export class TroveApiClient {
  constructor({ baseUrl = '', fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this._fetch = f;
  }

  async request(method, path, { body, query, signal, raw } = {}) {
    const url = this.baseUrl + path + (query ? '?' + new URLSearchParams(query) : '');
    return withRetry(
      async () => {
        const res = await this._fetch(url, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });
        if (res.status === 429 || res.status >= 500) {
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
  list(pathOrId, opts = {}) {
    const key = pathOrId?.startsWith?.('/') ? 'path' : 'id';
    return this.request('GET', '/api/fs/list', { query: { [key]: pathOrId, ...opts } });
  }
  stat(pathOrId) {
    const key = pathOrId?.startsWith?.('/') ? 'path' : 'id';
    return this.request('GET', '/api/fs/stat', { query: { [key]: pathOrId } });
  }
  mkdir(parentId, name) {
    return this.request('POST', '/api/fs/folder', { body: { parentId, name } });
  }
  move(id, destParentId, newName) {
    return this.request('POST', '/api/fs/move', { body: { id, destParentId, newName } });
  }
  rename(id, newName) {
    return this.request('POST', '/api/fs/rename', { body: { id, newName } });
  }
  remove(id, recursive = true) {
    return this.request('POST', '/api/fs/delete', { body: { id, recursive } });
  }
  search(q, opts = {}) {
    return this.request('GET', '/api/search', { query: { q, ...opts } });
  }
  indexers() {
    return this.request('GET', '/api/indexers');
  }
  pushIndex(indexerId, nodeId, documents, facet) {
    return this.request('POST', `/api/index/${encodeURIComponent(indexerId)}`, { body: { nodeId, documents, facet } });
  }

  /** URL for GET-ing bytes (used by <img>/<audio>/<video> and downloads). */
  downloadUrl(id, { attachment } = {}) {
    return `${this.baseUrl}/api/fs/download?id=${encodeURIComponent(id)}${attachment ? '&disposition=attachment' : ''}`;
  }

  /** Read a whole file as text/bytes (small files, indexers). */
  async readBytes(id, { signal } = {}) {
    const res = await this._fetch(this.downloadUrl(id), { signal });
    if (!res.ok) throw new TroveError('internal', `Download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async readText(id, opts) {
    return new TextDecoder().decode(await this.readBytes(id, opts));
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
    const plan = await this.request('POST', '/api/uploads', {
      body: { parentId: opts.parentId, name, size, contentType: file.type || undefined },
      signal: opts.signal,
    });

    const progress = new ProgressAggregator(size, opts.onProgress);

    if (plan.strategy === 'single') {
      await xhrPut(plan.url, file, { signal: opts.signal, onProgress: (l) => progress.set('single', l) });
      const done = await this.request('POST', `/api/uploads/${plan.uploadId}/complete`, { body: {}, signal: opts.signal });
      return done.node;
    }
    if (plan.strategy === 'direct-single') {
      await xhrPut(`${this.baseUrl}/api/uploads/${plan.uploadId}/parts/1`, file, {
        signal: opts.signal, onProgress: (l) => progress.set(1, l),
      });
      const done = await this.request('POST', `/api/uploads/${plan.uploadId}/complete`, { body: {}, signal: opts.signal });
      return done.node;
    }

    // Multipart (presign or direct).
    const partSize = plan.partSize;
    const partCount = plan.partCount ?? Math.ceil(size / partSize);
    // Resume: which parts already exist?
    let received = new Set();
    try {
      const status = await this.request('GET', `/api/uploads/${plan.uploadId}/status`, { signal: opts.signal });
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
    const worker = async () => {
      while (cursor < jobs.length) {
        const { n, blob } = jobs[cursor++];
        if (received.has(n)) {
          progress.set(n, blob.size);
          continue;
        }
        const etag = await withRetry(
          () => this.#uploadPart(plan, n, blob, {
            signal: opts.signal, onProgress: (l) => progress.set(n, l),
          }),
          { signal: opts.signal, retries: 4 },
        );
        results[n - 1] = { partNumber: n, etag };
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const reportedParts = results.filter(Boolean);
    const done = await this.request('POST', `/api/uploads/${plan.uploadId}/complete`, {
      body: { parts: reportedParts }, signal: opts.signal,
    });
    return done.node;
  }

  async #uploadPart(plan, n, blob, { signal, onProgress }) {
    if (plan.strategy === 'presign') {
      const part = plan.parts?.find((p) => p.partNumber === n);
      let url = part?.url;
      if (!url) {
        const r = await this.request('POST', `/api/uploads/${plan.uploadId}/parts/${n}/sign`, { signal });
        url = r.url;
      }
      const res = await xhrPut(url, blob, { signal, onProgress, wantEtag: true });
      const etag = res.etag;
      await this.request('POST', `/api/uploads/${plan.uploadId}/parts/${n}/report`, { body: { etag }, signal });
      return etag;
    }
    // direct: server records the etag; response body has it.
    const res = await xhrPut(`${this.baseUrl}/api/uploads/${plan.uploadId}/parts/${n}`, blob, {
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
    this.parts.set(key, loaded);
    if (!this.cb) return;
    let sum = 0;
    for (const v of this.parts.values()) sum += v;
    const loadedTotal = Math.min(sum, this.total);
    this.cb({ loaded: loadedTotal, total: this.total, ratio: this.total ? loadedTotal / this.total : 1 });
  }
}

// XHR PUT with upload progress + abort. Returns { status, etag?, json? }.
function xhrPut(url, body, { signal, onProgress, wantEtag, wantJson } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
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

// PrefixedStorage — wraps any StorageBackend and namespaces every key under a
// prefix. This is what lets many collections share one bucket ("bucket + prefix"):
// each collection gets its own PrefixedStorage over the same underlying S3/FS
// backend, isolated by key prefix, with zero changes to the backend itself.

import { StorageBackend } from './interface.js';

export class PrefixedStorage extends StorageBackend {
  /** @param {StorageBackend} inner @param {string} prefix e.g. "team-a/" */
  constructor(inner, prefix) {
    super();
    this.inner = inner;
    this.prefix = prefix ? prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  }
  #k(key) {
    return this.prefix + key;
  }
  #strip(key) {
    return this.prefix && key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  async list(opts = {}) {
    // The prefix is this wrapper's whole job, so listing has to add it on the way in
    // and strip it on the way out — a caller must never see the wrapper's own prefix
    // and try to store it as a key.
    const res = await this.inner.list({ ...opts, prefix: this.#k(opts.prefix || '') });
    return { ...res, objects: res.objects.map((o) => ({ ...o, key: this.#strip(o.key) })) };
  }
  put(key, body, opts) {
    return this.inner.put(this.#k(key), body, opts);
  }
  get(key, opts) {
    return this.inner.get(this.#k(key), opts);
  }
  head(key) {
    return this.inner.head(this.#k(key));
  }
  delete(key, opts) {
    return this.inner.delete(this.#k(key), opts);
  }
  presignGet(key, opts) {
    return this.inner.presignGet(this.#k(key), opts);
  }
  presignPut(key, opts) {
    return this.inner.presignPut(this.#k(key), opts);
  }
  createMultipart(key, opts) {
    return this.inner.createMultipart(this.#k(key), opts);
  }
  presignPart(key, uploadId, partNumber, opts) {
    return this.inner.presignPart(this.#k(key), uploadId, partNumber, opts);
  }
  putPart(key, uploadId, partNumber, body, opts) {
    return this.inner.putPart(this.#k(key), uploadId, partNumber, body, opts);
  }
  completeMultipart(key, uploadId, parts, opts) {
    return this.inner.completeMultipart(this.#k(key), uploadId, parts, opts);
  }
  abortMultipart(key, uploadId, opts) {
    return this.inner.abortMultipart(this.#k(key), uploadId, opts);
  }
}

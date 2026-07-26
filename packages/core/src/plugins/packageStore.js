// PackageStore — pluggable bulk storage for installed plugin package blobs (the
// zips). Kept separate from install *records* (which live in SQLite): the blobs are
// bulk data an operator usually wants on S3/R2 or a filesystem, and possibly on a
// different backend than user files. The default just wraps the primary
// StorageBackend under a prefix; inject any other StorageBackend (or a bespoke
// PackageStore) to point packages elsewhere.
//
// Blobs are addressed by an opaque `ref` (see PluginService — `account/plugin/ver.zip`).
// Content is deduped by digest at the service layer, so `put` is effectively idempotent.

import { PrefixedStorage } from '../storage/prefixed.js';
import { TroveError } from '../errors.js';

export class PackageStore {
  /** @param {string} ref @param {Uint8Array} bytes */
  async put(ref, bytes) { throw TroveError.unsupported('PackageStore.put'); }
  /** @returns {Promise<{stream: ReadableStream, size: number}>} */
  async get(ref) { throw TroveError.unsupported('PackageStore.get'); }
  /** @returns {Promise<boolean>} */
  async has(ref) { throw TroveError.unsupported('PackageStore.has'); }
  async delete(ref) {}
  /** Optional: a URL a device can GET the package from directly. */
  async presignGet(ref, opts) { throw TroveError.unsupported('This package store cannot presign'); }
}

/**
 * The key space plugin packages live in.
 *
 * Exported because the collection SCANNER has to skip it, and the two drifted: the
 * scanner's reserved list said `plugins/` while this said `_plugins/`, so every
 * account's package was adopted into the default collection as an ordinary file.
 * One constant, one source of truth.
 */
export const PACKAGE_PREFIX = '_plugins/';

/** Default PackageStore: a namespaced view over any StorageBackend. */
export class StoragePackageStore extends PackageStore {
  /** @param {import('../storage/interface.js').StorageBackend} storage */
  constructor(storage, { prefix = PACKAGE_PREFIX } = {}) {
    super();
    this.storage = prefix ? new PrefixedStorage(storage, prefix) : storage;
  }
  async put(ref, bytes) {
    return this.storage.put(ref, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { contentType: 'application/zip' });
  }
  async get(ref) {
    return this.storage.get(ref);
  }
  async has(ref) {
    try { await this.storage.head(ref); return true; } catch (err) {
      if (err?.code === 'not_found') return false;
      throw err;
    }
  }
  async delete(ref) {
    return this.storage.delete(ref).catch(() => {});
  }
  async presignGet(ref, opts) {
    return this.storage.presignGet(ref, opts);
  }
}

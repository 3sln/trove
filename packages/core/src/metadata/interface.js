// MetadataStore — the source of truth for the file tree and every node's
// attributes. It maps user-visible virtual paths to storage keys (so the blob
// store never sees a path), and holds namespaced *facets*: arbitrary metadata a
// specific indexer owns, stored under its id, so indexers can't clobber each
// other. Search indices may be derived from here but live in SearchService.
//
// A "node" is a file or folder:
//   {
//     id, parentId|null, name, path, kind: 'file'|'folder',
//     size, contentType, storageKey|null, etag,
//     createdAt, updatedAt,
//     meta: {},                 // user-facing metadata (tags, description…)
//     facets: { [indexerId]: object }  // indexer-owned, namespaced
//   }
//
// Implement this interface over anything: the bundled MemoryStore and
// SqliteStore, or D1/Postgres/etc. Every method rejects with a TroveError.

import { TroveError } from '../errors.js';

export class MetadataStore {
  /** Create the root folder if missing; call once at startup. */
  async init() {}

  /** @returns {Promise<object|null>} */
  async getById(id) {
    throw TroveError.unsupported('getById not implemented');
  }
  /** @returns {Promise<object|null>} */
  async getByPath(path) {
    throw TroveError.unsupported('getByPath not implemented');
  }
  /**
   * @param {string} parentId
   * @param {{sort?: 'name'|'size'|'updatedAt', order?: 'asc'|'desc', limit?: number, cursor?: string}} [opts]
   * @returns {Promise<{items: object[], nextCursor: string|null}>}
   */
  async listChildren(parentId, opts) {
    throw TroveError.unsupported('listChildren not implemented');
  }
  /** Insert a node. Rejects ALREADY_EXISTS on (parentId,name) collision. */
  async create(node) {
    throw TroveError.unsupported('create not implemented');
  }
  /** Shallow-merge a patch into a node (excluding id/path structure). */
  async update(id, patch) {
    throw TroveError.unsupported('update not implemented');
  }
  /** Delete a single node (caller ensures folders are emptied first). */
  async remove(id) {
    throw TroveError.unsupported('remove not implemented');
  }
  /** Re-parent and/or rename, rewriting descendant paths atomically. */
  async move(id, newParentId, newName) {
    throw TroveError.unsupported('move not implemented');
  }
  /** All descendants of a folder (for recursive delete/move), depth-first. */
  async descendants(id) {
    throw TroveError.unsupported('descendants not implemented');
  }
  /** Merge `data` into node.facets[indexerId] (namespaced write). */
  async setFacet(id, indexerId, data) {
    throw TroveError.unsupported('setFacet not implemented');
  }
  /** Remove an indexer's facet from a node. */
  async clearFacet(id, indexerId) {
    throw TroveError.unsupported('clearFacet not implemented');
  }
  /** Simple substring/name search fallback (SearchService may do better). */
  async searchByName(query, opts) {
    throw TroveError.unsupported('searchByName not implemented');
  }
  /**
   * Drive-wide tag/property query. `filters` is a list of
   * `{ key, present } | { key, op, value }` (op ∈ = != < <= > >=), matched against
   * a node's `facets.tags` (+ meta). `opts`: { q (name substring), collectionIds,
   * limit }. Returns matching nodes newest-first.
   */
  async findByFacets(filters, opts) {
    throw TroveError.unsupported('findByFacets not implemented');
  }
  async close() {}
}

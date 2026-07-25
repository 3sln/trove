// MetadataStore — the source of truth for the file tree and every node's
// attributes. It maps user-visible virtual paths to storage keys (so the blob
// store never sees a path), and holds each node's *contributions*: what indexers
// (and the user) attach to it, namespaced by contributor id so they never clobber
// one another and can be removed independently.
//
// A contributor (an indexer, or the reserved 'user' scope) writes up to three
// things per node: semantic search text (which lives in SearchService, not here),
// `tags` (filterable key/values), and `metadata` (arbitrary — e.g. an audiobook's
// chapter index). This store holds the tags + metadata:
//
//   {
//     id, parentId|null, name, path, kind: 'file'|'folder',
//     size, contentType, storageKey|null, etag, createdAt, updatedAt,
//     meta: {},   // user-facing scalar metadata (description…)
//     contributions: { [contributorId]: { tags?: {}, metadata?: {} } },
//     tags: {}    // all contributors' tags merged (this is what filtering queries)
//   }
//
// Internally the two are stored together in one JSON column with a reserved
// '#tags' key holding the merged view (denormalized so filtering stays a simple
// json_extract). Implement this interface over anything (Memory/Sqlite/D1/…).

import { TroveError } from '../errors.js';

// The reserved key under which the merged, queryable tag view is denormalized
// alongside the per-contributor namespaces.
export const MERGED_TAGS = '#tags';

/** Merge every contributor's `tags` into one flat map (dropping null/removed). */
export function mergeContributionTags(raw) {
  const merged = {};
  for (const [key, c] of Object.entries(raw || {})) {
    if (key === MERGED_TAGS) continue;
    if (c && c.tags) for (const [k, v] of Object.entries(c.tags)) merged[k] = v;
  }
  for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
  return merged;
}

/** Split the raw stored JSON into the node's exposed `contributions` + `tags`. */
export function splitContributions(raw) {
  const contributions = {};
  for (const [k, v] of Object.entries(raw || {})) if (k !== MERGED_TAGS) contributions[k] = v;
  return { contributions, tags: (raw && raw[MERGED_TAGS]) || {} };
}

/** Reconstruct the raw contributions JSON from a node object (accepts the exposed
 * `contributions`+`tags` shape or a legacy raw `facets` field). */
export function rawFacetsFromNode(node) {
  if (node.facets) return node.facets;
  const raw = { ...(node.contributions || {}) };
  if (node.tags && Object.keys(node.tags).length) raw[MERGED_TAGS] = node.tags;
  return raw;
}

/** Apply a `{ tags, metadata }` contribution onto the raw map and re-merge tags. */
export function applyContribution(raw, contributorId, { tags, metadata } = {}) {
  const next = { ...(raw || {}) };
  const cur = next[contributorId] || {};
  const merged = { ...cur };
  if (tags) merged.tags = { ...(cur.tags || {}), ...tags };
  if (metadata) merged.metadata = { ...(cur.metadata || {}), ...metadata };
  next[contributorId] = merged;
  next[MERGED_TAGS] = mergeContributionTags(next);
  return next;
}

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
  /**
   * Merge a contributor's `{ tags, metadata }` onto a node (namespaced by
   * `contributorId`), and update the merged tag view. Either field is optional.
   */
  async setContribution(id, contributorId, contribution) {
    throw TroveError.unsupported('setContribution not implemented');
  }
  /** Remove a contributor's entire namespace (tags + metadata) from a node. */
  async clearContribution(id, contributorId) {
    throw TroveError.unsupported('clearContribution not implemented');
  }
  /** Simple substring/name search fallback (SearchService may do better). */
  async searchByName(query, opts) {
    throw TroveError.unsupported('searchByName not implemented');
  }
  /**
   * Page through file nodes in a stable id order, for drive-wide sweeps (indexer
   * backfill/purge). `{ afterId, limit }`: return up to `limit` files with id > afterId.
   * @returns {Promise<object[]>}
   */
  async listFiles({ afterId = null, limit = 200 } = {}) {
    throw TroveError.unsupported('listFiles not implemented');
  }
  /**
   * Drive-wide tag/property query. `filters` is a list of
   * `{ key, present } | { key, op, value }` (op ∈ = != < <= > >=), matched against
   * a node's merged `tags` (+ meta). `opts`: { q (name substring), collectionIds,
   * limit }. Returns matching nodes newest-first.
   */
  async findByTags(filters, opts) {
    throw TroveError.unsupported('findByTags not implemented');
  }

  // Deprecated aliases (old "facet" vocabulary) — a facet was arbitrary metadata.
  async setFacet(id, indexerId, data) { return this.setContribution(id, indexerId, { metadata: data }); }
  async clearFacet(id, indexerId) { return this.clearContribution(id, indexerId); }
  async findByFacets(filters, opts) { return this.findByTags(filters, opts); }

  async close() {}
}

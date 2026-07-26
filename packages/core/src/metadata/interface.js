// MetadataStore — the source of truth for every item in the drive. It maps items to
// storage keys (so the blob store never sees a user-visible name), and holds each
// item's *contributions*: what indexers (and the user) attach to it, namespaced by
// contributor id so they never clobber one another and can be removed independently.
//
// THERE IS NO HIERARCHY. A collection is a flat set of uniquely-named items. Structure
// comes from items linking to each other (`trove:` URIs — see ../links.js) and from
// search, not from containers: a markdown document that links its sources does what a
// folder did, except it can say why those things belong together, an item can appear in
// as many of them as it likes, and the grouping is searchable content rather than an
// invisible box. So there is no parentId, no path, and no folder node.
//
// A contributor (an indexer, or the reserved 'user' scope) writes up to three
// things per node: semantic search text (which lives in SearchService, not here),
// `tags` (filterable key/values), and `metadata` (arbitrary — e.g. an audiobook's
// chapter index). This store holds the tags + metadata:
//
//   {
//     id, collectionId, name,
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

// The links indexer's contributor id, and the key it stores outbound `trove:` links
// under. Backlink queries read exactly this, so it lives beside the tag view rather
// than being a string repeated across the stores.
export const LINKS_CONTRIBUTOR = 'core.links';
export const LINKS_KEY = 'links';

/** The outbound trove: links recorded on a node, or []. */
export function outboundLinks(node) {
  const c = node?.contributions?.[LINKS_CONTRIBUTOR]?.metadata?.[LINKS_KEY];
  return Array.isArray(c) ? c : [];
}

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
  /** Prepare storage (schema/migrations); call once at startup. */
  async init() {}

  /** @returns {Promise<object|null>} */
  async getById(id) {
    throw TroveError.unsupported('getById not implemented');
  }
  /**
   * Resolve an item by its name within a collection. Names are unique per collection,
   * which is what lets a `trove:<collection>?name=…` link address exactly one thing.
   * @returns {Promise<object|null>}
   */
  async getByName(collectionId, name) {
    throw TroveError.unsupported('getByName not implemented');
  }
  /**
   * The items in a collection.
   * @param {string} collectionId
   * @param {{sort?: 'name'|'size'|'updatedAt', order?: 'asc'|'desc', limit?: number, cursor?: string}} [opts]
   * @returns {Promise<{items: object[], nextCursor: string|null}>}
   */
  async listItems(collectionId, opts) {
    throw TroveError.unsupported('listItems not implemented');
  }
  /** Insert an item. Rejects ALREADY_EXISTS on a (collectionId,name) collision. */
  async create(node) {
    throw TroveError.unsupported('create not implemented');
  }
  /** Shallow-merge a patch into an item (name changes go through rename). */
  async update(id, patch) {
    throw TroveError.unsupported('update not implemented');
  }
  /** PERMANENTLY delete a single item. The trash lives above this, in the Vfs. */
  async remove(id) {
    throw TroveError.unsupported('remove not implemented');
  }
  /**
   * Move an item to the trash: still stored, no longer part of the drive.
   *
   * Optional — a store that doesn't implement it makes deletes permanent, which is a
   * legitimate choice for an ephemeral or append-only backend. Where it IS implemented,
   * every read path must exclude trashed rows, and name uniqueness must apply only to
   * live ones; otherwise deleting `notes.md` would prevent ever creating another.
   */
  async softDelete(id, at) {
    throw TroveError.unsupported('softDelete not implemented');
  }
  /**
   * Bring a trashed item back, optionally under a different name. The rename is part of
   * the restore rather than a separate step, so a name freed for a replacement can be
   * resolved without a window where the item is live under a colliding name.
   * Rejects ALREADY_EXISTS if the name is taken.
   */
  async restore(id, newName) {
    throw TroveError.unsupported('restore not implemented');
  }
  /** Trashed items, newest first. @returns {Promise<object[]>} */
  async listTrash(collectionId, opts) {
    throw TroveError.unsupported('listTrash not implemented');
  }
  /** Trashed before `cutoff` — what the retention sweep collects. */
  async trashedBefore(cutoff, limit) {
    throw TroveError.unsupported('trashedBefore not implemented');
  }
  /** Rename an item. Rejects ALREADY_EXISTS if the name is taken in its collection. */
  async rename(id, newName) {
    throw TroveError.unsupported('rename not implemented');
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
   * Page through EVERY item across all collections in stable id order, for drive-wide
   * sweeps (indexer backfill/purge). Distinct from listItems, which is one collection's
   * contents for a reader: this one ignores collections and ordering preferences, and
   * exists so a sweep can resume from `afterId` without holding the drive in memory.
   * @returns {Promise<object[]>}
   */
  async scanItems({ afterId = null, limit = 200 } = {}) {
    throw TroveError.unsupported('scanItems not implemented');
  }
  /**
   * How many items the drive holds, across all collections. Optional: it exists so a
   * drive-wide sweep can show real progress ("142 of 3,100") instead of a spinner. A
   * store that can't answer cheaply should return null rather than guess — the caller
   * falls back to an indeterminate indicator, which is honest.
   * @returns {Promise<number|null>}
   */
  async countItems(collectionId) {
    return null;
  }
  /**
   * How many items a collection holds and how many bytes they occupy.
   *
   * Separate from `listItems` because a page is not a drive: a client that reports the
   * length of the page it received tells the user their 3,000-file drive holds 500
   * files, which is not a rounding error but a wrong number. Optional; a store that
   * can't answer returns null and the UI says nothing rather than guessing.
   * @returns {Promise<{items: number, bytes: number}|null>}
   */
  async collectionStats(collectionId) {
    return null;
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
  /**
   * Items that link TO any of `uris` — the backlinks of an item, and the reason a
   * flat drive stays navigable: without them you can follow a document's links out
   * but never discover what gathers a given item up.
   *
   * `uris` are canonical `trove:` URIs (an item is addressable by name AND by id, so
   * the caller passes both forms). Matched against the links contribution written by
   * the links indexer.
   * @param {string[]} uris
   * @param {{limit?: number, collectionIds?: string[]}} [opts]
   */
  async findLinksTo(uris, opts) {
    throw TroveError.unsupported('findLinksTo not implemented');
  }

  async close() {}
}

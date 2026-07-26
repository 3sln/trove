// Vfs — the façade the server talks to. It binds storage blobs, item metadata,
// search, and sidecars into user-level operations, and is collection-aware: every item
// belongs to a collection, and its bytes live in that collection's backing store. When
// a CollectionService is provided, storage is resolved per collection (so different
// collections can sit on different buckets/prefixes/filesystems); without one, a single
// storage backend serves the lone 'default' collection (the library/zero-config path).
// Nothing here is HTTP-aware.
//
// A collection is FLAT: a set of uniquely-named items, no folders and no paths.
// Grouping comes from items linking to each other with `trove:` URIs (see links.js)
// and from search. An item is addressed by id, or by `?name=` within its collection.

import { TroveError } from './errors.js';
import { UploadManager } from './uploads.js';
import { IndexerRegistry } from './indexers/registry.js';
import { ParsingSearchTransformer, matchTagFilters } from './search/transformer.js';
import { extname } from './util.js';
import { IndexingCoordinator } from './indexing.js';
import { parseTroveUri, troveUrisFor } from './links.js';

const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4', '.opus': 'audio/opus', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip',
};

export class Vfs {
  constructor({ storage, metadata, search, indexers, sidecar, collections, searchTransformer, maxIndexBytes = 2 * 1024 * 1024, maxUploadBytes = null }) {
    if (!storage && !collections) throw TroveError.invalid('Vfs requires a storage backend or a CollectionService');
    if (!metadata) throw TroveError.invalid('Vfs requires a metadata store');
    this.storage = storage; // primary backend (default collection + capability reporting)
    this.metadata = metadata;
    this.search = search ?? null;
    // Turns a raw user query into { semanticText, tagFilters } we actually dispatch.
    this.searchTransformer = searchTransformer ?? new ParsingSearchTransformer();
    this.sidecar = sidecar ?? null;
    this.collections = collections ?? null;
    this.indexers = indexers ?? new IndexerRegistry();
    // One UploadManager; it resolves the right backend per session's collection.
    this.uploads = new UploadManager({ storageFor: (cid) => this.storageFor(cid), maxBytes: maxUploadBytes });
    this.maxIndexBytes = maxIndexBytes;
    // The indexing subsystem (run/backfill/purge/contributions) lives here.
    this.indexing = new IndexingCoordinator({
      metadata: this.metadata, search: this.search, indexers: this.indexers,
      storageFor: (cid) => this.storageFor(cid), maxIndexBytes,
    });
  }

  async init() {
    await this.metadata.init();
    if (this.collections) await this.collections.init();
  }

  /** Resolve the storage backend for a collection. */
  async storageFor(collectionId = 'default') {
    if (this.collections) return this.collections.storageFor(collectionId);
    return this.storage;
  }

  guessContentType(name) {
    return CONTENT_TYPES[extname(name)] || 'application/octet-stream';
  }

  // --- reads -----------------------------------------------------------------

  /**
   * Resolve a reference to an item: an id, a `trove:` URI, or a bare name within
   * `collectionId`. These are the only three ways to name something now — there are
   * no paths to walk.
   */
  async resolve(ref, collectionId = 'default') {
    const node = await this.find(ref, collectionId);
    if (!node) throw TroveError.notFound('Item');
    return node;
  }

  /** Like resolve(), but returns null instead of throwing — for link resolution,
   *  where "no such item" is a broken link to render, not an error. */
  async find(ref, collectionId = 'default') {
    if (!ref) return null;
    const link = parseTroveUri(ref);
    if (link) {
      return link.by === 'id'
        ? this.metadata.getById(link.value)
        : this.metadata.getByName(link.collection, link.value);
    }
    return (await this.metadata.getById(ref)) || this.metadata.getByName(collectionId, ref);
  }

  /** The items in a collection. */
  async list(collectionId = 'default', opts = {}) {
    return this.metadata.listItems(collectionId, opts);
  }

  async stat(ref, collectionId) {
    return this.resolve(ref, collectionId);
  }

  /** Items whose content links to this one — see MetadataStore.findLinksTo. */
  async backlinks(id, opts = {}) {
    const node = await this.resolve(id);
    return this.metadata.findLinksTo(troveUrisFor(node), opts);
  }

  // --- mutations -------------------------------------------------------------

  async writeFile(name, body, { contentType, signal, collectionId = 'default' } = {}) {
    const storageKey = `obj_${cryptoId()}`;
    const ct = contentType || this.guessContentType(name);
    const storage = await this.storageFor(collectionId);
    const info = await storage.put(storageKey, body, { contentType: ct, signal });
    const node = await this.#upsertItem({ collectionId, name, storageKey, size: info.size, contentType: ct, etag: info.etag });
    // Small server-side writes index synchronously (search is ready on return);
    // large client uploads (completeUpload) index in the background instead.
    await this.indexing.indexNode(node).catch((e) => console.error('index error', e));
    return node;
  }

  /**
   * Attach freshly-written bytes to an item.
   *
   * `overwrite` decides what happens when the name is already taken. A direct
   * `writeFile` replaces (the caller named an item and handed over its new contents),
   * but an upload must not: two uploads of the same name can be negotiated before
   * either completes — both are told the name is free, because neither item exists yet
   * — and an unconditional replace at completion silently destroys whichever landed
   * first. So an upload re-resolves the collision at the moment it commits.
   */
  async #upsertItem({ collectionId, name, storageKey, size, contentType, etag, overwrite = true }) {
    let finalName = name;
    const existing = await this.metadata.getByName(collectionId, name);
    if (existing && overwrite) {
      const oldKey = existing.storageKey;
      const updated = await this.metadata.update(existing.id, { storageKey, size, contentType, etag });
      if (oldKey && oldKey !== storageKey) (await this.storageFor(collectionId)).delete(oldKey).catch(() => {});
      return updated;
    }
    if (existing) finalName = await this.#uniqueName(collectionId, name);
    return this.metadata.create({ collectionId, name: finalName, storageKey, size, contentType, etag });
  }

  /**
   * Rename an item. Inbound `trove:?name=` links break — that is the accepted cost of
   * links people can write by hand, and it's visible (they render as broken) rather
   * than silently retargeting at whatever later takes the name.
   */
  async rename(id, newName) {
    const node = await this.resolve(id);
    return this.metadata.rename(node.id, newName);
  }

  async remove(id) {
    const node = await this.resolve(id);
    if (node.storageKey) (await this.storageFor(node.collectionId)).delete(node.storageKey).catch(() => {});
    await this.search?.removeNode(node.id);
    await this.sidecar?.remove(node.id).catch(() => {});
    await this.metadata.remove(node.id);
    return { ok: true };
  }

  // --- download --------------------------------------------------------------

  async getDownload(id, { expiresIn, download } = {}) {
    const node = await this.resolve(id);
    const storage = await this.storageFor(node.collectionId);
    if (storage.capabilities.presignDownload) {
      const url = await storage.presignGet(node.storageKey, {
        expiresIn, responseContentType: node.contentType,
        downloadName: download ? node.name : undefined,
      });
      return { mode: 'redirect', url, node };
    }
    return { mode: 'proxy', node };
  }

  async readStream(id, { range, signal } = {}) {
    const node = await this.resolve(id);
    if (!node.storageKey) throw TroveError.notFound('File content');
    return (await this.storageFor(node.collectionId)).get(node.storageKey, { range, signal });
  }

  // --- uploads ---------------------------------------------------------------

  async createUpload(req) {
    const collectionId = req.collectionId || 'default';
    // Never silently overwrite an existing same-named item (data loss). Disambiguate
    // to "name (1).ext" so the drop is non-destructive; the client tells the user the
    // final name differs. `overwrite:true` opts back into replacing in place.
    const name = req.overwrite ? req.name : await this.#uniqueName(collectionId, req.name);
    return this.uploads.create({
      ...req, name, collectionId,
      contentType: req.contentType || this.guessContentType(req.name),
    });
  }

  /** A name that isn't taken in the collection, appending " (n)" before the extension. */
  async #uniqueName(collectionId, name) {
    const taken = async (n) => !!(await this.metadata.getByName(collectionId, n));
    if (!(await taken(name))) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await taken(candidate))) return candidate;
    }
    return `${stem} (${Date.now()})${ext}`;
  }
  signUploadPart(uploadId, partNumber) {
    return this.uploads.signPart(uploadId, partNumber);
  }
  reportUploadPart(uploadId, partNumber, etag) {
    return this.uploads.reportPart(uploadId, partNumber, etag);
  }
  uploadPart(uploadId, partNumber, body, opts) {
    return this.uploads.uploadPart(uploadId, partNumber, body, opts);
  }
  uploadStatus(uploadId) {
    return this.uploads.status(uploadId);
  }
  abortUpload(uploadId) {
    return this.uploads.abort(uploadId);
  }

  async completeUpload(uploadId, parts) {
    const obj = await this.uploads.complete(uploadId, parts);
    // The bytes are now committed to storage. If we can't attach them to an item
    // (collection gone, name taken), delete the object so it doesn't leak.
    try {
      const node = await this.#upsertItem({
        collectionId: obj.collectionId, name: obj.name, storageKey: obj.storageKey,
        size: obj.size, contentType: obj.contentType, etag: obj.etag,
        overwrite: obj.overwrite,
      });
      this.indexing.indexNode(node).catch((e) => console.error('index error', e));
      return node;
    } catch (err) {
      await (await this.storageFor(obj.collectionId)).delete(obj.storageKey).catch(() => {});
      throw err;
    }
  }

  // --- user tags (sidecar CRDT + queryable mirror) ---------------------------
  // A user tag lives in the sidecar (a CRDT, so concurrent edits merge) AND is
  // mirrored into the queryable `user` contribution so `#tag` filters find it. Both
  // sides are the façade's job — keeping the invariant here means no caller (route or
  // otherwise) can set one without the other, and a mirror failure is no longer
  // silently swallowed (the tag would be set but unfilterable).

  async setTag(nodeId, name, value, principal) {
    if (!this.sidecar) throw TroveError.unsupported('Conversations are not enabled');
    const res = await this.sidecar.setTag(nodeId, name, value, principal);
    await this.metadata.setContribution(nodeId, 'user', { tags: { [name]: value ?? true } });
    return res;
  }
  async removeTag(nodeId, name, principal) {
    if (!this.sidecar) throw TroveError.unsupported('Conversations are not enabled');
    const res = await this.sidecar.removeTag(nodeId, name, principal);
    await this.metadata.setContribution(nodeId, 'user', { tags: { [name]: null } });
    return res;
  }
  /** Drive-wide tag/property query (delegates to the metadata store). */
  findByTags(filters, opts) {
    return this.metadata.findByTags(filters, opts);
  }

  // --- search & indexing -----------------------------------------------------

  /**
   * Run a raw user query: transform it into { semanticText, tagFilters } (default =
   * parse `#tag` syntax; a plugged-in transformer may use an LLM), dispatch semantic
   * search narrowed by the tag filters (or a pure tag filter when there's no text),
   * and return the results together with the `resolved` query the client can show.
   */
  async query(rawQuery, opts = {}) {
    let resolved;
    try {
      resolved = await this.searchTransformer.transform(rawQuery, { tagKeys: opts.tagKeys });
    } catch {
      resolved = { semanticText: rawQuery, tagFilters: [], source: 'parse', note: 'transform-failed' };
    }
    const { semanticText, tagFilters = [] } = resolved;
    let results;
    if (semanticText && semanticText.trim()) {
      results = await this.searchQuery(semanticText, opts);
      if (tagFilters.length) results = results.filter((r) => matchTagFilters(r.node, tagFilters));
    } else if (tagFilters.length) {
      const nodes = await this.metadata.findByTags(tagFilters, { collectionIds: opts.collectionIds, limit: opts.limit });
      results = nodes.map((node) => ({ nodeId: node.id, score: 1, node, snippet: null }));
    } else {
      results = [];
    }
    return { results, resolved };
  }

  async searchQuery(query, opts = {}) {
    if (!this.search) {
      const items = await this.metadata.searchByName(query, opts);
      return items.map((n) => ({ nodeId: n.id, score: 1, node: n, snippet: null }));
    }
    const results = await this.search.search(query, opts);
    const out = [];
    for (const r of results) {
      const node = await this.metadata.getById(r.nodeId);
      if (!node) continue;
      // Scope to the requested collections (permission-filtered by the server).
      if (opts.collectionIds && !opts.collectionIds.includes(node.collectionId)) continue;
      out.push({ ...r, node });
    }
    return out;
  }

  // Indexing lives in IndexingCoordinator (this.indexing); these thin delegations keep
  // the historical Vfs surface for existing callers.
  indexContributions(nodeId, contributorId, contribution) { return this.indexing.indexContributions(nodeId, contributorId, contribution); }
  removeContributions(nodeId, contributorId) { return this.indexing.removeContributions(nodeId, contributorId); }
  backfillIndexer(indexer, opts) { return this.indexing.backfillIndexer(indexer, opts); }
  purgeIndexer(contributorId, opts) { return this.indexing.purgeIndexer(contributorId, opts); }
  reindexAll(opts) { return this.indexing.reindexAll(opts); }
}

function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '');
}

export { CONTENT_TYPES };

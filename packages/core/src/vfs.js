// Vfs — the façade the server talks to. It binds storage blobs, the metadata
// tree, search, and sidecars into user-level operations, and is collection-aware:
// every node belongs to a collection, and its bytes live in that collection's
// backing store. When a CollectionService is provided, storage is resolved per
// collection (so different collections can sit on different buckets/prefixes/
// filesystems); without one, a single storage backend serves the lone 'default'
// collection (the library/zero-config path). Nothing here is HTTP-aware.

import { TroveError } from './errors.js';
import { UploadManager } from './uploads.js';
import { IndexerRegistry, textIndexer } from './indexers/registry.js';
import { ParsingSearchTransformer, matchTagFilters } from './search/transformer.js';
import { basename, parentPath, extname, readAll } from './util.js';
import { ROOT_ID, rootId } from './metadata/memory.js';

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
    if (!this.indexers.indexers.size) this.indexers.register(textIndexer);
    // One UploadManager; it resolves the right backend per session's collection.
    this.uploads = new UploadManager({ storageFor: (cid) => this.storageFor(cid), maxBytes: maxUploadBytes });
    this.maxIndexBytes = maxIndexBytes;
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

  /** Resolve a path (needs collectionId) or a globally-unique id to a node. */
  async resolve(pathOrId, collectionId = 'default') {
    // The collection root is created on first access (a new collection has no
    // tree yet), so `/` always resolves.
    if (pathOrId === '/' || pathOrId === '') return this.rootNode(collectionId);
    const node = pathOrId.startsWith('/')
      ? await this.metadata.getByPath(collectionId, pathOrId)
      : await this.metadata.getById(pathOrId);
    if (!node) throw TroveError.notFound('File or folder');
    return node;
  }

  /** The root node of a collection (created on first use). */
  async rootNode(collectionId = 'default') {
    if (this.metadata.ensureRoot) return this.metadata.ensureRoot(collectionId);
    return this.metadata.getById(rootId(collectionId));
  }

  async list(pathOrId, opts = {}) {
    const node = await this.resolve(pathOrId, opts.collectionId);
    if (node.kind !== 'folder') throw TroveError.invalid('Not a folder');
    return this.metadata.listChildren(node.id, opts);
  }

  async stat(pathOrId, collectionId) {
    return this.resolve(pathOrId, collectionId);
  }

  async breadcrumb(id) {
    const trail = [];
    let cur = await this.metadata.getById(id);
    while (cur) {
      trail.unshift({ id: cur.id, name: cur.name, path: cur.path });
      cur = cur.parentId ? await this.metadata.getById(cur.parentId) : null;
    }
    return trail;
  }

  // --- mutations -------------------------------------------------------------

  async mkdir(parentId, name, collectionId) {
    const parent = await this.resolve(parentId, collectionId);
    return this.metadata.create({ parentId: parent.id, name, kind: 'folder' });
  }

  async writeFile(parentId, name, body, { contentType, signal, collectionId } = {}) {
    const parent = await this.resolve(parentId, collectionId);
    const cid = parent.collectionId;
    const storageKey = `obj_${cryptoId()}`;
    const ct = contentType || this.guessContentType(name);
    const storage = await this.storageFor(cid);
    const info = await storage.put(storageKey, body, { contentType: ct, signal });
    const node = await this.#upsertFileNode({ parent, name, storageKey, size: info.size, contentType: ct, etag: info.etag });
    // Small server-side writes index synchronously (search is ready on return);
    // large client uploads (completeUpload) index in the background instead.
    await this.#indexNode(node).catch((e) => console.error('index error', e));
    return node;
  }

  async #upsertFileNode({ parent, name, storageKey, size, contentType, etag }) {
    const cid = parent.collectionId;
    const existing = await this.metadata.getByPath(cid, pathOf(parent, name));
    if (existing && existing.kind === 'file') {
      const oldKey = existing.storageKey;
      const updated = await this.metadata.update(existing.id, { storageKey, size, contentType, etag });
      if (oldKey && oldKey !== storageKey) (await this.storageFor(cid)).delete(oldKey).catch(() => {});
      return updated;
    }
    if (existing) throw TroveError.alreadyExists(name);
    return this.metadata.create({ parentId: parent.id, name, kind: 'file', storageKey, size, contentType, etag });
  }

  async move(id, destParentId, newName) {
    const node = await this.resolve(id);
    if (node.parentId === null) throw TroveError.invalid('Cannot move a collection root');
    return this.metadata.move(node.id, destParentId, newName);
  }

  async rename(id, newName) {
    const node = await this.resolve(id);
    return this.metadata.move(node.id, node.parentId, newName);
  }

  async remove(id, { recursive = true } = {}) {
    const node = await this.resolve(id);
    if (node.parentId === null) throw TroveError.invalid('Cannot delete a collection root');
    if (node.kind === 'folder') {
      const kids = await this.metadata.descendants(node.id);
      if (kids.length && !recursive) throw TroveError.invalid('Folder is not empty');
      for (const child of kids) {
        if (child.kind === 'file' && child.storageKey) {
          (await this.storageFor(child.collectionId)).delete(child.storageKey).catch(() => {});
        }
        await this.search?.removeNode(child.id);
        await this.sidecar?.remove(child.id).catch(() => {});
        await this.metadata.remove(child.id);
      }
    } else if (node.storageKey) {
      (await this.storageFor(node.collectionId)).delete(node.storageKey).catch(() => {});
    }
    await this.search?.removeNode(node.id);
    await this.sidecar?.remove(node.id).catch(() => {});
    await this.metadata.remove(node.id);
    return { ok: true };
  }

  // --- download --------------------------------------------------------------

  async getDownload(id, { expiresIn, download } = {}) {
    const node = await this.resolve(id);
    if (node.kind !== 'file') throw TroveError.invalid('Not a file');
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
    if (node.kind !== 'file') throw TroveError.invalid('Not a file');
    if (!node.storageKey) throw TroveError.notFound('File content');
    return (await this.storageFor(node.collectionId)).get(node.storageKey, { range, signal });
  }

  // --- uploads ---------------------------------------------------------------

  async createUpload(req) {
    const parent = await this.resolve(req.parentId, req.collectionId);
    // Never silently overwrite an existing same-named file (data loss). Disambiguate
    // to "name (1).ext" so the drop is non-destructive; the client tells the user the
    // final name differs. `overwrite:true` opts back into replacing in place.
    const name = req.overwrite ? req.name : await this.#uniqueChildName(parent, req.name);
    return this.uploads.create({
      ...req, name, parentId: parent.id, collectionId: parent.collectionId,
      contentType: req.contentType || this.guessContentType(req.name),
    });
  }

  /** A child name that doesn't collide, appending " (n)" before the extension. */
  async #uniqueChildName(parent, name) {
    const cid = parent.collectionId;
    const taken = async (n) => !!(await this.metadata.getByPath(cid, pathOf(parent, n)));
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
    // The bytes are now committed to storage. If we can't attach them to a node (parent
    // deleted mid-upload, name collision), delete the object so it doesn't leak.
    try {
      const parent = await this.metadata.getById(obj.parentId);
      if (!parent) throw TroveError.notFound('Parent folder');
      const node = await this.#upsertFileNode({ parent, name: obj.name, storageKey: obj.storageKey, size: obj.size, contentType: obj.contentType, etag: obj.etag });
      this.#indexNode(node).catch((e) => console.error('index error', e));
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

  /**
   * Apply one contributor's indexed contribution to a node. A contribution has up
   * to three scopes: `semanticTexts` (→ search index), `tags` (filterable), and
   * `metadata` (arbitrary, e.g. a chapter index). Each contributor is namespaced,
   * so its contribution replaces only its own and can be removed independently.
   * The legacy `{ documents, facet }` shape is accepted (documents→semanticTexts,
   * facet→metadata).
   */
  async indexContributions(nodeId, contributorId, contribution) {
    const node = await this.metadata.getById(nodeId);
    if (!node) throw TroveError.notFound('Node');
    await this.#applyContribution(nodeId, contributorId, contribution);
    return { ok: true };
  }

  /** @deprecated positional form kept for existing callers; use indexContributions. */
  async indexDocuments(nodeId, indexerId, documents, facet) {
    return this.indexContributions(nodeId, indexerId, { documents, facet });
  }

  async #applyContribution(nodeId, contributorId, contribution) {
    const { semanticTexts, tags, metadata } = normalizeContribution(contribution);
    if (this.search && semanticTexts.length) await this.search.indexDocuments(nodeId, contributorId, semanticTexts);
    // Indexer contributions live in the queryable metadata store (not the sidecar),
    // so they show up in list/stat and drive tag filtering.
    if (tags || metadata) await this.metadata.setContribution(nodeId, contributorId, { tags, metadata });
  }

  /** Remove everything a contributor added to a node (search + tags + metadata). */
  async removeContributions(nodeId, contributorId) {
    // Re-indexing with no docs clears this (node, contributor)'s vectors + keywords.
    if (this.search) await this.search.indexDocuments(nodeId, contributorId, []).catch(() => {});
    await this.metadata.clearContribution(nodeId, contributorId);
  }

  async #indexNode(node) {
    if (node.kind !== 'file') return;
    if (this.search) await this.search.indexName(node);
    const matching = this.indexers.matching(node);
    if (!matching.length) return;
    const storage = await this.storageFor(node.collectionId);
    const ctx = this.#indexCtx(node, storage);
    for (const indexer of matching) await this.#runOneIndexer(indexer, node, ctx);
  }

  /** Build the context an indexer gets: capped reads + a time-limited read URL. */
  #indexCtx(node, storage) {
    const readRange = () => storage.get(node.storageKey, { range: { start: 0, end: this.maxIndexBytes - 1 } });
    return {
      node: { id: node.id, name: node.name, path: node.path, size: node.size, contentType: node.contentType },
      maxBytes: this.maxIndexBytes,
      readBytes: async () => readAll((await readRange()).stream),
      readText: async () => new TextDecoder().decode(await readAll((await readRange()).stream)),
      // A time-limited URL a remote/isolated indexer can fetch the bytes from. S3-class
      // backends presign directly; otherwise it's unsupported here (a self-managed,
      // token-scoped server URL is a follow-up — see the design doc).
      presignRead: async ({ expiresIn = 300 } = {}) => {
        if (!storage.capabilities?.presignDownload) {
          throw TroveError.unsupported('This collection cannot presign reads for indexers');
        }
        return storage.presignGet(node.storageKey, { expiresIn, responseContentType: node.contentType });
      },
    };
  }

  /** Run a single indexer against a node and apply (or clear) its contribution. */
  async #runOneIndexer(indexer, node, ctx) {
    try {
      const contribution = await indexer.index(node, ctx ?? this.#indexCtx(node, await this.storageFor(node.collectionId)));
      await this.#applyContribution(node.id, indexer.id, contribution);
    } catch (err) {
      console.error(`indexer ${indexer.id} failed on ${node.path}:`, err.message);
    }
  }

  /**
   * Re-run one indexer over every file it matches (e.g. right after an indexer is
   * installed/enabled). Walks the metadata store in pages so a large drive doesn't
   * load at once. Returns how many nodes it contributed to.
   */
  async backfillIndexer(indexer, { limit = Infinity, pageSize = 200 } = {}) {
    let done = 0;
    let afterId = null;
    while (done < limit) {
      const files = await this.metadata.listFiles({ afterId, limit: Math.min(pageSize, limit - done) });
      if (!files.length) break;
      for (const node of files) {
        afterId = node.id;
        let matches = false;
        try { matches = indexer.match(node); } catch { matches = false; }
        if (!matches) continue;
        await this.#runOneIndexer(indexer, node);
        done++;
        if (done >= limit) break;
      }
      if (files.length < pageSize) break;
    }
    return { indexed: done };
  }

  /**
   * Remove one contributor's contributions from every node (e.g. on uninstall).
   * Scans in pages; returns how many nodes were cleared.
   */
  async purgeIndexer(contributorId, { pageSize = 500 } = {}) {
    let cleared = 0;
    let afterId = null;
    for (;;) {
      const files = await this.metadata.listFiles({ afterId, limit: pageSize });
      if (!files.length) break;
      for (const node of files) {
        afterId = node.id;
        if (node.contributions && node.contributions[contributorId]) {
          await this.removeContributions(node.id, contributorId);
          cleared++;
        }
      }
      if (files.length < pageSize) break;
    }
    return { cleared };
  }
}

function pathOf(parent, name) {
  return parent.path === '/' ? `/${name}` : `${parent.path}/${name}`;
}

// Normalize an indexer/plugin contribution to the three canonical scopes, accepting
// the legacy `{ documents, facet }` shape (documents→semanticTexts, facet→metadata).
function normalizeContribution(c = {}) {
  return {
    semanticTexts: c.semanticTexts || c.documents || [],
    tags: c.tags || null,
    metadata: c.metadata || c.facet || null,
  };
}
function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '');
}

export { CONTENT_TYPES };

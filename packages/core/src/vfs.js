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

import { TroveError, isOutOfSpace } from './errors.js';
import { UploadManager } from './uploads.js';
import { IndexerRegistry } from './indexers/registry.js';
import { ParsingSearchTransformer, matchTagFilters } from './search/transformer.js';
import { extname } from './util.js';
import { IndexingCoordinator } from './indexing.js';
import { parseTroveUri, troveUrisFor } from './links.js';
import { CollectionScanner } from './scan.js';

const CONTENT_TYPES = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4', '.opus': 'audio/opus', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip',
};

export class Vfs {
  constructor({ storage, metadata, search, indexers, sidecar, collections, searchTransformer, issues, maxIndexBytes = 2 * 1024 * 1024, maxUploadBytes = null, uploadPartSize = undefined }) {
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
    this.uploads = new UploadManager({ storageFor: (cid) => this.storageFor(cid), maxBytes: maxUploadBytes, partSize: uploadPartSize });
    this.maxIndexBytes = maxIndexBytes;
    // The indexing subsystem (run/backfill/purge/contributions) lives here.
    // Where a failure to index becomes a standing, retryable problem rather than a
    // console line. Optional — core works without one, it just can't report.
    this.issues = issues ?? null;
    this.indexing = new IndexingCoordinator({
      metadata: this.metadata, search: this.search, indexers: this.indexers,
      storageFor: (cid) => this.storageFor(cid), maxIndexBytes, issues: this.issues,
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

  /**
   * How much room a collection's store has left, or null when it can't say.
   *
   * Also the place a full disk becomes a STANDING problem rather than one failed
   * upload: running out of space is not a transient blip, it is a condition that will
   * break every write until someone acts, and the person who needs to know may not be
   * the one whose upload failed.
   */
  async storageUsage(collectionId = 'default') {
    const storage = await this.storageFor(collectionId);
    if (!storage.capabilities?.usage) return null;
    const usage = await storage.usage().catch(() => null);
    if (usage) await this.#reportSpace(collectionId, usage);
    return usage;
  }

  /** Raise or clear the "running out of room" issue for a collection. */
  async #reportSpace(collectionId, usage) {
    if (!this.issues || !usage?.total) return;
    const freeRatio = usage.available / usage.total;
    const kind = 'storage-space';
    try {
      // Two thresholds, because "nearly full" and "full" need different words. Warning
      // early is the whole point — by the time writes fail it is too late to be useful.
      if (usage.available <= 0) {
        await this.issues.raise({
          kind, subject: collectionId, collectionId,
          title: `“${collectionId}” has run out of storage — uploads will fail`,
          detail: `${fmtBytes(usage.used)} used of ${fmtBytes(usage.total)}. Free some space or add capacity.`,
        });
      } else if (freeRatio < 0.05) {
        await this.issues.raise({
          kind, subject: collectionId, collectionId, severity: 'warning',
          title: `“${collectionId}” is nearly out of storage — ${fmtBytes(usage.available)} left`,
          detail: `${fmtBytes(usage.used)} used of ${fmtBytes(usage.total)} (${Math.round(freeRatio * 100)}% free).`,
        });
      } else {
        await this.issues.clear(kind, collectionId);
      }
    } catch (err) {
      console.error('could not record a storage-space issue:', err.message);
    }
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
    // Trashed items are not part of the drive: a deleted file must not answer a link, a
    // name, or a download-by-id just because someone kept the id. The trash reaches them
    // through listTrash/restore, which go to the metadata store directly.
    const node = await this.#findAny(ref, collectionId);
    return node && !node.deletedAt ? node : null;
  }

  /** Resolve a reference INCLUDING trashed items — for restore and permanent delete. */
  async #findAny(ref, collectionId = 'default') {
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
    let info;
    try {
      info = await storage.put(storageKey, body, { contentType: ct, signal });
    } catch (err) {
      // A write that failed for lack of room is a standing condition, not one bad
      // request: the next upload will fail the same way. Record it so it is visible
      // before someone else hits it, then let the original error surface unchanged.
      if (isOutOfSpace(err)) await this.storageUsage(collectionId).catch(() => {});
      throw err;
    }
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
    const renamed = await this.metadata.rename(node.id, newName);
    // The name is INDEXED (it's how "find the file I called X" works), so a rename that
    // doesn't re-index leaves the item findable only under a name it no longer has —
    // which, in a drive with no folders, is the item disappearing. Awaited: renaming is
    // a small, interactive operation, and it would be strange for the result to be
    // stale by the time the rename returns.
    await this.indexing.reindexName(renamed).catch((e) => console.error('reindex after rename failed', e));
    return renamed;
  }

  /**
   * Delete an item.
   *
   * By default this moves it to the TRASH: the bytes stay exactly where they are and
   * the record keeps its id, but the item leaves the drive — gone from listings, from
   * search, from name lookups, from backlinks. A misclick on a file you cannot get back
   * is the worst thing a drive can do, and "are you sure?" is not a safety net, it is a
   * dialog people click through.
   *
   * `permanent: true` is the old behaviour, and it is what the retention sweep and an
   * explicit "delete forever" use. A store with no trash (softDelete unimplemented)
   * falls back to it — better a permanent delete than a delete that silently doesn't
   * happen.
   *
   * @param {string} id
   * @param {{permanent?: boolean}} [opts]
   */
  async remove(id, { permanent = false } = {}) {
    // #findAny, not resolve: emptying the trash deletes items that are already out of
    // the drive, and resolve() correctly refuses to see those.
    const node = await this.#findAny(id);
    if (!node) throw TroveError.notFound('Item');
    if (!permanent && this.metadata.softDelete) {
      const trashed = await this.metadata.softDelete(node.id).catch((err) => {
        if (err?.code !== 'unsupported') throw err;
        return null;
      });
      if (trashed) {
        // Out of the index, but NOT out of storage. Everything here is derived and is
        // rebuilt on restore; the bytes are the one thing that can't be.
        //
        // The soft delete has already committed, so a failure here must not undo it or
        // throw the whole call away — the item IS in the trash. A stale index entry is
        // caught by searchQuery, which skips trashed nodes precisely because this can
        // fail. Noted AFTER the clear below, under its own kind: `index` means "this
        // item failed to index", which is meaningless once it's deleted and is cleared
        // on the next line — raising into that kind would erase the note immediately.
        const err = await this.#tryRemoveFromIndex(node.id);
        await this.issues?.clear('index', node.id).catch(() => {});
        if (err) await this.#note('search-cleanup', node.id, 'Removing a trashed item from the search index failed', err);
        return { ok: true, trashed: true, id: node.id };
      }
    }
    // ORDER MATTERS, and it is the opposite of the obvious one. Losing the record while
    // the bytes survive is an orphan blob: wasted space nobody sees. Losing the bytes
    // while the record survives is an item that lists, opens, and 404s forever — with no
    // way back. So everything derived goes first, the authoritative record next, and the
    // bytes last, where a failure is a leak instead of a corpse.
    const searchErr = await this.#tryRemoveFromIndex(node.id);
    await this.sidecar?.remove(node.id).catch(() => {});
    // A deleted item can't be "failing to index" any more — leaving the issue behind
    // would leave an un-fixable row pointing at nothing. This clear is also why the
    // failure above is noted under a different kind, and only once this has run.
    await this.issues?.clear('index', node.id).catch(() => {});
    if (searchErr) await this.#note('search-cleanup', node.id, 'Removing a deleted item from the search index failed', searchErr);
    await this.metadata.remove(node.id);
    if (node.storageKey) {
      // The catch has to cover BOTH calls. Guarding only `delete()` meant a failure in
      // `storageFor` — a collection record that has gone — rejected `remove()` AFTER the
      // metadata row was already gone, so the caller saw an error for a delete that had
      // in fact succeeded, and the orphan-bytes issue that exists for exactly this case
      // never fired.
      await (async () => {
        const storage = await this.storageFor(node.collectionId);
        return storage.delete(node.storageKey);
      })().catch((err) => this.#note(
        'orphan-bytes', node.storageKey,
        `Deleted "${node.name}" but its stored bytes could not be removed`, err));
    }
    return { ok: true, trashed: false, id: node.id };
  }

  /** Drop a node from the search index, returning the error instead of throwing it. */
  async #tryRemoveFromIndex(nodeId) {
    try {
      await this.search?.removeNode(nodeId);
      return null;
    } catch (err) {
      return err;
    }
  }

  /** Record a background failure as a standing problem, never throwing from the attempt. */
  async #note(kind, subject, title, err) {
    try {
      await this.issues?.raise({
        kind, subject, severity: 'warning', title,
        detail: err?.message || String(err), retryable: false,
      });
    } catch { /* the issue registry is itself best-effort here */ }
  }

  /** What's in the trash, newest first. */
  async listTrash(collectionId, opts) {
    if (!this.metadata.listTrash) return [];
    return this.metadata.listTrash(collectionId, opts);
  }

  /**
   * Bring a trashed item back, re-indexing it so it is findable again.
   *
   * If its name was taken while it was in the trash, it comes back under a free one
   * rather than failing — someone restoring a file wants the file, and refusing because
   * of a name collision leaves them with no way to get it except to rename the other.
   */
  async restore(id) {
    if (!this.metadata.restore) throw TroveError.unsupported('This drive has no trash');
    const node = await this.metadata.getById(id);
    if (!node) throw TroveError.notFound('Item');
    if (!node.deletedAt) return node; // already live; restoring twice is not an error
    let restored;
    try {
      restored = await this.metadata.restore(id);
    } catch (err) {
      if (err?.code !== 'already_exists') throw err;
      restored = await this.metadata.restore(id, await this.#uniqueName(node.collectionId, node.name));
    }
    await this.indexing.indexNode(restored).catch((e) => console.error('reindex after restore failed', e));
    return restored;
  }

  /**
   * Permanently delete everything trashed before `cutoff`. Returns what it freed.
   *
   * This is the only thing that destroys data on a timer, so it is deliberately narrow:
   * it takes an explicit cutoff rather than reading a policy, and the caller decides.
   */
  async purgeTrash({ before, limit = 500 } = {}) {
    if (!this.metadata.trashedBefore) return { purged: 0, bytes: 0 };
    const doomed = await this.metadata.trashedBefore(before, limit);
    let purged = 0;
    let bytes = 0;
    for (const node of doomed) {
      try {
        await this.remove(node.id, { permanent: true });
        purged++;
        bytes += node.size || 0;
      } catch (err) {
        console.error(`purging ${node.name} failed:`, err.message);
      }
    }
    return { purged, bytes };
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
      // The tag filter goes INSIDE searchQuery's widening loop, not after it. Applied
      // here it ran on an already-truncated page, so `sailing #draft` — one of the
      // examples the transformer itself advertises — returned nothing while `#draft`
      // alone returned the file.
      results = await this.searchQuery(semanticText, {
        ...opts,
        postFilter: tagFilters.length ? (node) => matchTagFilters(node, tagFilters) : null,
      });
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
    const want = opts.limit ?? 20;
    // The index ranks across the WHOLE drive and applies its limit before we get to
    // filter, so every trashed row and every collection this caller can't read still
    // occupies one of the N slots. On a drive where someone else's large collection
    // outranks yours, all N can be rows you can't see — and the answer that comes back
    // is a confident "no matches" for files you can. So widen the ask until there are
    // `want` VISIBLE results, or the index has nothing more to give. It only escalates
    // when filtering actually removed something, so the common case is one query.
    const ceiling = Math.min(Math.max(want, 1) * 16, 500);
    let out = [];
    let lastCount = -1;
    for (let fetch = want; ; fetch = Math.min(fetch * 4, ceiling)) {
      const results = await this.search.search(query, { ...opts, limit: fetch });
      out = [];
      for (const r of results) {
        const node = await this.metadata.getById(r.nodeId);
        if (!node) continue;
        // A trashed item must never surface in search. Deleting removes it from the
        // index, but that removal can fail — and when it does, the alternative to this
        // check is a result the user clicks and gets a 404 for, on a file they
        // deliberately deleted. getById deliberately does NOT filter (restore and purge
        // both need to see it), so the filtering belongs here.
        if (node.deletedAt) continue;
        // Scope to the requested collections (permission-filtered by the server).
        if (opts.collectionIds && !opts.collectionIds.includes(node.collectionId)) continue;
        // Anything else the caller wants excluded — tag filters, for one. It has to be
        // counted against `want` here, or widening chases a target it can never reach.
        if (opts.postFilter && !opts.postFilter(node)) continue;
        out.push({ ...r, node });
      }
      // Enough, or we have widened as far as we are willing to. NOT "the index returned
      // fewer rows than we asked for": `search()` slices `limit` NODES out of `limit*4`
      // DOCUMENTS, so one heavily-chunked file legitimately yields a short list while
      // plenty more matches wait behind it — and reading that as exhaustion stopped the
      // widening early, which is the failure this loop exists to prevent.
      if (out.length >= want || fetch >= ceiling) break;
      // Exhaustion is when widening stopped adding anything.
      if (results.length === lastCount) break;
      lastCount = results.length;
    }
    return out.slice(0, want);
  }

  // Indexing lives in IndexingCoordinator (this.indexing); these thin delegations keep
  // the historical Vfs surface for existing callers.
  indexContributions(nodeId, contributorId, contribution) { return this.indexing.indexContributions(nodeId, contributorId, contribution); }
  removeContributions(nodeId, contributorId) { return this.indexing.removeContributions(nodeId, contributorId); }
  backfillIndexer(indexer, opts) { return this.indexing.backfillIndexer(indexer, opts); }
  purgeIndexer(contributorId, opts) { return this.indexing.purgeIndexer(contributorId, opts); }
  reindexAll(opts) { return this.indexing.reindexAll(opts); }
  reindexNode(nodeId) { return this.indexing.reindexNode(nodeId); }

  /**
   * Reconcile a collection against the bytes actually in its store — what picks up
   * files added, replaced, or removed by anything that isn't Trove. See scan.js.
   */
  scanCollection(collectionId, opts) {
    this._scanner ||= new CollectionScanner({ vfs: this, issues: this.issues });
    return this._scanner.scan(collectionId, opts);
  }
}

function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '');
}

export { CONTENT_TYPES };

/** Bytes in the units a person reads, for messages that name a real quantity. */
function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

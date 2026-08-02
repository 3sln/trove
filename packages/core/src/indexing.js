// IndexingCoordinator — the indexing subsystem, extracted from the Vfs façade. Owns
// the indexer registry, the search index, and the per-file contribution flow:
//   • indexNode(node)          — run every matching indexer on upload/write
//   • indexContributions(...)  — apply one contributor's {semanticTexts, tags, metadata}
//   • removeContributions(...) — clear one contributor from a node
//   • backfillIndexer(...)     — re-run an indexer over the whole drive (on install)
//   • purgeIndexer(...)        — remove an indexer's contributions everywhere (uninstall)
//
// Vfs holds one of these and delegates; it needs only `storageFor` (collection → blob
// backend) injected so this stays free of the tree/path concerns.

import { TroveError } from './errors.js';
import { readAll } from './util.js';
import { clampContribution, DEFAULT_CAPS } from './indexers/contribution.js';

export class IndexingCoordinator {
  /**
   * @param {object} deps
   * @param {import('./metadata/interface.js').MetadataStore} deps.metadata
   * @param {object|null} deps.search  SearchService (or null when search is disabled)
   * @param {import('./indexers/registry.js').IndexerRegistry} deps.indexers
   * @param {(collectionId: string) => Promise<object>} deps.storageFor
   * @param {number} deps.maxIndexBytes
   * @param {object} [deps.caps]  contribution size caps (see indexers/contribution.js)
   * @param {import('./issues.js').IssueRegistry} [deps.issues] where a failure to index
   *   becomes a standing, retryable problem instead of a console line nobody reads
   */
  constructor({ metadata, search, indexers, storageFor, maxIndexBytes, caps, issues, mintUrl = null }) {
    this.metadata = metadata;
    this.search = search ?? null;
    this.indexers = indexers;
    this.storageFor = storageFor;
    this.maxIndexBytes = maxIndexBytes;
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this.issues = issues ?? null;
    // How a time-limited read URL is made. Not this file's business any more — it is one
    // caller of a general primitive (see signedUrls.js), not the owner of a private one.
    this.mintUrl = mintUrl;
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

  /**
   * THE choke point: every contribution reaches storage through here, whether it came
   * from a built-in indexer, a plugin indexer in the isolate, or a sandboxed plugin
   * pushing over the API. So this is where the size caps have to be applied — clamping
   * inside any one producer would leave the other two unbounded, and the API push is
   * the one most exposed to untrusted code.
   */
  async #applyContribution(nodeId, contributorId, contribution) {
    // `clamp` alone. It already maps the legacy `documents`/`facet` keys itself, so
    // `normalize` at this call site can never see one — all it contributed was three
    // defaults, while contribution.js's header says both halves live there because they
    // must not drift. They had already drifted into both functions.
    const { semanticTexts = [], tags = null, metadata = null } = clampContribution(contribution, this.caps);
    // ALWAYS write the search half, including when it is empty. `indexDocuments` clears
    // this (node, contributor)'s prior docs before it writes, so passing [] is how you
    // say "this contributor has nothing to say about this node any more". Skipping the
    // call when the list is empty meant overwriting a document with blank content left
    // its old chunks in the index for good — search kept returning the file, with a
    // snippet of text that was no longer in it.
    if (this.search) await this.search.indexDocuments(nodeId, contributorId, semanticTexts);
    // Indexer contributions live in the queryable metadata store (not the sidecar),
    // so they show up in list/stat and drive tag filtering. Tags MERGE within a
    // contributor's namespace by design (see applyContribution) — but a contribution
    // with no scopes at all is that contributor withdrawing, so its facets go too,
    // rather than leaving an excerpt describing content that no longer exists.
    if (tags || metadata) await this.metadata.setContribution(nodeId, contributorId, { tags, metadata });
    else if (!semanticTexts.length) await this.metadata.clearContribution(nodeId, contributorId);
  }

  /** Clear this contributor's search entries for a node (an empty re-index). */
  async #clearSearch(nodeId, contributorId) {
    if (this.search) await this.search.indexDocuments(nodeId, contributorId, []).catch(() => {});
  }

  /** Remove everything a contributor added to a node (search + tags + metadata). */
  async removeContributions(nodeId, contributorId) {
    // Re-indexing with no docs clears this (node, contributor)'s vectors + keywords.
    await this.#clearSearch(nodeId, contributorId);
    await this.metadata.clearContribution(nodeId, contributorId);
  }

  /**
   * Index a freshly written/uploaded node: its name (for keyword search) + every
   * matching indexer's contribution.
   *
   * Whether this succeeded is recorded, not just logged. An item that fails to index is
   * an item that cannot be found, and in a drive with no folders that is indistinguishable
   * from an item that isn't there — so the failure becomes a standing issue the user can
   * see and retry, and the next success clears it.
   */
  async indexNode(node) {
    let failure = null;
    try {
      if (this.search) await this.search.indexName(node);
      const matching = this.indexers.matching(node);
      if (matching.length) {
        const storage = await this.storageFor(node.collectionId);
        const ctx = this.#indexCtx(node, storage);
        // #runOneIndexer already contains a single indexer's failure; what escapes here
        // is the shared work (reading the object, the search store itself).
        for (const indexer of matching) {
          const err = await this.#runOneIndexer(indexer, node, ctx);
          if (err && !failure) failure = err;
        }
      }
    } catch (err) {
      failure = err;
    }
    await this.#recordIndexOutcome(node, failure);
    if (failure) throw failure;
  }

  /** Raise or clear the standing "this item isn't findable" issue for a node. */
  async #recordIndexOutcome(node, failure) {
    if (!this.issues) return;
    try {
      if (!failure) {
        await this.issues.clear('index', node.id);
        return;
      }
      await this.issues.raise({
        kind: 'index',
        subject: node.id,
        collectionId: node.collectionId,
        title: `“${node.name}” could not be indexed — it won't turn up in search`,
        detail: failure.message || String(failure),
        retry: { op: 'reindex-node', nodeId: node.id },
      });
    } catch (err) {
      // The issue store failing is not a reason to fail the write that triggered it.
      console.error('could not record an indexing issue:', err.message);
    }
  }

  /**
   * Re-index just the NAME of a node. Split out from `indexNode` because a rename
   * changes nothing about the content: re-running every content indexer (re-reading the
   * blob, re-embedding it) to correct one keyword document would make renaming a file
   * as expensive as uploading it.
   */
  async reindexName(node) {
    if (this.search) await this.search.indexName(node);
  }

  /**
   * Re-index a node by id — the retry behind an indexing issue, and the full-content
   * counterpart to `reindexName`.
   */
  async reindexNode(nodeId) {
    const node = await this.metadata.getById(nodeId);
    if (!node) throw TroveError.notFound('Item');
    await this.indexNode(node);
    return { ok: true };
  }

  /** Build the context an indexer gets: capped reads + a time-limited read URL. */
  #indexCtx(node, storage) {
    // No Range on an object that already fits: a 0-byte file has no satisfiable range at
    // all, and asking for one made every empty file permanently un-indexable — a standing
    // issue whose Retry button re-ran the identical failure forever.
    const readRange = () => (node.size > this.maxIndexBytes
      ? storage.get(node.storageKey, { range: { start: 0, end: this.maxIndexBytes - 1 } })
      : storage.get(node.storageKey));
    return {
      node: { id: node.id, name: node.name, collectionId: node.collectionId, size: node.size, contentType: node.contentType },
      maxBytes: this.maxIndexBytes,
      readBytes: async () => readAll((await readRange()).stream),
      readText: async () => new TextDecoder().decode(await readAll((await readRange()).stream)),
      /**
       * Read `[start, end)` — HALF-OPEN, like every other range in JavaScript, converted
       * to HTTP's inclusive form at this one boundary.
       *
       * `readBytes` reads the FRONT of a file, which is the wrong end of every container
       * that keeps its index at the back: an MP4 written by an encoder that did not know
       * its final size puts `moov` last, and a zip's central directory is always last. An
       * indexer for either could not reach what it needed at all.
       *
       * Bounded per call by the same `maxIndexBytes` cap, so an indexer walking a 4 GB
       * book still cannot pull it through host memory — it just has to ask in pieces,
       * which is what walking a box chain does anyway.
       */
      readRange: async (start = 0, end = node.size) => {
        const from = Math.max(0, Math.min(start, node.size));
        const to = Math.min(end, from + this.maxIndexBytes, node.size);
        if (to <= from) return new Uint8Array(0);
        return readAll((await storage.get(node.storageKey, { range: { start: from, end: to - 1 } })).stream);
      },
      // A time-limited URL a remote/isolated indexer can fetch the bytes from. S3-class
      // backends presign; everything else gets a URL this server signed. Either way it
      // must be ABSOLUTE — whoever receives it is not in this browser and not on this
      // box, so a relative URL would be a link to nowhere.
      presignRead: async ({ expiresIn } = {}) => {
        if (!this.mintUrl) throw TroveError.unsupported('This server cannot mint read URLs for indexers');
        const { url } = await this.mintUrl(node.id, { op: 'index', expiresIn, absolute: true });
        return url;
      },
    };
  }

  /**
   * Run a single indexer against a node and apply its contribution. One misbehaving
   * indexer must not stop the others, so the error is returned rather than thrown —
   * the caller decides whether the node as a whole counts as failed.
   * @returns {Promise<Error|null>}
   */
  async #runOneIndexer(indexer, node, ctx) {
    try {
      const contribution = await indexer.index(node, ctx ?? this.#indexCtx(node, await this.storageFor(node.collectionId)));
      await this.#applyContribution(node.id, indexer.id, contribution);
      return null;
    } catch (err) {
      console.error(`indexer ${indexer.id} failed on ${node.name}:`, err.message);
      return err;
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
      const files = await this.metadata.scanItems({ afterId, limit: Math.min(pageSize, limit - done) });
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
   * Rebuild the whole search index from the drive's contents.
   *
   * The search index is derived state — every document in it can be recomputed from
   * the file it came from — so losing it is recoverable, but only if something
   * actually recovers it. This is that something: the server calls it at startup when
   * a non-empty drive meets an empty index (a store that was in-memory, a dropped
   * vector table after an embedding change, a restore from a metadata-only backup).
   *
   * Every file is re-read and every matching indexer re-run, so this is proportional
   * to the drive, not to what changed. It pages, tolerates a per-file failure, and
   * takes an `onProgress` so a caller can report on a long rebuild instead of going
   * quiet.
   *
   * `shouldStop` exists because a rebuild outlives the request that started it: a
   * server shutting down mid-rebuild would otherwise fail on every remaining file
   * against a closing database, turning one event into a page of errors. Stopping is
   * safe — the index is still empty, so the next start simply rebuilds it again.
   *
   * @param {{pageSize?: number, onProgress?: Function, shouldStop?: () => boolean}} [opts]
   */
  async reindexAll({ pageSize = 200, onProgress, shouldStop } = {}) {
    // Ask for a total so progress can be honest about how far along it is. A store that
    // can't count leaves this null, and the caller shows an indeterminate indicator —
    // which is the right answer. Inventing a total would produce a progress bar that
    // lies, and that is worse than a spinner.
    const total = await this.metadata.countItems().catch(() => null) ?? null;
    let indexed = 0;
    let failed = 0;
    let afterId = null;
    let stopped = false;
    onProgress?.({ indexed, failed, total });
    outer: for (;;) {
      const files = await this.metadata.scanItems({ afterId, limit: pageSize });
      if (!files.length) break;
      for (const node of files) {
        if (shouldStop?.()) { stopped = true; break outer; }
        afterId = node.id;
        try {
          await this.indexNode(node);
          indexed++;
        } catch (err) {
          failed++;
          console.error(`reindex failed for ${node.name}:`, err.message);
        }
      }
      onProgress?.({ indexed, failed, total });
      if (files.length < pageSize) break;
    }
    const result = { indexed, failed, stopped, total };
    await this.#recordScanOutcome(result);
    return result;
  }

  /**
   * A scan that couldn't index everything is a standing problem about the DRIVE, not
   * about any one file: search is incomplete and the user has no way to know unless
   * we say so. Cleared by the next clean scan — which is what makes the retry button
   * on it meaningful.
   */
  async #recordScanOutcome({ indexed, failed, stopped }) {
    if (!this.issues) return;
    try {
      if (!failed && !stopped) {
        await this.issues.clear('reindex');
        return;
      }
      if (stopped) return; // interrupted by shutdown; the next start picks it up
      await this.issues.raise({
        kind: 'reindex',
        title: `${failed} item${failed === 1 ? '' : 's'} could not be indexed — search is incomplete`,
        detail: `${indexed} indexed, ${failed} failed. Individual items are listed separately where they could be identified.`,
        retry: { op: 'reindex-all' },
      });
    } catch (err) {
      console.error('could not record a reindex issue:', err.message);
    }
  }

  /**
   * Remove one contributor's contributions from every node (e.g. on uninstall).
   *
   * The search index is dropped in ONE bulk call — the stores can delete by indexer
   * directly, so paging every node just to clear it per-node would be the same work
   * done N times. Metadata still has to be walked, since a contribution lives on the
   * node record.
   */
  async purgeIndexer(contributorId, { pageSize = 500 } = {}) {
    if (this.search) await this.search.removeIndexer(contributorId).catch(() => {});
    let cleared = 0;
    let afterId = null;
    for (;;) {
      const files = await this.metadata.scanItems({ afterId, limit: pageSize });
      if (!files.length) break;
      for (const node of files) {
        afterId = node.id;
        if (node.contributions && node.contributions[contributorId]) {
          await this.metadata.clearContribution(node.id, contributorId);
          cleared++;
        }
      }
      if (files.length < pageSize) break;
    }
    return { cleared };
  }
}


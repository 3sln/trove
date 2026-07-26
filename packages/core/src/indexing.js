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
import { normalizeContribution, clampContribution, DEFAULT_CAPS } from './indexers/contribution.js';

export class IndexingCoordinator {
  /**
   * @param {object} deps
   * @param {import('./metadata/interface.js').MetadataStore} deps.metadata
   * @param {object|null} deps.search  SearchService (or null when search is disabled)
   * @param {import('./indexers/registry.js').IndexerRegistry} deps.indexers
   * @param {(collectionId: string) => Promise<object>} deps.storageFor
   * @param {number} deps.maxIndexBytes
   * @param {object} [deps.caps]  contribution size caps (see indexers/contribution.js)
   */
  constructor({ metadata, search, indexers, storageFor, maxIndexBytes, caps }) {
    this.metadata = metadata;
    this.search = search ?? null;
    this.indexers = indexers;
    this.storageFor = storageFor;
    this.maxIndexBytes = maxIndexBytes;
    this.caps = { ...DEFAULT_CAPS, ...caps };
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
    const { semanticTexts, tags, metadata } = normalizeContribution(clampContribution(contribution, this.caps));
    if (this.search && semanticTexts.length) await this.search.indexDocuments(nodeId, contributorId, semanticTexts);
    // Indexer contributions live in the queryable metadata store (not the sidecar),
    // so they show up in list/stat and drive tag filtering.
    if (tags || metadata) await this.metadata.setContribution(nodeId, contributorId, { tags, metadata });
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

  /** Index a freshly written/uploaded node: its name (for keyword search) + every
   *  matching indexer's contribution. */
  async indexNode(node) {
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
      node: { id: node.id, name: node.name, collectionId: node.collectionId, size: node.size, contentType: node.contentType },
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
      console.error(`indexer ${indexer.id} failed on ${node.name}:`, err.message);
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
    let indexed = 0;
    let failed = 0;
    let afterId = null;
    let stopped = false;
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
      onProgress?.({ indexed, failed });
      if (files.length < pageSize) break;
    }
    return { indexed, failed, stopped };
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


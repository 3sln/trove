// SearchService — orchestrates hybrid semantic + keyword search over two
// PLUGGABLE, async stores: a VectorStore (dense) and a KeywordStore (sparse).
// It owns neither implementation — you inject them (defaults are in-memory), so
// a deployment can point vectors at Qdrant/pgvector and keywords at Postgres FTS
// while core stays platform-agnostic. The embedding provider is injected too.
//
// Documents enter three ways, all namespaced by indexerId:
//   1. Server indexers (IndexerRegistry) — run on upload, text extracted here.
//   2. Plugin indexers — push { text } or precomputed { vector } via the API.
//   3. Name index — every node's name/path stays keyword-searchable.
//
// Results are grouped by node, scored by best chunk, and returned with a snippet.

import { MemoryVectorStore } from './vectorStore.js';
import { MemoryKeywordStore, tokenize } from './keywordStore.js';
import { TroveError } from '../errors.js';

export class SearchService {
  /**
   * @param {object} deps
   * @param {import('./embeddings.js').EmbeddingProvider} deps.embeddings
   * @param {import('./vectorStore.js').VectorStore} [deps.vectorStore]  injected; default in-memory
   * @param {import('./keywordStore.js').KeywordStore} [deps.keywordStore] injected; default in-memory
   * @param {number} [deps.semanticWeight] 0..1 blend (default 0.7 dense / 0.3 lexical)
   */
  constructor({ embeddings, vectorStore, keywordStore, semanticWeight = 0.7 }) {
    if (!embeddings) throw TroveError.invalid('SearchService requires an embeddings provider');
    this.embeddings = embeddings;
    this.vectors = vectorStore ?? new MemoryVectorStore({ dimensions: embeddings.dimensions });
    this.keywords = keywordStore ?? new MemoryKeywordStore();
    this.semanticWeight = semanticWeight;
  }

  /** A wire-safe description of the configured backends (for /api/capabilities), so the
   *  route doesn't reach into internal class identities. */
  describe() {
    return {
      vectorStore: this.vectors?.constructor?.name || null,
      keywordStore: this.keywords?.constructor?.name || null,
      embeddings: this.embeddings?.constructor?.name || null,
      dimensions: this.vectors?.dimensions || null,
      // Whether the index survives a restart. Stated outright rather than left to be
      // inferred from a class name, because "your search index is rebuilt from scratch
      // every restart" is an operational fact an admin should be able to read off
      // /api/capabilities without knowing which store maps to which guarantee.
      durable: this.vectors instanceof MemoryVectorStore || this.keywords instanceof MemoryKeywordStore ? false : true,
    };
  }

  /**
   * Index documents for a node under one indexer namespace. Replaces prior docs
   * from the same (nodeId, indexerId) so re-indexing is clean. Accepts { text }
   * (embedded here) or { vector } (precomputed by a plugin).
   */
  async indexDocuments(nodeId, indexerId, documents) {
    if (!documents?.length) {
      await Promise.all([
        this.vectors.removeByNodeIndexer(nodeId, indexerId),
        this.keywords.removeByNodeIndexer(nodeId, indexerId),
      ]);
      return { indexed: 0 };
    }

    // Embed BEFORE removing anything. Both removals used to run first, so a transient
    // embedding outage during a re-index left the file with zero vectors and zero
    // keywords — recoverable through the issue, but unfindable in the meantime, and the
    // old index was perfectly good until we threw it away.
    const needEmbedding = documents.filter((d) => !d.vector && d.text);
    const embedded = needEmbedding.length ? await this.embeddings.embed(needEmbedding.map((d) => d.text)) : [];
    await Promise.all([
      this.vectors.removeByNodeIndexer(nodeId, indexerId),
      this.keywords.removeByNodeIndexer(nodeId, indexerId),
    ]);

    const vectorDocs = [];
    const keywordDocs = [];
    let vi = 0;
    let counter = 0;
    for (const d of documents) {
      const docId = d.id || `${indexerId}:${nodeId}:${counter++}`;
      const vector = d.vector || (d.text ? embedded[vi++] : null);
      if (vector) {
        if (this.vectors.dimensions && vector.length !== this.vectors.dimensions) {
          throw TroveError.invalid(`Document vector dim ${vector.length} != index dim ${this.vectors.dimensions}`);
        }
        vectorDocs.push({ id: docId, nodeId, indexerId, vector, fields: d.fields });
      }
      keywordDocs.push({ id: docId, nodeId, indexerId, text: d.text || '', fields: d.fields || {} });
    }
    await Promise.all([
      vectorDocs.length ? this.vectors.add(vectorDocs) : null,
      this.keywords.add(keywordDocs),
    ]);
    return { indexed: documents.length };
  }

  /** Keep names/paths searchable regardless of content indexers. */
  async indexName(node) {
    await this.keywords.removeByNodeIndexer(node.id, 'core.name');
    await this.keywords.add([{ id: `name:${node.id}`, nodeId: node.id, indexerId: 'core.name', text: node.name, fields: { name: node.name, collectionId: node.collectionId } }]);
  }

  /**
   * Does at least one configured store hold nothing?
   *
   * This is the startup signal for "the index was lost" — a drive with files always
   * has at least one keyword doc per node (indexName writes one), so an empty store
   * beside a non-empty metadata store means the index needs rebuilding. Asked per
   * store rather than of the pair, because a deployment can persist vectors and not
   * keywords (or the reverse), and half a search index is still a broken one.
   *
   * @returns {Promise<boolean|null>} null when neither store can report a count — a
   *   store that can't say is never taken as evidence that a rebuild is needed.
   */
  async looksUnindexed() {
    const [vectors, keywords] = await Promise.all([safeCount(this.vectors), safeCount(this.keywords)]);
    if (vectors == null && keywords == null) return null;
    return (vectors ?? 1) === 0 || (keywords ?? 1) === 0;
  }

  async removeNode(nodeId) {
    await Promise.all([this.vectors.removeByNode(nodeId), this.keywords.removeByNode(nodeId)]);
  }
  async removeIndexer(indexerId) {
    await Promise.all([this.vectors.removeByIndexer(indexerId), this.keywords.removeByIndexer(indexerId)]);
  }

  /**
   * @param {string} query
   * @param {{limit?: number, indexers?: string[], mode?: 'hybrid'|'semantic'|'keyword'}} [opts]
   * @returns {Promise<Array<{nodeId, score, indexerId, snippet, fields}>>}
   */
  async search(query, opts = {}) {
    const limit = opts.limit ?? 20;
    const mode = opts.mode ?? 'hybrid';
    const perNode = new Map();

    // Dense / semantic and sparse / lexical run concurrently.
    const [dense, sparse] = await Promise.all([
      mode === 'keyword' ? [] : this.#dense(query, limit, opts.indexers),
      mode === 'semantic' ? [] : this.keywords.search(query, { limit: limit * 4, indexers: opts.indexers }),
    ]);

    const semanticW = mode === 'semantic' ? 1 : this.semanticWeight;
    const lexicalW = mode === 'keyword' ? 1 : 1 - this.semanticWeight;

    for (const r of dense) accumulate(perNode, r.nodeId, r.score * semanticW, r.indexerId, r.docId, r.fields);
    for (const r of sparse) accumulate(perNode, r.nodeId, r.score * lexicalW, r.indexerId, r.docId, r.fields);

    const ranked = [...perNode.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    // Attach snippets (best-effort; keyword store owns the text).
    for (const r of ranked) r.snippet = await this.keywords.snippet(r.docId, query);
    return ranked.map(({ docId, best, ...rest }) => rest);
  }

  async #dense(query, limit, indexers) {
    const qv = await this.embeddings.embedOne(query);
    return this.vectors.query(qv, { limit: limit * 4, indexers });
  }
}

async function safeCount(store) {
  try { return (await store?.count?.()) ?? null; } catch { return null; }
}

/**
 * Fold one document's hit into its node's running score.
 *
 * A node can be hit by several documents and by both channels (dense and sparse), and
 * the score has to grow with that rather than being replaced by whichever hit arrived
 * with the larger number. The old form assigned `cur.score = score` on the better hit,
 * DISCARDING everything accumulated so far — so a file matching both channels could
 * rank below one matching only lexically, which is the opposite of what hybrid search
 * is for. It also moved `docId`/`indexerId` without moving `fields`, so the snippet
 * came from one chunk and the fields from another.
 *
 * Now: the score is the best hit plus a small bonus for each additional one, and the
 * document a result POINTS at is always the best-scoring one, with its own fields.
 */
function accumulate(map, nodeId, score, indexerId, docId, fields) {
  const cur = map.get(nodeId);
  if (!cur) {
    map.set(nodeId, { nodeId, score, best: score, indexerId, docId, fields });
    return;
  }
  // Every additional matching chunk adds a little — matching in ten places is more
  // relevant than matching in one.
  cur.score += score * 0.1;
  if (score > cur.best) {
    // A new best: raise the floor to it, keeping the bonuses already earned, and take
    // the whole descriptor from this document so snippet and fields agree.
    cur.score += score - cur.best;
    cur.best = score;
    cur.indexerId = indexerId;
    cur.docId = docId;
    cur.fields = fields;
  }
}

export { tokenize };

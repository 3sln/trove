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

  /**
   * Index documents for a node under one indexer namespace. Replaces prior docs
   * from the same (nodeId, indexerId) so re-indexing is clean. Accepts { text }
   * (embedded here) or { vector } (precomputed by a plugin).
   */
  async indexDocuments(nodeId, indexerId, documents) {
    await Promise.all([
      this.vectors.removeByNodeIndexer(nodeId, indexerId),
      this.keywords.removeByNodeIndexer(nodeId, indexerId),
    ]);
    if (!documents?.length) return { indexed: 0 };

    const needEmbedding = documents.filter((d) => !d.vector && d.text);
    const embedded = needEmbedding.length ? await this.embeddings.embed(needEmbedding.map((d) => d.text)) : [];

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
    await this.keywords.add([{ id: `name:${node.id}`, nodeId: node.id, indexerId: 'core.name', text: node.name, fields: { name: node.name, path: node.path } }]);
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
    return ranked.map(({ docId, ...rest }) => rest);
  }

  async #dense(query, limit, indexers) {
    const qv = await this.embeddings.embedOne(query);
    return this.vectors.query(qv, { limit: limit * 4, indexers });
  }
}

function accumulate(map, nodeId, score, indexerId, docId, fields) {
  const cur = map.get(nodeId);
  if (!cur) {
    map.set(nodeId, { nodeId, score, indexerId, docId, fields });
  } else if (score > cur.score) {
    cur.score = score;
    cur.indexerId = indexerId;
    cur.docId = docId;
  } else {
    cur.score += score * 0.1; // small bonus for matching multiple chunks
  }
}

export { tokenize };

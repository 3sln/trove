// SearchService — the semantic + keyword search brain. It owns the embedding
// provider and a VectorIndex, and blends dense (vector) similarity with a sparse
// lexical score so exact-term matches and conceptual matches both surface.
//
// Documents enter three ways, all namespaced by indexerId:
//   1. Server indexers (IndexerRegistry) — run on upload, text extracted here.
//   2. Plugin indexers — push { text } or precomputed { vector } via the API.
//   3. Name index — every node's name/path is always keyword-searchable.
//
// Results are grouped by node (a file may have many chunks), scored by the best
// chunk, and returned with a snippet for display.

import { VectorIndex } from './vector.js';
import { TroveError } from '../errors.js';

export class SearchService {
  /**
   * @param {object} deps
   * @param {import('./embeddings.js').EmbeddingProvider} deps.embeddings
   * @param {VectorIndex} [deps.vectorIndex]
   * @param {number} [deps.semanticWeight] 0..1 blend (default 0.7 dense / 0.3 lexical)
   */
  constructor({ embeddings, vectorIndex, semanticWeight = 0.7 }) {
    if (!embeddings) throw TroveError.invalid('SearchService requires an embeddings provider');
    this.embeddings = embeddings;
    this.vectors = vectorIndex ?? new VectorIndex({ dimensions: embeddings.dimensions });
    this.semanticWeight = semanticWeight;
    this.lexicon = new Map(); // docId -> { nodeId, indexerId, tokens:Set, text, fields }
  }

  /**
   * Index a set of documents for a node under one indexer namespace. Replaces any
   * prior documents from the same (nodeId, indexerId) so re-indexing is clean.
   * Accepts { text } (embedded here) or { vector } (precomputed by a plugin).
   */
  async indexDocuments(nodeId, indexerId, documents) {
    // Clear previous docs for this node+indexer.
    for (const [docId, rec] of this.lexicon) {
      if (rec.nodeId === nodeId && rec.indexerId === indexerId) {
        this.lexicon.delete(docId);
        this.vectors.remove(docId);
      }
    }
    if (!documents?.length) return { indexed: 0 };

    const needEmbedding = documents.filter((d) => !d.vector && d.text);
    let vectors = [];
    if (needEmbedding.length) {
      vectors = await this.embeddings.embed(needEmbedding.map((d) => d.text));
    }
    let vi = 0;
    for (const d of documents) {
      const docId = d.id || `${indexerId}:${nodeId}:${this.vectors.size()}`;
      const vector = d.vector || (d.text ? vectors[vi++] : null);
      if (vector) {
        if (vector.length !== this.vectors.dimensions) {
          throw TroveError.invalid(
            `Document vector dim ${vector.length} != index dim ${this.vectors.dimensions}`,
          );
        }
        this.vectors.add({ id: docId, nodeId, indexerId, vector, fields: d.fields });
      }
      this.lexicon.set(docId, {
        nodeId, indexerId, text: d.text || '',
        tokens: new Set(tokenize((d.text || '') + ' ' + Object.values(d.fields || {}).join(' '))),
        fields: d.fields || {},
      });
    }
    return { indexed: documents.length };
  }

  /** Keep names/paths searchable regardless of content indexers. */
  async indexName(node) {
    const docId = `name:${node.id}`;
    this.lexicon.set(docId, {
      nodeId: node.id, indexerId: 'core.name', text: node.name,
      tokens: new Set(tokenize(node.name + ' ' + node.path)),
      fields: { name: node.name, path: node.path },
    });
  }

  removeNode(nodeId) {
    this.vectors.removeByNode(nodeId);
    for (const [docId, rec] of this.lexicon) {
      if (rec.nodeId === nodeId) this.lexicon.delete(docId);
    }
  }

  removeIndexer(indexerId) {
    this.vectors.removeByIndexer(indexerId);
    for (const [docId, rec] of this.lexicon) {
      if (rec.indexerId === indexerId) this.lexicon.delete(docId);
    }
  }

  /**
   * @param {string} query
   * @param {{limit?: number, indexers?: string[], mode?: 'hybrid'|'semantic'|'keyword'}} [opts]
   * @returns {Promise<{nodeId, score, indexerId, snippet, fields}[]>}
   */
  async search(query, opts = {}) {
    const limit = opts.limit ?? 20;
    const mode = opts.mode ?? 'hybrid';
    const perNode = new Map(); // nodeId -> best result

    // Dense / semantic.
    if (mode !== 'keyword' && this.vectors.size() > 0) {
      const qv = await this.embeddings.embedOne(query);
      const dense = this.vectors.search(qv, { limit: limit * 4, indexers: opts.indexers });
      for (const r of dense) {
        const w = mode === 'semantic' ? 1 : this.semanticWeight;
        accumulate(perNode, r.nodeId, r.score * w, r.indexerId, this.#snippet(r.docId, query), r.fields);
      }
    }

    // Sparse / lexical.
    if (mode !== 'semantic') {
      const qTokens = tokenize(query);
      const lexWeight = mode === 'keyword' ? 1 : 1 - this.semanticWeight;
      for (const [docId, rec] of this.lexicon) {
        if (opts.indexers && !opts.indexers.includes(rec.indexerId)) continue;
        const score = lexicalScore(qTokens, rec.tokens);
        if (score > 0) {
          accumulate(perNode, rec.nodeId, score * lexWeight, rec.indexerId, this.#snippet(docId, query), rec.fields);
        }
      }
    }

    return [...perNode.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  #snippet(docId, query) {
    const rec = this.lexicon.get(docId);
    if (!rec?.text) return null;
    const text = rec.text;
    const qTokens = tokenize(query);
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of qTokens) {
      const i = lower.indexOf(t);
      if (i >= 0) {
        at = i;
        break;
      }
    }
    if (at < 0) return text.slice(0, 160).trim();
    const start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + text.slice(start, start + 200).trim() + '…';
  }
}

const STOP = new Set('a an the of to in on for and or is are be as at by with from this that it'.split(' '));

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Jaccard-ish overlap weighted by query coverage — cheap, no global IDF needed.
function lexicalScore(qTokens, docTokens) {
  if (!qTokens.length || !docTokens.size) return 0;
  let hit = 0;
  for (const t of qTokens) if (docTokens.has(t)) hit++;
  return hit / qTokens.length;
}

function accumulate(map, nodeId, score, indexerId, snippet, fields) {
  const cur = map.get(nodeId);
  if (!cur) {
    map.set(nodeId, { nodeId, score, indexerId, snippet, fields });
  } else if (score > cur.score) {
    cur.score = score;
    cur.indexerId = indexerId;
    if (snippet) cur.snippet = snippet;
  } else {
    cur.score += score * 0.1; // small bonus for matching multiple chunks
  }
}

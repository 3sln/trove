// KeywordStore — the pluggable lexical (sparse) half of hybrid search, mirroring
// VectorStore's async, injectable shape. The in-memory default keeps a token set
// per document and scores by query-term coverage; swap in an implementation over
// SQLite FTS5, Postgres tsvector, Elasticsearch, etc. for durability/scale.
// SearchService composes a VectorStore + a KeywordStore, so a deployment can mix
// (e.g. Qdrant for vectors, Postgres FTS for keywords) — core hardcodes neither.

import { TroveError } from '../errors.js';

const STOP = new Set('a an the of to in on for and or is are be as at by with from this that it'.split(' '));

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class KeywordStore {
  async add(docs) {
    throw TroveError.unsupported('add not implemented');
  }
  async removeByNode(nodeId) {
    throw TroveError.unsupported('removeByNode not implemented');
  }
  async removeByIndexer(indexerId) {
    throw TroveError.unsupported('removeByIndexer not implemented');
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    throw TroveError.unsupported('removeByNodeIndexer not implemented');
  }
  /** @returns {Promise<Array<{docId,nodeId,indexerId,score,fields}>>} */
  async search(query, opts) {
    throw TroveError.unsupported('search not implemented');
  }
  /** Optional: a highlighted excerpt for a doc (null if unavailable). */
  async snippet(docId, query) {
    return null;
  }
  /** Optional: number of stored documents. Null when the store can't say — which is
   *  not the same as zero, and the startup rebuild check depends on the difference. */
  async count() {
    return null;
  }
}

export class MemoryKeywordStore extends KeywordStore {
  constructor() {
    super();
    this.docs = new Map(); // docId -> { nodeId, indexerId, text, tokens:Set, fields }
  }

  async add(docs) {
    for (const d of docs) {
      const text = d.text || '';
      this.docs.set(d.id, {
        nodeId: d.nodeId, indexerId: d.indexerId, text,
        tokens: new Set(tokenize(text + ' ' + Object.values(d.fields || {}).join(' '))),
        fields: d.fields || {},
      });
    }
  }
  async removeByNode(nodeId) {
    for (const [id, r] of this.docs) if (r.nodeId === nodeId) this.docs.delete(id);
  }
  async removeByIndexer(indexerId) {
    for (const [id, r] of this.docs) if (r.indexerId === indexerId) this.docs.delete(id);
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    for (const [id, r] of this.docs) if (r.nodeId === nodeId && r.indexerId === indexerId) this.docs.delete(id);
  }

  async search(query, opts = {}) {
    const q = tokenize(query);
    if (!q.length) return [];
    const allow = opts.indexers ? new Set(opts.indexers) : null;
    const out = [];
    for (const [docId, r] of this.docs) {
      if (allow && !allow.has(r.indexerId)) continue;
      let hit = 0;
      for (const t of q) if (r.tokens.has(t)) hit++;
      if (hit > 0) out.push({ docId, nodeId: r.nodeId, indexerId: r.indexerId, score: hit / q.length, fields: r.fields });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit ?? 40);
  }

  async snippet(docId, query) {
    const r = this.docs.get(docId);
    if (!r?.text) return null;
    const q = tokenize(query);
    const lower = r.text.toLowerCase();
    let at = -1;
    for (const t of q) {
      const i = lower.indexOf(t);
      if (i >= 0) { at = i; break; }
    }
    if (at < 0) return r.text.slice(0, 160).trim();
    const start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + r.text.slice(start, start + 200).trim() + '…';
  }

  async count() {
    return this.docs.size;
  }
}

// VectorStore — the pluggable nearest-neighbour index behind semantic search.
// The contract is fully ASYNC so an external vector database (pgvector, Qdrant,
// Pinecone, Milvos, LanceDB…) fits behind the same interface as the built-in
// in-memory store. You construct a concrete VectorStore and pass it into the
// server (or SearchService) — core never hardcodes one, and stays platform
// agnostic (the bundled adapters use only fetch + Web Crypto).
//
// A "doc" is one embedded chunk:
//   { id, nodeId, indexerId, vector: number[], fields?: object }
// `id` is stable per (indexer, node, chunk); `nodeId`/`indexerId` let the store
// delete a file's or an indexer's vectors wholesale.

import { TroveError, wrapError } from '../errors.js';
import { withRetry } from '../retry.js';

export class VectorStore {
  /** Vector dimensionality this store expects (must match the embeddings). */
  get dimensions() {
    return this._dimensions ?? 0;
  }

  /** Upsert documents. @param {Array} docs */
  async add(docs) {
    throw TroveError.unsupported('add not implemented');
  }
  /** Remove one document by id. */
  async remove(docId) {
    throw TroveError.unsupported('remove not implemented');
  }
  /** Remove every document belonging to a node. */
  async removeByNode(nodeId) {
    throw TroveError.unsupported('removeByNode not implemented');
  }
  /** Remove every document contributed by an indexer namespace. */
  async removeByIndexer(indexerId) {
    throw TroveError.unsupported('removeByIndexer not implemented');
  }
  /** Remove documents matching both a node and an indexer (re-index a file). */
  async removeByNodeIndexer(nodeId, indexerId) {
    throw TroveError.unsupported('removeByNodeIndexer not implemented');
  }
  /**
   * Nearest neighbours by cosine similarity.
   * @param {number[]} vector normalised query vector
   * @param {{limit?: number, indexers?: string[]}} [opts]
   * @returns {Promise<Array<{docId, nodeId, indexerId, score, fields}>>}
   */
  async query(vector, opts) {
    throw TroveError.unsupported('query not implemented');
  }
  /** Optional: number of stored vectors (diagnostics). */
  async count() {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MemoryVectorStore — exact, brute-force, dependency-free. Correct and fine up
// to ~10^5 vectors; the default when no external store is provided. `persist`/
// `load` snapshot to JSON so an index can survive a restart without a DB.
// ---------------------------------------------------------------------------

export class MemoryVectorStore extends VectorStore {
  constructor({ dimensions } = {}) {
    super();
    this._dimensions = dimensions;
    this.docs = new Map(); // docId -> { id, nodeId, indexerId, vector: Float32Array, fields }
    this.byNode = new Map();
    this.byIndexer = new Map();
  }

  async add(docs) {
    for (const doc of docs) {
      if (this._dimensions && doc.vector.length !== this._dimensions) {
        throw TroveError.invalid(`Vector dim ${doc.vector.length} != index dim ${this._dimensions}`);
      }
      await this.remove(doc.id);
      const rec = {
        id: doc.id, nodeId: doc.nodeId, indexerId: doc.indexerId,
        vector: doc.vector instanceof Float32Array ? doc.vector : Float32Array.from(doc.vector),
        fields: doc.fields || {},
      };
      this.docs.set(rec.id, rec);
      index(this.byNode, rec.nodeId, rec.id);
      index(this.byIndexer, rec.indexerId, rec.id);
    }
  }

  async remove(docId) {
    const rec = this.docs.get(docId);
    if (!rec) return;
    this.docs.delete(docId);
    this.byNode.get(rec.nodeId)?.delete(docId);
    this.byIndexer.get(rec.indexerId)?.delete(docId);
  }

  async removeByNode(nodeId) {
    for (const id of this.byNode.get(nodeId) || []) this.docs.delete(id);
    this.byNode.delete(nodeId);
  }
  async removeByIndexer(indexerId) {
    for (const id of this.byIndexer.get(indexerId) || []) this.docs.delete(id);
    this.byIndexer.delete(indexerId);
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    for (const id of this.byNode.get(nodeId) || []) {
      const rec = this.docs.get(id);
      if (rec && rec.indexerId === indexerId) await this.remove(id);
    }
  }

  async query(vector, opts = {}) {
    const limit = opts.limit ?? 20;
    const allow = opts.indexers ? new Set(opts.indexers) : null;
    const out = [];
    for (const rec of this.docs.values()) {
      if (allow && !allow.has(rec.indexerId)) continue;
      out.push({ docId: rec.id, nodeId: rec.nodeId, indexerId: rec.indexerId, score: dot(vector, rec.vector), fields: rec.fields });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  async count() {
    return this.docs.size;
  }

  persist() {
    return {
      dimensions: this._dimensions,
      docs: [...this.docs.values()].map((r) => ({ id: r.id, nodeId: r.nodeId, indexerId: r.indexerId, vector: Array.from(r.vector), fields: r.fields })),
    };
  }
  static async load(snapshot) {
    const store = new MemoryVectorStore({ dimensions: snapshot.dimensions });
    await store.add(snapshot.docs.map((d) => ({ ...d, vector: Float32Array.from(d.vector) })));
    return store;
  }
}

// ---------------------------------------------------------------------------
// QdrantVectorStore — a real external adapter, proving the interface fits an
// async network DB. Uses Qdrant's REST API over fetch (works on Node, Bun,
// Workers). Point ids are deterministic UUIDs derived from the docId (Qdrant
// requires uint/uuid ids); the original docId + routing keys live in the
// payload so node/indexer deletes are filter-based.
// ---------------------------------------------------------------------------

export class QdrantVectorStore extends VectorStore {
  /**
   * @param {object} cfg
   * @param {string} cfg.url          e.g. http://localhost:6333
   * @param {string} cfg.collection
   * @param {number} cfg.dimensions
   * @param {string} [cfg.apiKey]
   * @param {string} [cfg.distance]   Cosine (default) | Dot | Euclid
   */
  constructor(cfg) {
    super();
    for (const k of ['url', 'collection', 'dimensions']) {
      if (!cfg?.[k]) throw TroveError.invalid(`QdrantVectorStore requires "${k}"`);
    }
    this.cfg = cfg;
    this._dimensions = cfg.dimensions;
    this._ready = null;
  }

  async #req(method, path, body) {
    return withRetry(
      async () => {
        let res;
        try {
          res = await fetch(this.cfg.url.replace(/\/$/, '') + path, {
            method,
            headers: { 'content-type': 'application/json', ...(this.cfg.apiKey ? { 'api-key': this.cfg.apiKey } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
        } catch (err) {
          throw wrapError(err);
        }
        if (res.status === 429 || res.status >= 500) throw TroveError.transient(`Qdrant ${res.status}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw TroveError.internal(`Qdrant ${method} ${path} failed: ${json?.status?.error || res.status}`);
        return json;
      },
      { retries: 3 },
    );
  }

  /** Create the collection on first use (idempotent). */
  async #ensure() {
    if (!this._ready) {
      this._ready = (async () => {
        const existing = await this.#req('GET', `/collections/${this.cfg.collection}/exists`).catch(() => null);
        if (existing?.result?.exists) return;
        await this.#req('PUT', `/collections/${this.cfg.collection}`, {
          vectors: { size: this.cfg.dimensions, distance: this.cfg.distance || 'Cosine' },
        }).catch((e) => {
          // Tolerate a concurrent create (409-ish) but surface real errors.
          if (!/already exists/i.test(e.message)) throw e;
        });
      })();
    }
    return this._ready;
  }

  async add(docs) {
    if (!docs.length) return;
    await this.#ensure();
    const points = await Promise.all(
      docs.map(async (d) => ({
        id: await docUuid(d.id),
        vector: Array.from(d.vector),
        payload: { docId: d.id, nodeId: d.nodeId, indexerId: d.indexerId, fields: d.fields || {} },
      })),
    );
    await this.#req('PUT', `/collections/${this.cfg.collection}/points?wait=true`, { points });
  }

  async remove(docId) {
    await this.#deleteByFilter({ must: [{ key: 'docId', match: { value: docId } }] });
  }
  async removeByNode(nodeId) {
    await this.#deleteByFilter({ must: [{ key: 'nodeId', match: { value: nodeId } }] });
  }
  async removeByIndexer(indexerId) {
    await this.#deleteByFilter({ must: [{ key: 'indexerId', match: { value: indexerId } }] });
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    await this.#deleteByFilter({ must: [{ key: 'nodeId', match: { value: nodeId } }, { key: 'indexerId', match: { value: indexerId } }] });
  }
  async #deleteByFilter(filter) {
    await this.#ensure();
    await this.#req('POST', `/collections/${this.cfg.collection}/points/delete?wait=true`, { filter });
  }

  async query(vector, opts = {}) {
    await this.#ensure();
    const body = { vector: Array.from(vector), limit: opts.limit ?? 20, with_payload: true };
    if (opts.indexers?.length) body.filter = { must: [{ key: 'indexerId', match: { any: opts.indexers } }] };
    const res = await this.#req('POST', `/collections/${this.cfg.collection}/points/search`, body);
    return (res.result || []).map((r) => ({
      docId: r.payload?.docId, nodeId: r.payload?.nodeId, indexerId: r.payload?.indexerId,
      score: r.score, fields: r.payload?.fields || {},
    }));
  }

  async count() {
    await this.#ensure();
    const res = await this.#req('POST', `/collections/${this.cfg.collection}/points/count`, { exact: true });
    return res.result?.count ?? null;
  }
}

// Deterministic UUIDv5-style id from a string (SHA-256 → formatted as a UUID).
async function docUuid(str) {
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  const h = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function index(map, key, id) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(id);
}
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

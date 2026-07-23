// VectorIndex — stores document vectors and answers nearest-neighbour queries by
// cosine similarity (vectors are pre-normalised so it's a dot product). The
// default is an exact, in-memory, brute-force scan: correct and dependency-free,
// fine up to ~10^5 docs. `persist`/`load` let a store snapshot to JSON so the
// index survives restarts. Swap in an ANN/pgvector-backed implementation of the
// same shape for larger corpora.

export class VectorIndex {
  constructor({ dimensions }) {
    this.dimensions = dimensions;
    this.docs = new Map(); // docId -> { id, nodeId, indexerId, vector: Float32Array, fields }
    this.byNode = new Map(); // nodeId -> Set(docId)
    this.byIndexer = new Map(); // indexerId -> Set(docId)
  }

  size() {
    return this.docs.size;
  }

  add(doc) {
    if (doc.vector.length !== this.dimensions) {
      throw new Error(`Vector dim ${doc.vector.length} != index dim ${this.dimensions}`);
    }
    const rec = {
      id: doc.id,
      nodeId: doc.nodeId,
      indexerId: doc.indexerId,
      vector: doc.vector instanceof Float32Array ? doc.vector : Float32Array.from(doc.vector),
      fields: doc.fields || {},
    };
    this.remove(doc.id);
    this.docs.set(rec.id, rec);
    index(this.byNode, rec.nodeId, rec.id);
    index(this.byIndexer, rec.indexerId, rec.id);
  }

  remove(docId) {
    const rec = this.docs.get(docId);
    if (!rec) return;
    this.docs.delete(docId);
    this.byNode.get(rec.nodeId)?.delete(docId);
    this.byIndexer.get(rec.indexerId)?.delete(docId);
  }

  removeByNode(nodeId) {
    for (const id of this.byNode.get(nodeId) || []) this.docs.delete(id);
    this.byNode.delete(nodeId);
  }

  removeByIndexer(indexerId) {
    for (const id of this.byIndexer.get(indexerId) || []) this.docs.delete(id);
    this.byIndexer.delete(indexerId);
  }

  /**
   * @param {number[]|Float32Array} queryVector normalised
   * @param {{limit?: number, indexers?: string[], filter?: (rec)=>boolean}} [opts]
   * @returns {{docId, nodeId, indexerId, score, fields}[]}
   */
  search(queryVector, opts = {}) {
    const q = queryVector;
    const limit = opts.limit ?? 20;
    const allow = opts.indexers ? new Set(opts.indexers) : null;
    const results = [];
    for (const rec of this.docs.values()) {
      if (allow && !allow.has(rec.indexerId)) continue;
      if (opts.filter && !opts.filter(rec)) continue;
      const score = dot(q, rec.vector);
      results.push({ docId: rec.id, nodeId: rec.nodeId, indexerId: rec.indexerId, score, fields: rec.fields });
    }
    // Partial sort would be faster; for our sizes a full sort is fine.
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  persist() {
    return {
      dimensions: this.dimensions,
      docs: [...this.docs.values()].map((r) => ({
        id: r.id, nodeId: r.nodeId, indexerId: r.indexerId,
        vector: Array.from(r.vector), fields: r.fields,
      })),
    };
  }

  static load(snapshot) {
    const idx = new VectorIndex({ dimensions: snapshot.dimensions });
    for (const d of snapshot.docs) idx.add({ ...d, vector: Float32Array.from(d.vector) });
    return idx;
  }
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

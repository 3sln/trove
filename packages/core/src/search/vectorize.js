// VectorizeVectorStore — an adapter over Cloudflare Vectorize, proving the
// VectorStore contract fits a serverless, metadata-filtered ANN index. Two
// access modes share one code path:
//   • Workers binding — `new VectorizeVectorStore({ binding: env.VECTORIZE, dimensions })`.
//     Calls the binding RPC surface directly (upsert/query/deleteByIds/getByIds).
//   • REST API      — `new VectorizeVectorStore({ accountId, apiKey, indexName, dimensions })`.
//     Talks to the v2 REST endpoints over fetch (works on Node, Bun, Workers).
//
// Two quirks the interface must paper over:
//   1. Vector ids are capped at 64 bytes, so a docId longer than that collapses
//      to a deterministic SHA-256 hex; the original docId always lives in
//      metadata so query results and remove(docId) still round-trip.
//   2. Vectorize has NO delete-by-filter — only deleteByIds. So the wholesale
//      removes (by node / indexer) are implemented query-then-delete: query a
//      zero vector with a metadata filter, collect the matched ids, delete them,
//      and repeat until a query comes back empty. This needs metadata indexes on
//      the filtered properties, which we create lazily on first use (REST) or
//      assume are provisioned out-of-band (binding).

import { VectorStore } from './vectorStore.js';
import { TroveError, wrapError } from '../errors.js';
import { withRetry } from '../retry.js';

// Reserved metadata keys — the routing columns, never treated as user fields.
const RESERVED = ['docId', 'nodeId', 'indexerId'];
// Vectorize caps topK at 20 when returnMetadata is "all" (full metadata is only
// returned for the top slice), so both querying and pagination stay within it.
const MAX_TOPK = 20;

export class VectorizeVectorStore extends VectorStore {
  /**
   * @param {object} cfg
   * @param {number} cfg.dimensions       vector dimensionality (required)
   * @param {object} [cfg.binding]        Workers Vectorize binding (binding mode)
   * @param {string} [cfg.accountId]      Cloudflare account id (REST mode)
   * @param {string} [cfg.apiKey]         API token, sent as Bearer (REST mode)
   * @param {string} [cfg.indexName]      Vectorize index name (REST mode)
   * @param {string} [cfg.namespace]      optional query namespace (REST mode)
   */
  constructor(cfg = {}) {
    super();
    if (!cfg.dimensions) throw TroveError.invalid('VectorizeVectorStore requires "dimensions"');
    this._dimensions = cfg.dimensions;
    this.binding = cfg.binding || null;
    if (!this.binding) {
      for (const k of ['accountId', 'apiKey', 'indexName']) {
        if (!cfg[k]) throw TroveError.invalid(`VectorizeVectorStore (REST mode) requires "${k}"`);
      }
      this._baseUrl = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/vectorize/v2/indexes/${cfg.indexName}`;
    }
    this.cfg = cfg;
    this._ready = null;
  }

  // --- transport ----------------------------------------------------------

  /** One REST call. Cloudflare wraps every response as { success, result, errors }. */
  async #req(path, body, { ndjson } = {}) {
    return withRetry(
      async () => {
        let res;
        try {
          res = await fetch(this._baseUrl + path, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.cfg.apiKey}`,
              'content-type': ndjson ? 'application/x-ndjson' : 'application/json',
            },
            body: ndjson ? body : body !== undefined ? JSON.stringify(body) : undefined,
          });
        } catch (err) {
          throw wrapError(err);
        }
        if (res.status === 429 || res.status >= 500) throw TroveError.transient(`Vectorize ${res.status}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) {
          const msg = json?.errors?.map?.((e) => e.message).filter(Boolean).join('; ') || res.status;
          throw TroveError.internal(`Vectorize ${path} failed: ${msg}`);
        }
        return json.result ?? {};
      },
      { retries: 3 },
    );
  }

  /** One binding RPC. Retried on transient classification; errors normalised. */
  async #binding(fn) {
    return withRetry(
      async () => {
        try {
          return await fn();
        } catch (err) {
          throw wrapError(err);
        }
      },
      { retries: 3 },
    );
  }

  /** Ensure the metadata indexes deletes rely on exist (idempotent). */
  async #ensure() {
    if (!this._ready) {
      this._ready = (async () => {
        // Binding mode: metadata indexes are provisioned out-of-band (wrangler),
        // so there is nothing to create — just proceed.
        if (this.binding) return;
        for (const propertyName of ['nodeId', 'indexerId']) {
          await this.#req('/metadata_index/create', { propertyName, indexType: 'string' }).catch((e) => {
            // Tolerate a metadata index that already exists; surface real errors.
            if (!/already|exist/i.test(e.message)) throw e;
          });
        }
      })();
    }
    return this._ready;
  }

  // --- writes -------------------------------------------------------------

  async add(docs) {
    if (!docs.length) return;
    await this.#ensure();
    const vectors = await Promise.all(
      docs.map(async (d) => ({
        id: await vectorId(d.id),
        values: Array.from(d.vector),
        metadata: buildMetadata(d),
      })),
    );
    if (this.binding) {
      await this.#binding(() => this.binding.upsert(vectors));
    } else {
      // Upsert body is NDJSON: one JSON vector object per line.
      const body = vectors.map((v) => JSON.stringify(v)).join('\n');
      await this.#req('/upsert', body, { ndjson: true });
    }
  }

  async remove(docId) {
    await this.#ensure();
    await this.#deleteByIds([await vectorId(docId)]);
  }

  async removeByNode(nodeId) {
    await this.#purge({ nodeId: { $eq: nodeId } });
  }
  async removeByIndexer(indexerId) {
    await this.#purge({ indexerId: { $eq: indexerId } });
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    await this.#purge({ nodeId: { $eq: nodeId }, indexerId: { $eq: indexerId } });
  }

  /**
   * Query-then-delete: Vectorize can't delete by filter, so page through the
   * matching vectors (topK capped at MAX_TOPK) and delete their ids until a
   * query returns nothing — so a file with many chunks is fully cleared.
   */
  async #purge(filter) {
    await this.#ensure();
    const zero = new Array(this._dimensions).fill(0);
    // Bounded loop guards against an eventually-consistent delete looping forever.
    for (let page = 0; page < 10000; page++) {
      const matches = await this.#queryRaw(zero, { topK: MAX_TOPK, filter });
      if (!matches.length) break;
      await this.#deleteByIds(matches.map((m) => m.id));
    }
  }

  async #deleteByIds(ids) {
    if (!ids.length) return;
    if (this.binding) await this.#binding(() => this.binding.deleteByIds(ids));
    else await this.#req('/delete_by_ids', { ids });
  }

  // --- reads --------------------------------------------------------------

  async query(vector, opts = {}) {
    await this.#ensure();
    const limit = opts.limit ?? 20;
    // Over-fetch a little (limit*4) but never past the returnMetadata="all" cap.
    const topK = Math.min(limit * 4, MAX_TOPK);
    const filter = opts.indexers?.length ? { indexerId: { $in: opts.indexers } } : undefined;
    const matches = await this.#queryRaw(vector, { topK, filter });
    return matches.slice(0, limit).map(toResult);
  }

  /** Raw nearest-neighbour lookup. Normalises the two match-envelope shapes. */
  async #queryRaw(vector, { topK, filter }) {
    const values = Array.from(vector);
    let res;
    if (this.binding) {
      res = await this.#binding(() =>
        this.binding.query(values, {
          topK,
          returnValues: false,
          returnMetadata: 'all',
          ...(filter ? { filter } : {}),
        }),
      );
    } else {
      res = await this.#req('/query', {
        vector: values,
        topK,
        returnValues: false,
        returnMetadata: 'all',
        ...(filter ? { filter } : {}),
        ...(this.cfg.namespace ? { namespace: this.cfg.namespace } : {}),
      });
    }
    // Both { matches } and { count, matches } are accepted.
    return res?.matches || [];
  }
}

// --- helpers --------------------------------------------------------------

/**
 * Vector id: ids must be ≤ 64 bytes. A short docId passes through so it stays
 * human-readable; a longer one collapses to a deterministic SHA-256 hex (64
 * chars) so remove(docId) recomputes the same id. The original docId always
 * lives in metadata regardless (see buildMetadata).
 */
async function vectorId(docId) {
  const bytes = new TextEncoder().encode(docId);
  if (bytes.length <= 64) return docId;
  const buf = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Metadata = routing keys + the flat, primitive user fields Vectorize can index. */
function buildMetadata(doc) {
  const md = { docId: doc.id, nodeId: doc.nodeId, indexerId: doc.indexerId };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    if (RESERVED.includes(k) || v == null) continue; // never let a field shadow a routing key
    const t = typeof v;
    // Vectorize metadata only stores flat primitives; skip nested objects/arrays.
    if (t === 'string' || t === 'number' || t === 'boolean') md[k] = v;
  }
  return md;
}

/** Map a Vectorize match to the VectorStore result shape (fields = non-reserved metadata). */
function toResult(m) {
  const md = m.metadata || {};
  const fields = {};
  for (const [k, v] of Object.entries(md)) if (!RESERVED.includes(k)) fields[k] = v;
  return { docId: md.docId, nodeId: md.nodeId, indexerId: md.indexerId, score: m.score, fields };
}

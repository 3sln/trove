// Durable search: a VectorStore over sqlite-vec and a KeywordStore over FTS5.
//
// The in-memory defaults were the single biggest gap between "works" and "runs": files
// and metadata persisted, the search index did not, and nothing rebuilt it — so a
// restart left a drive whose contents were all present and none of it findable. In an
// app where search IS the navigation, that is data loss in everything but name.
//
// Both stores live in the SAME SQLite file the metadata already uses (the `search` key,
// which LocalSqliteProvider co-locates with the main db), so the single-file self-host
// story holds: one file to back up, one file to move.
//
// They are constructed through a SqliteProvider rather than a raw handle, so nothing
// here is bound to bun:sqlite or node:sqlite — the provider is the seam, and a
// deployment on something else supplies its own.
//
// Availability differs between the two on purpose:
//   • FTS5 is compiled into both bun:sqlite and node:sqlite — always available.
//   • sqlite-vec is a loadable extension (a prebuilt native artifact per platform), so
//     it can be absent. `SqliteVectorStore.open()` returns null rather than throwing,
//     and the caller falls back to memory with a warning. A drive that can't do
//     semantic search should still start and still do keyword search.

import { TroveError } from '../errors.js';
import { tokenize, KeywordStore } from './keywordStore.js';
import { VectorStore } from './vectorStore.js';

/** The provider key both stores share; co-located with metadata in the main db file. */
export const SEARCH_DB_KEY = 'search';

// --- vectors -----------------------------------------------------------------

/**
 * Nearest-neighbour search over a sqlite-vec `vec0` table.
 *
 * sqlite-vec 0.1.x is exact brute force — no ANN index — so query cost is linear in
 * the number of chunks. That is a deliberate trade: it is ~3× faster than the JS
 * in-memory store (SIMD C vs a JS loop), holds no heap, and survives a restart.
 * Measured at 384 dimensions: 50k chunks → ~40 ms per query, ~76 MB on disk. Past a
 * few hundred thousand chunks the answer is an ANN store (Qdrant/Vectorize ship as
 * adapters already), not a bigger brute force.
 */
export class SqliteVectorStore extends VectorStore {
  /**
   * Open the store, or return null when the sqlite-vec extension isn't installed on
   * this platform. Null rather than a throw: missing semantic search is a degraded
   * deployment, not a broken one, and the caller decides what to fall back to.
   * @param {{provider: object, dimensions: number, key?: string}} opts
   * @returns {Promise<SqliteVectorStore|null>}
   */
  static async open({ provider, dimensions, key = SEARCH_DB_KEY }) {
    if (!provider) throw TroveError.invalid('SqliteVectorStore needs a SqliteProvider');
    if (!dimensions) throw TroveError.invalid('SqliteVectorStore needs the embedding dimensions');
    const db = await provider.obtain({ key });
    // The raw handle is needed to load an extension — that is not part of the
    // SqliteDatabase interface, and deliberately so: it is a local-backend concern.
    const raw = db.raw;
    if (!raw?.loadExtension && !raw?.enableLoadExtension) return null;
    let vec;
    try {
      vec = await import('sqlite-vec');
    } catch {
      return null; // dependency not installed
    }
    try {
      if (raw.enableLoadExtension) raw.enableLoadExtension(true);
      if (typeof vec.load === 'function') vec.load(raw);
      else raw.loadExtension(vec.getLoadablePath());
      await db.get('SELECT vec_version() AS v');
    } catch {
      return null; // extension present but unloadable here (wrong arch, disabled, …)
    }
    const store = new SqliteVectorStore(db, dimensions);
    await store.init();
    return store;
  }

  constructor(db, dimensions) {
    super();
    this.db = db;
    this._dimensions = dimensions;
  }

  async init() {
    // A vec0 table's dimension is fixed at CREATE time, so an index built for one
    // embedding provider is meaningless to another. Switching providers (or their
    // `dimensions`) has to drop the vectors — otherwise every insert would fail with a
    // dimension error and the drive would look broken rather than merely unindexed.
    // Dropping leaves the index empty, which is exactly the state the startup rebuild
    // watches for, so the vectors come back under the new model.
    await this.db.exec('CREATE TABLE IF NOT EXISTS vec_config (k TEXT PRIMARY KEY, v TEXT)');
    const prior = Number((await this.db.get("SELECT v FROM vec_config WHERE k = 'dimensions'"))?.v);
    if (prior && prior !== this._dimensions) {
      await this.db.exec('DROP TABLE IF EXISTS vec_docs; DROP TABLE IF EXISTS vec_meta;');
      console.warn(`[trove] embedding dimensions changed (${prior} → ${this._dimensions}) — the vector index was dropped and will be rebuilt`);
    }

    // vec0 holds the vectors; a plain sidecar table holds what we filter and return by.
    // They are kept in step by always writing/deleting through this class, and the
    // sidecar is what `removeByNode`/`removeByIndexer` scan — a vec0 table can't be
    // queried by a non-vector predicate in 0.1.x.
    await this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs USING vec0(
        doc_id TEXT PRIMARY KEY,
        embedding float[${this._dimensions}]
      );
      CREATE TABLE IF NOT EXISTS vec_meta (
        doc_id TEXT PRIMARY KEY,
        nodeId TEXT NOT NULL,
        indexerId TEXT NOT NULL,
        fields TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_vec_meta_node ON vec_meta(nodeId);
      CREATE INDEX IF NOT EXISTS idx_vec_meta_indexer ON vec_meta(indexerId);
    `);
    await this.db.run("INSERT INTO vec_config(k, v) VALUES ('dimensions', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(this._dimensions));
  }

  async add(docs) {
    for (const doc of docs) {
      const vector = toF32(doc.vector);
      if (vector.length !== this._dimensions) {
        throw TroveError.invalid(`Vector dim ${vector.length} != index dim ${this._dimensions}`);
      }
      // vec0 has no UPSERT, so a re-index deletes then inserts.
      await this.remove(doc.id);
      await this.db.batch([
        { sql: 'INSERT INTO vec_docs(doc_id, embedding) VALUES (?, ?)', params: [doc.id, bytesOf(vector)] },
        {
          sql: 'INSERT INTO vec_meta(doc_id, nodeId, indexerId, fields) VALUES (?,?,?,?)',
          params: [doc.id, doc.nodeId, doc.indexerId, JSON.stringify(doc.fields || {})],
        },
      ]);
    }
  }

  async remove(docId) {
    await this.db.batch([
      { sql: 'DELETE FROM vec_docs WHERE doc_id = ?', params: [docId] },
      { sql: 'DELETE FROM vec_meta WHERE doc_id = ?', params: [docId] },
    ]);
  }

  async removeByNode(nodeId) {
    await this.#removeWhere('nodeId = ?', [nodeId]);
  }
  async removeByIndexer(indexerId) {
    await this.#removeWhere('indexerId = ?', [indexerId]);
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    await this.#removeWhere('nodeId = ? AND indexerId = ?', [nodeId, indexerId]);
  }
  async #removeWhere(where, params) {
    const rows = await this.db.all(`SELECT doc_id FROM vec_meta WHERE ${where}`, ...params);
    if (!rows.length) return;
    await this.db.batch([
      ...rows.map((r) => ({ sql: 'DELETE FROM vec_docs WHERE doc_id = ?', params: [r.doc_id] })),
      { sql: `DELETE FROM vec_meta WHERE ${where}`, params },
    ]);
  }

  async query(vector, opts = {}) {
    const limit = opts.limit ?? 40;
    const allow = opts.indexers?.length ? new Set(opts.indexers) : null;
    // KNN runs over every vector, so an indexer filter can't narrow the scan in 0.1.x.
    // Over-fetch and filter after, rather than returning fewer than `limit` — a caller
    // that asked for 40 and got 3 because 37 belonged to another indexer would look
    // like a drive with nothing in it.
    const k = allow ? Math.min(limit * 8, 1000) : limit;
    const rows = await this.db.all(
      `SELECT d.doc_id AS docId, d.distance AS distance, m.nodeId, m.indexerId, m.fields
         FROM vec_docs d JOIN vec_meta m ON m.doc_id = d.doc_id
        WHERE d.embedding MATCH ? AND k = ?
        ORDER BY d.distance`,
      bytesOf(toF32(vector)), k,
    );
    const out = [];
    for (const r of rows) {
      if (allow && !allow.has(r.indexerId)) continue;
      out.push({
        docId: r.docId, nodeId: r.nodeId, indexerId: r.indexerId,
        // vec0 returns L2 distance over normalised vectors; cosine similarity is
        // 1 - d²/2, which keeps scores comparable with the other stores' 0..1.
        score: 1 - (r.distance * r.distance) / 2,
        fields: parseJson(r.fields),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async count() {
    return (await this.db.get('SELECT COUNT(*) AS n FROM vec_meta'))?.n ?? 0;
  }
}

// --- keywords ----------------------------------------------------------------

/**
 * Lexical search over FTS5, which is compiled into both bun:sqlite and node:sqlite —
 * no extension, no dependency, nothing to install. This is the half that makes
 * "find the file I named X" work, and it was being lost on restart just like the
 * vectors.
 */
export class SqliteKeywordStore extends KeywordStore {
  static async open({ provider, key = SEARCH_DB_KEY }) {
    if (!provider) throw TroveError.invalid('SqliteKeywordStore needs a SqliteProvider');
    const store = new SqliteKeywordStore(await provider.obtain({ key }));
    await store.init();
    return store;
  }

  constructor(db) {
    super();
    this.db = db;
    this._nextRowid = 1;
  }

  async init() {
    // `content` is indexed; the rest are UNINDEXED so they're stored and returnable
    // without polluting the term index.
    //
    // The `kw_meta` sidecar exists for DELETES, and it is the difference between a
    // drive that stays fast and one that doesn't. An FTS5 table can only be searched by
    // its term index — a predicate on an UNINDEXED column is a full scan of every row.
    // Every single write re-indexes a node, which means deleting its old rows first, so
    // without this each upload costs a scan of the entire index and the drive slows
    // down in proportion to how much is in it. Measured: uploading 2,000 files took
    // 14s for the first 500 and 40s for the last 500, purely from this.
    //
    // With the sidecar, a delete is an indexed lookup followed by `WHERE rowid = ?`,
    // which is the one predicate FTS5 answers directly.
    await this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kw_docs USING fts5(
        content,
        body UNINDEXED,
        doc_id UNINDEXED,
        nodeId UNINDEXED,
        indexerId UNINDEXED,
        fields UNINDEXED,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS kw_meta (
        doc_id TEXT PRIMARY KEY,
        rid INTEGER NOT NULL,
        nodeId TEXT NOT NULL,
        indexerId TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kw_meta_node ON kw_meta(nodeId);
      CREATE INDEX IF NOT EXISTS idx_kw_meta_indexer ON kw_meta(indexerId);
      CREATE INDEX IF NOT EXISTS idx_kw_meta_node_indexer ON kw_meta(nodeId, indexerId);
    `);
    // Rowids are assigned here rather than by SQLite so a batched insert doesn't have to
    // read last_insert_rowid() back between statements. Seeded from what's on disk, so
    // reopening an existing index continues rather than colliding.
    const max = await this.db.get('SELECT MAX(rid) AS m FROM kw_meta');
    this._nextRowid = (max?.m ?? 0) + 1;

    // An index written before kw_meta existed has rows the sidecar doesn't know about.
    // Backfill it once rather than silently leaking those rows forever — they would
    // never be deleted, so a re-index would double-count every document.
    const orphaned = await this.db.get(
      'SELECT COUNT(*) AS n FROM kw_docs WHERE rowid NOT IN (SELECT rid FROM kw_meta)',
    );
    if (orphaned?.n) await this.#adoptExistingRows();
  }

  /** Bring pre-sidecar rows under management (one-time, on upgrade). */
  async #adoptExistingRows() {
    const rows = await this.db.all(
      'SELECT rowid AS rid, doc_id, nodeId, indexerId FROM kw_docs WHERE rowid NOT IN (SELECT rid FROM kw_meta)',
    );
    if (!rows.length) return;
    await this.db.batch(rows.map((r) => ({
      sql: 'INSERT INTO kw_meta(doc_id, rid, nodeId, indexerId) VALUES (?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET rid = excluded.rid',
      params: [r.doc_id, r.rid, r.nodeId, r.indexerId],
    })));
    const max = await this.db.get('SELECT MAX(rid) AS m FROM kw_meta');
    this._nextRowid = (max?.m ?? 0) + 1;
    console.warn(`[trove] adopted ${rows.length} pre-existing keyword rows into the delete index`);
  }

  async add(docs) {
    if (!docs.length) return;
    // Resolve the rowids of anything being replaced first — an indexed lookup, not a
    // scan of the term index.
    const ids = docs.map((d) => d.id);
    const existing = await this.db.all(
      `SELECT doc_id, rid FROM kw_meta WHERE doc_id IN (${ids.map(() => '?').join(',')})`,
      ...ids,
    );
    const statements = [];
    for (const row of existing) statements.push({ sql: 'DELETE FROM kw_docs WHERE rowid = ?', params: [row.rid] });
    for (const d of docs) {
      const body = d.text || '';
      // `content` is what gets INDEXED — the text plus the field values, so a search
      // for a filename finds the chunk. `body` is what gets SHOWN, kept separate so a
      // snippet is the document's prose and not prose with metadata glued on.
      const content = [body, ...Object.values(d.fields || {})].join(' ');
      const rid = this._nextRowid++;
      statements.push({
        sql: 'INSERT INTO kw_docs(rowid, content, body, doc_id, nodeId, indexerId, fields) VALUES (?,?,?,?,?,?,?)',
        params: [rid, content, body, d.id, d.nodeId, d.indexerId, JSON.stringify(d.fields || {})],
      });
      statements.push({
        sql: 'INSERT INTO kw_meta(doc_id, rid, nodeId, indexerId) VALUES (?,?,?,?) '
          + 'ON CONFLICT(doc_id) DO UPDATE SET rid = excluded.rid, nodeId = excluded.nodeId, indexerId = excluded.indexerId',
        params: [d.id, rid, d.nodeId, d.indexerId],
      });
    }
    await this.db.batch(statements);
  }

  async removeByNode(nodeId) {
    await this.#removeWhere('nodeId = ?', [nodeId]);
  }
  async removeByIndexer(indexerId) {
    await this.#removeWhere('indexerId = ?', [indexerId]);
  }
  async removeByNodeIndexer(nodeId, indexerId) {
    await this.#removeWhere('nodeId = ? AND indexerId = ?', [nodeId, indexerId]);
  }
  /** Indexed lookup in the sidecar, then delete by rowid — the one predicate FTS5 answers. */
  async #removeWhere(where, params) {
    const rows = await this.db.all(`SELECT rid FROM kw_meta WHERE ${where}`, ...params);
    if (!rows.length) return;
    await this.db.batch([
      ...rows.map((r) => ({ sql: 'DELETE FROM kw_docs WHERE rowid = ?', params: [r.rid] })),
      { sql: `DELETE FROM kw_meta WHERE ${where}`, params },
    ]);
  }

  async search(query, opts = {}) {
    const match = toMatchQuery(query);
    if (!match) return [];
    const params = [match];
    let where = 'kw_docs MATCH ?';
    if (opts.indexers?.length) {
      where += ` AND indexerId IN (${opts.indexers.map(() => '?').join(',')})`;
      params.push(...opts.indexers);
    }
    params.push(opts.limit ?? 40);
    const rows = await this.db.all(
      `SELECT doc_id AS docId, nodeId, indexerId, fields, bm25(kw_docs) AS rank
         FROM kw_docs WHERE ${where} ORDER BY rank LIMIT ?`,
      ...params,
    );
    // bm25() is negative, better = more negative. The rest of the system works in
    // 0..1-where-higher-is-better, so map into that shape rather than leaking one
    // store's convention into the blend in SearchService.
    return rows.map((r) => ({
      docId: r.docId, nodeId: r.nodeId, indexerId: r.indexerId,
      score: scoreFromBm25(r.rank), fields: parseJson(r.fields),
    }));
  }

  /**
   * A window of the document's prose around the first matching term.
   *
   * Built by hand rather than with FTS5's `snippet()`: that only works on INDEXED
   * columns, and the indexed column deliberately has the field values appended, so it
   * would show "…the spice melange dune.txt". The reader wants the prose. This also
   * matches MemoryKeywordStore's excerpt exactly, so swapping stores doesn't change
   * what a result looks like.
   */
  async snippet(docId, query) {
    // Via the sidecar, for the same reason deletes go through it: `doc_id` is an
    // UNINDEXED FTS5 column, so looking a document up by it scans the whole index. One
    // snippet per result row means a page of results was doing forty full scans — the
    // single largest cost in a search, and it grew with the drive.
    const meta = await this.db.get('SELECT rid FROM kw_meta WHERE doc_id = ?', docId);
    if (!meta) return null;
    const row = await this.db.get('SELECT body FROM kw_docs WHERE rowid = ?', meta.rid);
    const text = row?.body;
    if (!text) return null;
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of tokenize(query)) {
      const i = lower.indexOf(t);
      if (i >= 0) { at = i; break; }
    }
    if (at < 0) return text.slice(0, 160).trim();
    const start = Math.max(0, at - 60);
    return (start > 0 ? '…' : '') + text.slice(start, start + 200).trim() + '…';
  }

  async count() {
    // Counts the REAL index, not the sidecar. The sidecar is a delete index; it is not
    // authoritative about what the index contains, and the two can drift — a restore
    // that lost the FTS table, or someone clearing it by hand. Since the only caller is
    // the startup "was the index lost?" check, an honest answer is worth more than the
    // cheaper one: reading the sidecar would report a full index sitting on top of no
    // content, and the rebuild that exists for exactly that case would never fire.
    return (await this.db.get('SELECT COUNT(*) AS n FROM kw_docs'))?.n ?? 0;
  }
}

// --- helpers -----------------------------------------------------------------

function toF32(v) {
  return v instanceof Float32Array ? v : Float32Array.from(v);
}
function bytesOf(f32) {
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
function parseJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

/**
 * Turn a user's raw words into an FTS5 MATCH expression.
 *
 * The input is untrusted and FTS5's query syntax is full of operators (`"`, `*`, `^`,
 * `NEAR`, `OR`), so a raw string can be a syntax error — which would surface as a
 * failed search rather than no results. Every token is quoted as a literal and joined
 * with OR, matching the in-memory store's "score by term coverage" behaviour.
 */
function toMatchQuery(query) {
  const terms = tokenize(query);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * Map BM25 (negative, lower is better) onto 0..1 with higher better, FLOORED at 0.5.
 *
 * The floor matters. BM25's IDF term is zero when a term appears in every document, so
 * on a small drive — exactly the case for a new self-host — every match scores 0 and
 * contributes nothing to the hybrid blend, making keyword search silently useless
 * until the corpus grows. A match is evidence regardless of how common the term is, so
 * matching at all is worth 0.5 and BM25 ranks within the matches. This also keeps the
 * band comparable to MemoryKeywordStore's term-coverage score, so swapping stores
 * doesn't shift the semantic/keyword balance.
 */
function scoreFromBm25(rank) {
  const r = typeof rank === 'number' && rank < 0 ? -rank : 0;
  return 0.5 + 0.5 * (r / (r + 1)); // saturating: one huge score can't dominate
}

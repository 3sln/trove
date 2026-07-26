// SQLite-backed MetadataStore using Node's built-in `node:sqlite` (no native build
// step). Suitable for single-node self-hosting on filesystem/NAS/S3. There is no
// hierarchy to model: one flat table of items, unique per (collectionId, name).
// `meta` and `facets` are JSON columns, and the outbound `trove:` links the links
// indexer records live inside `facets`, so backlinks are a json_each query rather
// than a second table. FTS over names is a LIKE index; SearchService layers semantic
// search on top.

import {
  MetadataStore, MERGED_TAGS, LINKS_CONTRIBUTOR, LINKS_KEY,
  mergeContributionTags, splitContributions, applyContribution, rawFacetsFromNode,
} from './interface.js';
import { TroveError, wrapError } from '../errors.js';
import { newId } from '../util.js';
import { decodeCursor, encodeCursor } from './cursor.js';

export class SqliteStore extends MetadataStore {
  /**
   * @param {{ provider?: object, key?: string, database?: object }} opts
   *   `provider` is a SqliteProvider; `key` names this store's db (default
   *   'metadata'). Or pass a ready `database` (a SqliteDatabase) directly.
   */
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this.key = opts.key ?? 'metadata';
    this.db = opts.database ?? null;
  }

  async init() {
    if (!this.db) {
      if (!this._opts.provider) throw TroveError.invalid('SqliteStore needs a provider or database');
      this.db = await this._opts.provider.obtain({ key: this.key });
    }
    await this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        contentType TEXT,
        storageKey TEXT,
        etag TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        facets TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_updated ON nodes(updatedAt);
    `);
    await this.#migrate();
  }

  /**
   * Add `deletedAt` (the trash) to a database that predates it.
   *
   * The name-uniqueness index has to become PARTIAL as part of the same step. A trashed
   * item still holds its row, so under the old unconditional index deleting `notes.md`
   * would block ever creating another `notes.md` — the trash would take the name hostage.
   * `WHERE deletedAt IS NULL` scopes uniqueness to the live drive, which is where it
   * means something.
   */
  async #migrate() {
    const cols = await this.db.all('PRAGMA table_info(nodes)');
    if (!cols.some((c) => c.name === 'deletedAt')) {
      await this.db.exec('ALTER TABLE nodes ADD COLUMN deletedAt INTEGER');
    }
    // Recreating the index is cheap and idempotent; naming the new one differently is
    // what makes "has this run?" answerable without a migrations table.
    await this.db.exec(`
      DROP INDEX IF EXISTS idx_nodes_coll_name;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_live_name ON nodes(collectionId, name) WHERE deletedAt IS NULL;
      CREATE INDEX IF NOT EXISTS idx_nodes_deleted ON nodes(deletedAt);
    `);
  }

  async getById(id) {
    return row(await this.db.get('SELECT * FROM nodes WHERE id = ?', id));
  }
  async getByName(collectionId = 'default', name) {
    // Live items only: a trashed `notes.md` must not answer a link or a name lookup, or
    // deleting something would leave it silently reachable.
    return row(await this.db.get(
      'SELECT * FROM nodes WHERE collectionId = ? AND name = ? AND deletedAt IS NULL', collectionId, name,
    ));
  }

  async listItems(collectionId = 'default', opts = {}) {
    // Resolve ONCE and use the resolved name everywhere, cursor included. Encoding the
    // cursor under the caller's raw string while querying by the mapped column made
    // `?sort=createdAt` compare `name > <timestamp>` — and TEXT always sorts above
    // INTEGER in SQLite, so the predicate was always true and paging never terminated:
    // the same first row, forever.
    const sortCol = { name: 'name', size: 'size', updatedAt: 'updatedAt' }[opts.sort] || 'name';
    const dir = opts.order === 'desc' ? 'DESC' : 'ASC';
    const cmp = dir === 'DESC' ? '<' : '>';
    // NOCASE is a text collation and a no-op on the numeric columns, so one expression
    // serves all three — and it has to be the SAME expression in ORDER BY and in the
    // keyset comparison, or the page boundary won't line up with the ordering.
    const key = sortCol === 'name' ? `${sortCol} COLLATE NOCASE` : sortCol;
    const limit = opts.limit ?? 500;
    const at = decodeCursor(sortCol, opts.cursor);
    // Keyset, not OFFSET: resume from the last row of the previous page, so an insert
    // or delete before the cut can't shift a row past it unseen. `id` breaks ties.
    const where = at ? `AND (${key} ${cmp} ? OR (${key} = ? AND id ${cmp} ?))` : '';
    const args = at ? [at.value, at.value, at.id] : [];
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE collectionId = ? AND deletedAt IS NULL ${where}
       ORDER BY ${key} ${dir}, id ${dir}
       LIMIT ?`,
      collectionId, ...args, limit + 1,
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(row);
    return {
      items: page,
      nextCursor: hasMore ? encodeCursor(sortCol, page[page.length - 1]) : null,
    };
  }

  async create(node) {
    if (!node.name) throw TroveError.invalid('An item needs a name');
    const now = Date.now();
    const full = {
      id: node.id || newId('itm'),
      collectionId: node.collectionId || 'default', name: node.name,
      size: node.size ?? 0, contentType: node.contentType ?? null,
      storageKey: node.storageKey ?? null, etag: node.etag ?? null,
      createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: rawFacetsFromNode(node),
    };
    try {
      await this.db.run(
        `INSERT INTO nodes (id,collectionId,name,size,contentType,storageKey,etag,createdAt,updatedAt,meta,facets)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        full.id, full.collectionId, full.name, full.size,
        full.contentType, full.storageKey, full.etag, full.createdAt, full.updatedAt,
        JSON.stringify(full.meta), JSON.stringify(full.facets),
      );
      return full;
    } catch (err) {
      if (String(err?.message || '').includes('UNIQUE')) throw TroveError.alreadyExists(node.name, { cause: err });
      throw wrapError(err);
    }
  }

  async update(id, patch) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Node');
    const next = { ...node };
    for (const k of ['size', 'contentType', 'storageKey', 'etag', 'meta']) {
      if (k in patch) next[k] = patch[k];
    }
    next.updatedAt = Date.now();
    await this.db.run(
      `UPDATE nodes SET size=?, contentType=?, storageKey=?, etag=?, meta=?, updatedAt=? WHERE id=?`,
      next.size, next.contentType, next.storageKey, next.etag, JSON.stringify(next.meta), next.updatedAt, id,
    );
    return next;
  }

  /** Permanently forget an item. The trash is a VFS concern; this is the real delete. */
  async remove(id) {
    await this.db.run('DELETE FROM nodes WHERE id = ?', id);
  }

  async softDelete(id, at = Date.now()) {
    await this.db.run('UPDATE nodes SET deletedAt = ?, updatedAt = ? WHERE id = ?', at, at, id);
    return this.getById(id);
  }
  async restore(id, newName = null) {
    try {
      if (newName) {
        await this.db.run('UPDATE nodes SET deletedAt = NULL, name = ?, updatedAt = ? WHERE id = ?', newName, Date.now(), id);
      } else {
        await this.db.run('UPDATE nodes SET deletedAt = NULL, updatedAt = ? WHERE id = ?', Date.now(), id);
      }
    } catch (err) {
      // The partial unique index fires here when the name was taken while it was away.
      if (String(err?.message || '').includes('UNIQUE')) throw TroveError.alreadyExists(newName || id, { cause: err });
      throw wrapError(err);
    }
    return this.getById(id);
  }
  /** Trashed items, newest first — the order someone looking for a mistake wants. */
  async listTrash(collectionId, { limit = 200, before = null } = {}) {
    const where = ['deletedAt IS NOT NULL'];
    const params = [];
    if (collectionId) { where.push('collectionId = ?'); params.push(collectionId); }
    if (before) { where.push('deletedAt < ?'); params.push(before); }
    params.push(limit);
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY deletedAt DESC LIMIT ?`, ...params,
    );
    return rows.map(row);
  }
  /** Items trashed before `cutoff` — what the purge sweep collects. */
  async trashedStorageKeys(collectionId) {
    const rows = await this.db.all(
      'SELECT storageKey FROM nodes WHERE collectionId = ? AND deletedAt IS NOT NULL AND storageKey IS NOT NULL',
      collectionId,
    );
    return new Set(rows.map((r) => r.storageKey));
  }

  async trashedBefore(cutoff, limit = 500) {
    const rows = await this.db.all(
      'SELECT * FROM nodes WHERE deletedAt IS NOT NULL AND deletedAt < ? ORDER BY deletedAt ASC LIMIT ?',
      cutoff, limit,
    );
    return rows.map(row);
  }

  async rename(id, newName) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Item');
    if (!newName) throw TroveError.invalid('An item needs a name');
    if (newName === node.name) return node;
    try {
      await this.db.run('UPDATE nodes SET name=?, updatedAt=? WHERE id=?', newName, Date.now(), id);
    } catch (err) {
      if (String(err?.message || '').includes('UNIQUE')) throw TroveError.alreadyExists(newName, { cause: err });
      throw wrapError(err);
    }
    return this.getById(id);
  }

  // Read the raw contributions JSON (with the reserved merged-tags key intact).
  async #rawFacets(id) {
    const r = await this.db.get('SELECT facets FROM nodes WHERE id=?', id);
    if (!r) throw TroveError.notFound('Node');
    return r.facets ? JSON.parse(r.facets) : {};
  }

  async setContribution(id, contributorId, contribution) {
    const raw = applyContribution(await this.#rawFacets(id), contributorId, contribution);
    await this.db.run('UPDATE nodes SET facets=?, updatedAt=? WHERE id=?', JSON.stringify(raw), Date.now(), id);
    return this.getById(id);
  }

  async clearContribution(id, contributorId) {
    let raw;
    try { raw = await this.#rawFacets(id); } catch { return; }
    const { [contributorId]: _drop, ...rest } = raw;
    rest[MERGED_TAGS] = mergeContributionTags(rest);
    await this.db.run('UPDATE nodes SET facets=? WHERE id=?', JSON.stringify(rest), id);
  }

  async searchByName(query, opts = {}) {
    const clause = opts.collectionId ? 'AND collectionId = ?' : '';
    const params = ['%' + escapeLike(query) + '%'];
    if (opts.collectionId) params.push(opts.collectionId);
    params.push(opts.limit ?? 50);
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE deletedAt IS NULL AND name LIKE ? ESCAPE '\\' COLLATE NOCASE ${clause} LIMIT ?`,
      ...params,
    );
    return rows.map(row);
  }

  async scanItems({ afterId = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (afterId) { where.push('id > ?'); params.push(afterId); }
    params.push(limit);
    where.push('deletedAt IS NULL'); // sweeps operate on the live drive
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`, ...params,
    );
    return rows.map(row);
  }

  async countItems(collectionId) {
    const row = collectionId
      ? await this.db.get('SELECT COUNT(*) AS n FROM nodes WHERE collectionId = ? AND deletedAt IS NULL', collectionId)
      : await this.db.get('SELECT COUNT(*) AS n FROM nodes WHERE deletedAt IS NULL');
    return row?.n ?? 0;
  }

  async collectionStats(collectionId = 'default') {
    const row = await this.db.get(
      'SELECT COUNT(*) AS items, COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE collectionId = ? AND deletedAt IS NULL',
      collectionId,
    );
    const trash = await this.db.get(
      'SELECT COUNT(*) AS n FROM nodes WHERE collectionId = ? AND deletedAt IS NOT NULL', collectionId,
    );
    return { items: row?.items ?? 0, bytes: row?.bytes ?? 0, trashed: trash?.n ?? 0 };
  }

  async findByTags(filters = [], opts = {}) {
    const where = ['deletedAt IS NULL']; // the trash is not part of the drive

    const params = [];
    for (const f of filters) {
      const { sql, args } = tagCondition(f);
      where.push(sql);
      params.push(...args);
    }
    if (opts.q) { where.push(`name LIKE ? ESCAPE '\\' COLLATE NOCASE`); params.push('%' + escapeLike(opts.q) + '%'); }
    // `?.length` here was a whole-drive read: the server passes [] to mean "you may see
    // NOTHING" (a collection you can't read, or one that doesn't exist), and a falsy
    // length turned that into "don't scope at all". Undefined means unscoped; an array
    // — empty or not — is the exact set allowed.
    if (opts.collectionIds) {
      // `IN ()` is a syntax error in SQLite, so the empty case is spelled out.
      if (!opts.collectionIds.length) where.push('1 = 0');
      else {
        where.push(`collectionId IN (${opts.collectionIds.map(() => '?').join(',')})`);
        params.push(...opts.collectionIds);
      }
    }
    params.push(opts.limit ?? 100);
    const rows = await this.db.all(`SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC LIMIT ?`, ...params);
    return rows.map(row);
  }

  /**
   * Backlinks. The links indexer stores an item's outbound `trove:` URIs as a JSON
   * array inside `facets`, so "who links here" is an EXISTS over json_each of that
   * array — no join table to keep in step with the contribution that owns the data.
   */
  async findLinksTo(uris = [], opts = {}) {
    if (!uris.length) return [];
    const linksPath = `$."${LINKS_CONTRIBUTOR}".metadata."${LINKS_KEY}"`;
    const where = [
      'deletedAt IS NULL', // a trashed document must not still be listed as linking here
      `EXISTS (SELECT 1 FROM json_each(json_extract(facets, ?)) WHERE json_each.value IN (${uris.map(() => '?').join(',')}))`,
    ];
    const params = [linksPath, ...uris];
    if (opts.collectionIds) { // empty array = nothing readable; see findByTags
      if (!opts.collectionIds.length) where.push('1 = 0');
      else {
        where.push(`collectionId IN (${opts.collectionIds.map(() => '?').join(',')})`);
        params.push(...opts.collectionIds);
      }
    }
    params.push(opts.limit ?? 100);
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY updatedAt DESC LIMIT ?`, ...params,
    );
    return rows.map(row);
  }

  // The provider owns the db handle's lifecycle; just drop our reference.
  async close() {
    this.db = null;
  }
}

function row(r) {
  if (!r) return null;
  const { contributions, tags } = splitContributions(r.facets ? JSON.parse(r.facets) : {});
  const out = { ...r, meta: r.meta ? JSON.parse(r.meta) : {}, contributions, tags };
  delete out.facets; // internal column name; exposed as contributions + tags
  return out;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * One filter, as SQL — written to agree with `search/tagMatch.js`, which is the single
 * definition of what a tag filter means.
 *
 * Three ways this used to disagree with every other matcher in the drive, all of them
 * silent wrong answers rather than errors:
 *
 *   - `String(f.value)` was bound against `json_extract`, which PRESERVES JSON types. A
 *     numeric tag (`pages: 120`, or the built-in `links` count) compared integer against
 *     text, so `#pages:120` matched nothing and `#pages:!=120` matched the file.
 *   - `present` was `IS NOT NULL`, so a tag explicitly set to `false` counted as present.
 *   - `meta` was never consulted at all, though the store interface documents a filter as
 *     matching "a node's merged tags (+ meta)" and both other matchers include it.
 */
function tagCondition(f) {
  const key = String(f.key).replace(/["\\]/g, '');
  const tagPath = '$."' + MERGED_TAGS + '"."' + key + '"';
  const metaPath = '$."' + key + '"';
  // Merged tags win over meta — the same precedence as `{ ...meta, ...tags }`.
  const val = 'COALESCE(json_extract(facets, ?), json_extract(meta, ?))';
  const type = "COALESCE(json_type(facets, ?), json_type(meta, ?))";
  const paths = [tagPath, metaPath];

  if (f.present) {
    // Exists, and is neither `false` nor the empty string.
    return {
      sql: `(${type} IS NOT NULL AND ${type} != 'false' AND ${val} != '')`,
      args: [...paths, ...paths, ...paths],
    };
  }

  const nb = Number(f.value);
  const numeric = f.value !== '' && f.value != null && !Number.isNaN(nb);
  const op = { '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }[f.op] || '=';
  const textCmp = `LOWER(CAST(${val} AS TEXT)) ${op} LOWER(?)`;
  const textArgs = [...paths, String(f.value)];

  // A non-numeric filter value can only ever match textually, so emit only that branch.
  if (!numeric) return { sql: `(${val} IS NOT NULL AND ${textCmp})`, args: [...paths, ...textArgs] };

  // Numeric filter value: compare numerically when the STORED value is a number too,
  // textually otherwise — exactly what matchesFilter does.
  return {
    sql: `(${val} IS NOT NULL AND CASE WHEN ${type} IN ('integer','real')`
      + ` THEN ${val} ${op} ? ELSE ${textCmp} END)`,
    args: [...paths, ...paths, ...paths, nb, ...textArgs],
  };
}

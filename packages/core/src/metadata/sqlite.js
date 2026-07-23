// SQLite-backed MetadataStore using Node's built-in `node:sqlite` (no native
// build step). Suitable for single-node self-hosting on filesystem/NAS/S3. The
// tree is stored as adjacency (parentId) plus a denormalised `path` for O(1)
// lookups; moves rewrite descendant paths inside a transaction. `meta` and
// `facets` are JSON columns. FTS over names is provided via a LIKE index; the
// SearchService layers semantic search on top.

import { MetadataStore } from './interface.js';
import { TroveError, wrapError } from '../errors.js';
import { newId, joinPath, normalizePath } from '../util.js';

const ROOT_ID = 'root';

export class SqliteStore extends MetadataStore {
  /** @param {{path?: string, database?: object}} opts path to db file, or ':memory:' */
  constructor(opts = {}) {
    super();
    this._opts = opts;
    this.db = null;
  }

  async init() {
    if (!this.db) {
      let DatabaseSync;
      try {
        ({ DatabaseSync } = await import('node:sqlite'));
      } catch (err) {
        throw TroveError.unsupported(
          'node:sqlite unavailable — use Node ≥ 22.5 with --experimental-sqlite, or supply another MetadataStore',
          { cause: err },
        );
      }
      this.db = this._opts.database ?? new DatabaseSync(this._opts.path ?? ':memory:');
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        parentId TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        contentType TEXT,
        storageKey TEXT,
        etag TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        facets TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_parent_name ON nodes(parentId, name);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    `);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nodes (id,parentId,name,path,kind,size,createdAt,updatedAt,meta,facets)
         VALUES (?,?,?,?,?,?,?,?,'{}','{}')`,
      )
      .run(ROOT_ID, null, '', '/', 'folder', 0, now, now);
  }

  #get(sql) {
    return this.db.prepare(sql);
  }

  async getById(id) {
    return row(this.#get('SELECT * FROM nodes WHERE id = ?').get(id));
  }
  async getByPath(path) {
    return row(this.#get('SELECT * FROM nodes WHERE path = ?').get(normalizePath(path)));
  }

  async listChildren(parentId, opts = {}) {
    const parent = this.#get('SELECT id FROM nodes WHERE id = ?').get(parentId);
    if (!parent) throw TroveError.notFound('Folder');
    const sortCol = { name: 'name', size: 'size', updatedAt: 'updatedAt' }[opts.sort] || 'name';
    const dir = opts.order === 'desc' ? 'DESC' : 'ASC';
    const limit = opts.limit ?? 500;
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    // Folders first, then requested sort. COLLATE NOCASE for human-friendly names.
    const rows = this.#get(
      `SELECT * FROM nodes WHERE parentId = ?
       ORDER BY (kind='folder') DESC, ${sortCol} COLLATE NOCASE ${dir}
       LIMIT ? OFFSET ?`,
    ).all(parentId, limit + 1, offset);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row);
    return { items, nextCursor: hasMore ? String(offset + limit) : null };
  }

  async create(node) {
    try {
      const parent = node.parentId ? this.#get('SELECT * FROM nodes WHERE id = ?').get(node.parentId) : null;
      if (node.parentId && !parent) throw TroveError.notFound('Parent folder');
      if (parent && parent.kind !== 'folder') throw TroveError.invalid('Parent is not a folder');
      const path = parent ? joinPath(parent.path, node.name) : normalizePath('/' + node.name);
      const now = Date.now();
      const full = {
        id: node.id || newId(node.kind === 'folder' ? 'fld' : 'fil'),
        parentId: node.parentId, name: node.name, path, kind: node.kind,
        size: node.size ?? 0, contentType: node.contentType ?? null,
        storageKey: node.storageKey ?? null, etag: node.etag ?? null,
        createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: node.facets ?? {},
      };
      this.#get(
        `INSERT INTO nodes (id,parentId,name,path,kind,size,contentType,storageKey,etag,createdAt,updatedAt,meta,facets)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        full.id, full.parentId, full.name, full.path, full.kind, full.size,
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
    this.#get(
      `UPDATE nodes SET size=?, contentType=?, storageKey=?, etag=?, meta=?, updatedAt=? WHERE id=?`,
    ).run(next.size, next.contentType, next.storageKey, next.etag, JSON.stringify(next.meta), next.updatedAt, id);
    return next;
  }

  async remove(id) {
    this.#get('DELETE FROM nodes WHERE id = ?').run(id);
  }

  async descendants(id) {
    const self = await this.getById(id);
    if (!self) return [];
    // Path-prefix query gets the whole subtree in one shot.
    const prefix = self.path === '/' ? '/' : self.path + '/';
    const rows = this.#get(`SELECT * FROM nodes WHERE path LIKE ? ESCAPE '\\' AND id != ?`).all(
      escapeLike(prefix) + '%',
      id,
    );
    return rows.map(row);
  }

  async move(id, newParentId, newName) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Node');
    const parent = await this.getById(newParentId);
    if (!parent) throw TroveError.notFound('Destination folder');
    if (parent.kind !== 'folder') throw TroveError.invalid('Destination is not a folder');
    const name = newName || node.name;
    const newPath = joinPath(parent.path, name);
    if (newPath === node.path && newParentId === node.parentId) return node;

    const tx = this.db;
    tx.exec('BEGIN');
    try {
      const oldPrefix = node.path + '/';
      const now = Date.now();
      tx.prepare('UPDATE nodes SET parentId=?, name=?, path=?, updatedAt=? WHERE id=?').run(
        newParentId, name, newPath, now, id,
      );
      // Rewrite descendant paths: replace the old prefix with the new one.
      tx.prepare(
        `UPDATE nodes SET path = ? || substr(path, ?) WHERE path LIKE ? ESCAPE '\\'`,
      ).run(newPath + '/', oldPrefix.length + 1, escapeLike(oldPrefix) + '%');
      tx.exec('COMMIT');
    } catch (err) {
      tx.exec('ROLLBACK');
      if (String(err?.message || '').includes('UNIQUE')) throw TroveError.alreadyExists(name, { cause: err });
      throw wrapError(err);
    }
    return this.getById(id);
  }

  async setFacet(id, indexerId, data) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Node');
    node.facets = { ...node.facets, [indexerId]: { ...(node.facets[indexerId] || {}), ...data } };
    this.#get('UPDATE nodes SET facets=?, updatedAt=? WHERE id=?').run(JSON.stringify(node.facets), Date.now(), id);
    return node;
  }

  async clearFacet(id, indexerId) {
    const node = await this.getById(id);
    if (!node) return;
    const { [indexerId]: _drop, ...rest } = node.facets;
    this.#get('UPDATE nodes SET facets=? WHERE id=?').run(JSON.stringify(rest), id);
  }

  async searchByName(query, opts = {}) {
    const rows = this.#get(
      `SELECT * FROM nodes WHERE id != 'root' AND name LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT ?`,
    ).all('%' + escapeLike(query) + '%', opts.limit ?? 50);
    return rows.map(row);
  }

  async close() {
    this.db?.close();
    this.db = null;
  }
}

function row(r) {
  if (!r) return null;
  return {
    ...r,
    meta: r.meta ? JSON.parse(r.meta) : {},
    facets: r.facets ? JSON.parse(r.facets) : {},
  };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export { ROOT_ID };

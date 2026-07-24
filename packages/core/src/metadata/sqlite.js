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
function rootId(collectionId = 'default') {
  return collectionId === 'default' ? ROOT_ID : `root_${collectionId}`;
}

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
        parentId TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_coll_path ON nodes(collectionId, path);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_coll ON nodes(collectionId);
    `);
    await this.ensureRoot('default');
  }

  async ensureRoot(collectionId) {
    const id = rootId(collectionId);
    const now = Date.now();
    await this.db.run(
      `INSERT OR IGNORE INTO nodes (id,collectionId,parentId,name,path,kind,size,createdAt,updatedAt,meta,facets)
       VALUES (?,?,?,?,?,?,?,?,?,'{}','{}')`,
      id, collectionId, null, '', '/', 'folder', 0, now, now,
    );
    return this.getById(id);
  }

  async getById(id) {
    return row(await this.db.get('SELECT * FROM nodes WHERE id = ?', id));
  }
  async getByPath(collectionId, path) {
    if (path === undefined) {
      path = collectionId;
      collectionId = 'default';
    }
    return row(await this.db.get('SELECT * FROM nodes WHERE collectionId = ? AND path = ?', collectionId, normalizePath(path)));
  }

  async listChildren(parentId, opts = {}) {
    const parent = await this.db.get('SELECT id FROM nodes WHERE id = ?', parentId);
    if (!parent) throw TroveError.notFound('Folder');
    const sortCol = { name: 'name', size: 'size', updatedAt: 'updatedAt' }[opts.sort] || 'name';
    const dir = opts.order === 'desc' ? 'DESC' : 'ASC';
    const limit = opts.limit ?? 500;
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    // Folders first, then requested sort. COLLATE NOCASE for human-friendly names.
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE parentId = ?
       ORDER BY (kind='folder') DESC, ${sortCol} COLLATE NOCASE ${dir}
       LIMIT ? OFFSET ?`,
      parentId, limit + 1, offset,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(row);
    return { items, nextCursor: hasMore ? String(offset + limit) : null };
  }

  async create(node) {
    try {
      const parent = node.parentId ? await this.db.get('SELECT * FROM nodes WHERE id = ?', node.parentId) : null;
      if (node.parentId && !parent) throw TroveError.notFound('Parent folder');
      if (parent && parent.kind !== 'folder') throw TroveError.invalid('Parent is not a folder');
      const collectionId = parent ? parent.collectionId : node.collectionId || 'default';
      const path = parent ? joinPath(parent.path, node.name) : normalizePath('/' + node.name);
      const now = Date.now();
      const full = {
        id: node.id || newId(node.kind === 'folder' ? 'fld' : 'fil'),
        collectionId, parentId: node.parentId, name: node.name, path, kind: node.kind,
        size: node.size ?? 0, contentType: node.contentType ?? null,
        storageKey: node.storageKey ?? null, etag: node.etag ?? null,
        createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: node.facets ?? {},
      };
      await this.db.run(
        `INSERT INTO nodes (id,collectionId,parentId,name,path,kind,size,contentType,storageKey,etag,createdAt,updatedAt,meta,facets)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        full.id, full.collectionId, full.parentId, full.name, full.path, full.kind, full.size,
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

  async remove(id) {
    await this.db.run('DELETE FROM nodes WHERE id = ?', id);
  }

  async descendants(id) {
    const self = await this.getById(id);
    if (!self) return [];
    // Path-prefix query gets the whole subtree in one shot.
    const prefix = self.path === '/' ? '/' : self.path + '/';
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE collectionId = ? AND path LIKE ? ESCAPE '\\' AND id != ?`,
      self.collectionId, escapeLike(prefix) + '%', id,
    );
    return rows.map(row);
  }

  async move(id, newParentId, newName) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Node');
    const parent = await this.getById(newParentId);
    if (!parent) throw TroveError.notFound('Destination folder');
    if (parent.kind !== 'folder') throw TroveError.invalid('Destination is not a folder');
    if (parent.collectionId !== node.collectionId) throw TroveError.invalid('Cannot move across collections');
    const name = newName || node.name;
    const newPath = joinPath(parent.path, name);
    if (newPath === node.path && newParentId === node.parentId) return node;

    const oldPrefix = node.path + '/';
    const now = Date.now();
    try {
      // Move the node and rewrite descendant paths atomically.
      await this.db.batch([
        {
          sql: 'UPDATE nodes SET parentId=?, name=?, path=?, updatedAt=? WHERE id=?',
          params: [newParentId, name, newPath, now, id],
        },
        {
          sql: `UPDATE nodes SET path = ? || substr(path, ?) WHERE collectionId = ? AND path LIKE ? ESCAPE '\\'`,
          params: [newPath + '/', oldPrefix.length + 1, node.collectionId, escapeLike(oldPrefix) + '%'],
        },
      ]);
    } catch (err) {
      if (String(err?.message || '').includes('UNIQUE')) throw TroveError.alreadyExists(name, { cause: err });
      throw wrapError(err);
    }
    return this.getById(id);
  }

  async setFacet(id, indexerId, data) {
    const node = await this.getById(id);
    if (!node) throw TroveError.notFound('Node');
    node.facets = { ...node.facets, [indexerId]: { ...(node.facets[indexerId] || {}), ...data } };
    await this.db.run('UPDATE nodes SET facets=?, updatedAt=? WHERE id=?', JSON.stringify(node.facets), Date.now(), id);
    return node;
  }

  async clearFacet(id, indexerId) {
    const node = await this.getById(id);
    if (!node) return;
    const { [indexerId]: _drop, ...rest } = node.facets;
    await this.db.run('UPDATE nodes SET facets=? WHERE id=?', JSON.stringify(rest), id);
  }

  async searchByName(query, opts = {}) {
    const clause = opts.collectionId ? 'AND collectionId = ?' : '';
    const params = ['%' + escapeLike(query) + '%'];
    if (opts.collectionId) params.push(opts.collectionId);
    params.push(opts.limit ?? 50);
    const rows = await this.db.all(
      `SELECT * FROM nodes WHERE parentId IS NOT NULL AND name LIKE ? ESCAPE '\\' COLLATE NOCASE ${clause} LIMIT ?`,
      ...params,
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

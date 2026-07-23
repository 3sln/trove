// In-memory MetadataStore. Reference implementation + test double. Keeps nodes
// in a Map keyed by id, with secondary indexes for path and (parentId,name).

import { MetadataStore } from './interface.js';
import { TroveError } from '../errors.js';
import { newId, joinPath, normalizePath } from '../util.js';

const ROOT_ID = 'root';

export class MemoryStore extends MetadataStore {
  constructor() {
    super();
    this.nodes = new Map(); // id -> node
    this.byPath = new Map(); // path -> id
    this.childKey = new Map(); // `${parentId}\0${name}` -> id
  }

  async init() {
    if (!this.nodes.has(ROOT_ID)) {
      const now = Date.now();
      const root = {
        id: ROOT_ID, parentId: null, name: '', path: '/', kind: 'folder',
        size: 0, contentType: null, storageKey: null, etag: null,
        createdAt: now, updatedAt: now, meta: {}, facets: {},
      };
      this.#index(root);
    }
  }

  #index(node) {
    this.nodes.set(node.id, node);
    this.byPath.set(node.path, node.id);
    if (node.parentId) this.childKey.set(`${node.parentId}\0${node.name}`, node.id);
  }
  #deindex(node) {
    this.nodes.delete(node.id);
    this.byPath.delete(node.path);
    if (node.parentId) this.childKey.delete(`${node.parentId}\0${node.name}`);
  }

  async getById(id) {
    return clone(this.nodes.get(id));
  }
  async getByPath(path) {
    const id = this.byPath.get(normalizePath(path));
    return id ? clone(this.nodes.get(id)) : null;
  }

  async listChildren(parentId, opts = {}) {
    const parent = this.nodes.get(parentId);
    if (!parent) throw TroveError.notFound('Folder');
    let items = [...this.nodes.values()].filter((n) => n.parentId === parentId);
    const sort = opts.sort ?? 'name';
    const dir = opts.order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      // Folders first, then by chosen key.
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      const av = a[sort], bv = b[sort];
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    const limit = opts.limit ?? 500;
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const page = items.slice(offset, offset + limit);
    const nextCursor = offset + limit < items.length ? String(offset + limit) : null;
    return { items: page.map(clone), nextCursor };
  }

  async create(node) {
    const parent = node.parentId ? this.nodes.get(node.parentId) : null;
    if (node.parentId && !parent) throw TroveError.notFound('Parent folder');
    if (parent && parent.kind !== 'folder') throw TroveError.invalid('Parent is not a folder');
    const path = parent ? joinPath(parent.path, node.name) : normalizePath('/' + node.name);
    if (this.childKey.has(`${node.parentId}\0${node.name}`)) {
      throw TroveError.alreadyExists(node.name);
    }
    const now = Date.now();
    const full = {
      id: node.id || newId(node.kind === 'folder' ? 'fld' : 'fil'),
      parentId: node.parentId, name: node.name, path, kind: node.kind,
      size: node.size ?? 0, contentType: node.contentType ?? null,
      storageKey: node.storageKey ?? null, etag: node.etag ?? null,
      createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: node.facets ?? {},
    };
    this.#index(full);
    return clone(full);
  }

  async update(id, patch) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Node');
    for (const k of ['size', 'contentType', 'storageKey', 'etag', 'meta']) {
      if (k in patch) node[k] = patch[k];
    }
    node.updatedAt = Date.now();
    return clone(node);
  }

  async remove(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.#deindex(node);
  }

  async descendants(id) {
    const out = [];
    const stack = [...this.nodes.values()].filter((n) => n.parentId === id);
    while (stack.length) {
      const n = stack.pop();
      out.push(clone(n));
      if (n.kind === 'folder') {
        stack.push(...[...this.nodes.values()].filter((c) => c.parentId === n.id));
      }
    }
    return out;
  }

  async move(id, newParentId, newName) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Node');
    const parent = this.nodes.get(newParentId);
    if (!parent) throw TroveError.notFound('Destination folder');
    if (parent.kind !== 'folder') throw TroveError.invalid('Destination is not a folder');
    const name = newName || node.name;
    if (this.childKey.has(`${newParentId}\0${name}`)) throw TroveError.alreadyExists(name);

    // Collect subtree before mutating.
    const subtree = await this.descendants(id);
    this.#deindex(node);
    node.parentId = newParentId;
    node.name = name;
    const oldPath = node.path;
    node.path = joinPath(parent.path, name);
    node.updatedAt = Date.now();
    this.#index(node);
    // Rewrite descendant paths.
    for (const raw of subtree) {
      const d = this.nodes.get(raw.id);
      this.byPath.delete(d.path);
      d.path = node.path + d.path.slice(oldPath.length);
      this.byPath.set(d.path, d.id);
    }
    return clone(node);
  }

  async setFacet(id, indexerId, data) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Node');
    node.facets = { ...node.facets, [indexerId]: { ...(node.facets[indexerId] || {}), ...data } };
    node.updatedAt = Date.now();
    return clone(node);
  }
  async clearFacet(id, indexerId) {
    const node = this.nodes.get(id);
    if (!node) return;
    const { [indexerId]: _drop, ...rest } = node.facets;
    node.facets = rest;
  }

  async searchByName(query, opts = {}) {
    const q = query.toLowerCase();
    const items = [...this.nodes.values()]
      .filter((n) => n.id !== ROOT_ID && n.name.toLowerCase().includes(q))
      .slice(0, opts.limit ?? 50);
    return items.map(clone);
  }
}

function clone(n) {
  return n ? JSON.parse(JSON.stringify(n)) : n;
}

export { ROOT_ID };

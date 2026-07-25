// In-memory MetadataStore. Reference implementation + test double. Keeps nodes
// in a Map keyed by id, with secondary indexes for (collectionId,path) and
// (parentId,name). Every node belongs to a collection; each collection has its
// own root, so paths are unique per collection, not globally.

import { MetadataStore, MERGED_TAGS, mergeContributionTags, splitContributions, applyContribution, rawFacetsFromNode } from './interface.js';
import { TroveError } from '../errors.js';
import { newId, joinPath, normalizePath } from '../util.js';

const ROOT_ID = 'root';
export function rootId(collectionId = 'default') {
  return collectionId === 'default' ? ROOT_ID : `root_${collectionId}`;
}

export class MemoryStore extends MetadataStore {
  constructor() {
    super();
    this.nodes = new Map(); // id -> node
    this.byPath = new Map(); // `${collectionId}\0${path}` -> id
    this.childKey = new Map(); // `${parentId}\0${name}` -> id
  }

  async init() {
    await this.ensureRoot('default');
  }

  async ensureRoot(collectionId) {
    const id = rootId(collectionId);
    if (!this.nodes.has(id)) {
      const now = Date.now();
      this.#index({
        id, collectionId, parentId: null, name: '', path: '/', kind: 'folder',
        size: 0, contentType: null, storageKey: null, etag: null,
        createdAt: now, updatedAt: now, meta: {}, facets: {},
      });
    }
    return clone(this.nodes.get(id));
  }

  #index(node) {
    this.nodes.set(node.id, node);
    this.byPath.set(`${node.collectionId}\0${node.path}`, node.id);
    if (node.parentId) this.childKey.set(`${node.parentId}\0${node.name}`, node.id);
  }
  #deindex(node) {
    this.nodes.delete(node.id);
    this.byPath.delete(`${node.collectionId}\0${node.path}`);
    if (node.parentId) this.childKey.delete(`${node.parentId}\0${node.name}`);
  }

  async getById(id) {
    return clone(this.nodes.get(id));
  }
  async getByPath(collectionId, path) {
    // Back-compat: getByPath(path) → default collection.
    if (path === undefined) {
      path = collectionId;
      collectionId = 'default';
    }
    const id = this.byPath.get(`${collectionId}\0${normalizePath(path)}`);
    return id ? clone(this.nodes.get(id)) : null;
  }

  async listChildren(parentId, opts = {}) {
    const parent = this.nodes.get(parentId);
    if (!parent) throw TroveError.notFound('Folder');
    let items = [...this.nodes.values()].filter((n) => n.parentId === parentId);
    const sort = opts.sort ?? 'name';
    const dir = opts.order === 'desc' ? -1 : 1;
    items.sort((a, b) => {
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
    const collectionId = parent ? parent.collectionId : node.collectionId || 'default';
    const path = parent ? joinPath(parent.path, node.name) : normalizePath('/' + node.name);
    if (this.childKey.has(`${node.parentId}\0${node.name}`)) {
      throw TroveError.alreadyExists(node.name);
    }
    const now = Date.now();
    const full = {
      id: node.id || newId(node.kind === 'folder' ? 'fld' : 'fil'),
      collectionId, parentId: node.parentId, name: node.name, path, kind: node.kind,
      size: node.size ?? 0, contentType: node.contentType ?? null,
      storageKey: node.storageKey ?? null, etag: node.etag ?? null,
      createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: rawFacetsFromNode(node),
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
    if (parent.collectionId !== node.collectionId) throw TroveError.invalid('Cannot move across collections');
    const name = newName || node.name;
    if (this.childKey.has(`${newParentId}\0${name}`)) throw TroveError.alreadyExists(name);

    const subtree = await this.descendants(id);
    this.#deindex(node);
    node.parentId = newParentId;
    node.name = name;
    const oldPath = node.path;
    node.path = joinPath(parent.path, name);
    node.updatedAt = Date.now();
    this.#index(node);
    for (const raw of subtree) {
      const d = this.nodes.get(raw.id);
      this.byPath.delete(`${d.collectionId}\0${d.path}`);
      d.path = node.path + d.path.slice(oldPath.length);
      this.byPath.set(`${d.collectionId}\0${d.path}`, d.id);
    }
    return clone(node);
  }

  async setContribution(id, contributorId, contribution) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Node');
    node.facets = applyContribution(node.facets, contributorId, contribution);
    node.updatedAt = Date.now();
    return clone(node);
  }
  async clearContribution(id, contributorId) {
    const node = this.nodes.get(id);
    if (!node) return;
    const { [contributorId]: _drop, ...rest } = node.facets;
    node.facets = { ...rest, [MERGED_TAGS]: mergeContributionTags(rest) };
  }

  async searchByName(query, opts = {}) {
    const q = query.toLowerCase();
    const items = [...this.nodes.values()]
      .filter((n) => n.parentId !== null && n.name.toLowerCase().includes(q))
      .filter((n) => !opts.collectionId || n.collectionId === opts.collectionId)
      .slice(0, opts.limit ?? 50);
    return items.map(clone);
  }

  async listFiles({ afterId = null, limit = 200 } = {}) {
    const files = [...this.nodes.values()]
      .filter((n) => n.kind === 'file')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = afterId ? files.findIndex((n) => n.id > afterId) : 0;
    const from = start === -1 ? files.length : start;
    return files.slice(from, from + limit).map(clone);
  }

  async findByTags(filters = [], opts = {}) {
    const q = opts.q ? opts.q.toLowerCase() : null;
    const out = [];
    for (const node of this.nodes.values()) {
      if (node.parentId === null) continue;
      if (opts.collectionIds?.length && !opts.collectionIds.includes(node.collectionId)) continue;
      if (q && !node.name.toLowerCase().includes(q)) continue;
      if (matchTags(node, filters)) out.push(node);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, opts.limit ?? 100).map(clone);
  }
}

// Split the internal raw facets into the exposed contributions + tags on read.
function clone(n) {
  if (!n) return n;
  const copy = JSON.parse(JSON.stringify(n));
  const { contributions, tags } = splitContributions(copy.facets || {});
  copy.contributions = contributions;
  copy.tags = tags;
  delete copy.facets;
  return copy;
}

// Server-side mirror of the client tag matcher (web/src/bl/tagQuery.js).
function matchTags(node, filters) {
  const merged = mergeContributionTags(node.facets || {});
  const props = { ...(node.meta || {}), ...merged };
  return (filters || []).every((f) => {
    const v = props[f.key];
    if (f.present) return v != null && v !== false && v !== '';
    if (v == null) return false;
    const na = Number(v);
    const nb = Number(f.value);
    const numeric = v !== '' && f.value !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
    const x = numeric ? na : String(v).toLowerCase();
    const y = numeric ? nb : String(f.value).toLowerCase();
    switch (f.op) {
      case '=': return x === y;
      case '!=': return x !== y;
      case '<': return x < y;
      case '<=': return x <= y;
      case '>': return x > y;
      case '>=': return x >= y;
      default: return false;
    }
  });
}

export { ROOT_ID };

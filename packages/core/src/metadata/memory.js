// In-memory MetadataStore. Reference implementation + test double. Nodes live in a
// Map keyed by id, with one secondary index on (collectionId, name) — which is the
// whole shape of the namespace now that there is no hierarchy: a collection is a flat
// set of uniquely-named items, and structure comes from `trove:` links between them.

import {
  MetadataStore, MERGED_TAGS, LINKS_CONTRIBUTOR, LINKS_KEY,
  mergeContributionTags, splitContributions, applyContribution, rawFacetsFromNode,
} from './interface.js';
import { TroveError } from '../errors.js';
import { newId } from '../util.js';
import { decodeCursor, encodeCursor, afterCursor } from './cursor.js';

export class MemoryStore extends MetadataStore {
  constructor() {
    super();
    this.nodes = new Map(); // id -> node
    this.byName = new Map(); // `${collectionId}\0${name}` -> id
  }

  async init() {}

  #key(collectionId, name) {
    return `${collectionId}\0${name}`;
  }
  #index(node) {
    this.nodes.set(node.id, node);
    this.byName.set(this.#key(node.collectionId, node.name), node.id);
  }
  #deindex(node) {
    this.nodes.delete(node.id);
    const key = this.#key(node.collectionId, node.name);
    // Only when the name still resolves to THIS node. `softDelete` deliberately frees
    // the name so a replacement can take it, so by the time the trash is emptied that
    // key belongs to a different, LIVE file. Deleting it blindly made that live file
    // unreachable by name — `trove:default?name=notes.md` stopped resolving, and the
    // uniqueness check stopped seeing it, so the next upload created a second row
    // under the same name.
    if (this.byName.get(key) === node.id) this.byName.delete(key);
  }
  /** Live rows only. A trashed item keeps its row but must not answer as itself. */
  #live() {
    return [...this.nodes.values()].filter((n) => !n.deletedAt);
  }

  async getById(id) {
    return clone(this.nodes.get(id));
  }
  async getByName(collectionId = 'default', name) {
    const id = this.byName.get(this.#key(collectionId, name));
    const node = id ? this.nodes.get(id) : null;
    return node && !node.deletedAt ? clone(node) : null;
  }

  async listItems(collectionId = 'default', opts = {}) {
    const sort = opts.sort ?? 'name';
    const desc = opts.order === 'desc';
    const dir = desc ? -1 : 1;
    const items = this.#live().filter((n) => n.collectionId === collectionId);
    // `id` breaks ties, so two files of the same size still have one stable order — the
    // cursor below depends on the ordering being total.
    items.sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.id < b.id ? -1 * dir : a.id > b.id ? dir : 0;
    });
    const limit = opts.limit ?? 500;
    const at = decodeCursor(sort, opts.cursor);
    const rest = at ? items.filter((n) => afterCursor(n, sort, at, desc)) : items;
    const page = rest.slice(0, limit);
    return {
      items: page.map(clone),
      nextCursor: rest.length > limit ? encodeCursor(sort, page[page.length - 1]) : null,
    };
  }

  async create(node) {
    const collectionId = node.collectionId || 'default';
    if (!node.name) throw TroveError.invalid('An item needs a name');
    if (this.byName.has(this.#key(collectionId, node.name))) throw TroveError.alreadyExists(node.name);
    const now = Date.now();
    const full = {
      id: node.id || newId('itm'),
      collectionId, name: node.name,
      size: node.size ?? 0, contentType: node.contentType ?? null,
      storageKey: node.storageKey ?? null, etag: node.etag ?? null,
      createdAt: now, updatedAt: now, meta: node.meta ?? {}, facets: rawFacetsFromNode(node),
    };
    this.#index(full);
    return clone(full);
  }

  async update(id, patch) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Item');
    for (const k of ['size', 'contentType', 'storageKey', 'etag', 'meta']) {
      if (k in patch) node[k] = patch[k];
    }
    node.updatedAt = Date.now();
    return clone(node);
  }

  /** Permanently forget an item. The trash is a VFS concern; this is the real delete. */
  async remove(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    this.#deindex(node);
  }

  async softDelete(id, at = Date.now()) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Item');
    node.deletedAt = at;
    node.updatedAt = at;
    // Free the name so a replacement can take it — otherwise the trash holds the name
    // hostage and you can never re-create what you just deleted.
    this.byName.delete(this.#key(node.collectionId, node.name));
    return clone(node);
  }

  async restore(id, newName = null) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Item');
    const name = newName || node.name;
    if (this.byName.has(this.#key(node.collectionId, name))) throw TroveError.alreadyExists(name);
    delete node.deletedAt;
    node.name = name;
    node.updatedAt = Date.now();
    this.byName.set(this.#key(node.collectionId, name), node.id);
    return clone(node);
  }

  async listTrash(collectionId, { limit = 200, before = null } = {}) {
    return [...this.nodes.values()]
      .filter((n) => n.deletedAt && (!collectionId || n.collectionId === collectionId) && (!before || n.deletedAt < before))
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .slice(0, limit)
      .map(clone);
  }

  async trashedStorageKeys(collectionId) {
    const keys = new Set();
    for (const n of this.nodes.values()) {
      if (n.deletedAt && n.storageKey && (!collectionId || n.collectionId === collectionId)) keys.add(n.storageKey);
    }
    return keys;
  }

  async trashedBefore(cutoff, limit = 500) {
    return [...this.nodes.values()]
      .filter((n) => n.deletedAt && n.deletedAt < cutoff)
      .sort((a, b) => a.deletedAt - b.deletedAt)
      .slice(0, limit)
      .map(clone);
  }

  async rename(id, newName) {
    const node = this.nodes.get(id);
    if (!node || node.deletedAt) throw TroveError.notFound('Item');
    if (!newName) throw TroveError.invalid('An item needs a name');
    if (newName === node.name) return clone(node);
    if (this.byName.has(this.#key(node.collectionId, newName))) throw TroveError.alreadyExists(newName);
    this.#deindex(node);
    node.name = newName;
    node.updatedAt = Date.now();
    this.#index(node);
    return clone(node);
  }

  async setContribution(id, contributorId, contribution) {
    const node = this.nodes.get(id);
    if (!node) throw TroveError.notFound('Item');
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
    return this.#live()
      .filter((n) => n.name.toLowerCase().includes(q))
      .filter((n) => !opts.collectionId || n.collectionId === opts.collectionId)
      .slice(0, opts.limit ?? 50)
      .map(clone);
  }

  async scanItems({ afterId = null, limit = 200 } = {}) {
    const files = this.#live().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = afterId ? files.findIndex((n) => n.id > afterId) : 0;
    const from = start === -1 ? files.length : start;
    return files.slice(from, from + limit).map(clone);
  }

  async countItems(collectionId) {
    const live = this.#live();
    return collectionId ? live.filter((n) => n.collectionId === collectionId).length : live.length;
  }

  async collectionStats(collectionId = 'default') {
    let items = 0;
    let bytes = 0;
    let trashed = 0;
    for (const node of this.nodes.values()) {
      if (node.collectionId !== collectionId) continue;
      if (node.deletedAt) { trashed++; continue; }
      items++;
      bytes += node.size || 0;
    }
    return { items, bytes, trashed };
  }

  async findByTags(filters = [], opts = {}) {
    const q = opts.q ? opts.q.toLowerCase() : null;
    const out = [];
    for (const node of this.#live()) {
      if (opts.collectionIds && !opts.collectionIds.includes(node.collectionId)) continue;
      if (q && !node.name.toLowerCase().includes(q)) continue;
      if (matchTags(node, filters)) out.push(node);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, opts.limit ?? 100).map(clone);
  }

  async findLinksTo(uris = [], opts = {}) {
    if (!uris.length) return [];
    const want = new Set(uris);
    const out = [];
    for (const node of this.#live()) {
      if (opts.collectionIds && !opts.collectionIds.includes(node.collectionId)) continue;
      const links = node.facets?.[LINKS_CONTRIBUTOR]?.metadata?.[LINKS_KEY];
      if (Array.isArray(links) && links.some((l) => want.has(l))) out.push(node);
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

// Collections — the top-level ownership + permission boundary. Every file and
// folder belongs to exactly one collection, and (almost) all authorization is at
// the collection level: a principal holds some subset of { read, write, delete,
// admin } capabilities on a collection, granted via its ACL.
//
// A collection is also a STORE CONFIG: it names a backing store (S3 bucket+prefix,
// a filesystem path, memory…). Different collections can live on entirely
// different backends, or share one bucket via distinct prefixes. Users who hold
// the global "create collections" capability can spin up new collections by
// supplying a store config — Trove instantiates the backend on demand.
//
// Records persist in the pluggable KeyValueStore. Store configs may contain
// secrets (access keys); treat that store as sensitive.

import { TroveError } from '../errors.js';
import { PrefixedStorage } from '../storage/prefixed.js';
import { newId } from '../util.js';

export const CAPABILITIES = ['read', 'write', 'delete', 'admin'];
const NS = 'collections';

// admin implies everything; a simple implication table keeps checks declarative.
function expand(caps) {
  const set = new Set(caps);
  if (set.has('admin')) for (const c of CAPABILITIES) set.add(c);
  return set;
}

export class CollectionService {
  /**
   * @param {object} deps
   * @param {import('../kv.js').KeyValueStore} deps.kv
   * @param {(storeConfig: object) => import('../storage/interface.js').StorageBackend} deps.storageFactory
   * @param {string[]} [deps.admins] global admin principal ids (can do anything, create collections)
   * @param {string[]} [deps.creatorRoles] roles allowed to create collections
   * @param {object} [deps.defaultStore] store config for the auto-created 'default' collection
   * @param {boolean} [deps.defaultOpen] if true (default), 'default' grants everyone all caps (single-user friendly)
   */
  constructor({ kv, storageFactory, admins = [], creatorRoles = [], defaultStore, defaultOpen = true, storageOverrides }) {
    if (!kv) throw TroveError.invalid('CollectionService requires a kv store');
    if (!storageFactory) throw TroveError.invalid('CollectionService requires a storageFactory');
    this.kv = kv;
    this.storageFactory = storageFactory;
    this.admins = new Set(admins);
    this.creatorRoles = new Set(creatorRoles);
    this.defaultStore = defaultStore || { driver: 'memory' };
    this.defaultOpen = defaultOpen;
    // Pre-built backends to reuse an existing instance (e.g. the server's primary
    // storage for the 'default' collection, so data isn't split across two Maps).
    this._storage = new Map(Object.entries(storageOverrides || {}));
  }

  async init() {
    const existing = await this.kv.get(NS, 'default');
    if (!existing) {
      await this.kv.set(NS, 'default', {
        id: 'default', name: 'My Drive', description: 'Default collection',
        store: this.defaultStore,
        acl: { grants: this.defaultOpen ? [{ type: 'anyone', capabilities: ['read', 'write', 'delete', 'admin'] }] : [] },
        createdAt: Date.now(), createdBy: 'system', system: true,
      });
    }
  }

  async list(principal) {
    const rows = await this.kv.list(NS);
    return rows
      .map((r) => r.value)
      .filter((c) => this.can(principal, c, 'read'))
      .map((c) => this.describe(c, principal))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  async get(id) {
    const c = await this.kv.get(NS, id);
    if (!c) throw TroveError.notFound('Collection');
    return c;
  }

  /** A safe, principal-scoped view (no secrets). */
  describe(c, principal) {
    const caps = [...this.capabilities(principal, c)];
    return {
      id: c.id, name: c.name, description: c.description || '',
      driver: c.store?.driver, system: !!c.system,
      capabilities: caps, createdAt: c.createdAt,
    };
  }

  /** Build (and cache) the StorageBackend for a collection from its store config. */
  async storageFor(collectionId) {
    if (this._storage.has(collectionId)) return this._storage.get(collectionId);
    const c = await this.get(collectionId);
    let backend = this.storageFactory(c.store);
    if (c.store?.prefix) backend = new PrefixedStorage(backend, c.store.prefix);
    this._storage.set(collectionId, backend);
    return backend;
  }

  // --- permissions -----------------------------------------------------------

  /** The set of capabilities `principal` holds on a collection record/id. */
  capabilities(principal, collectionOrId) {
    const c = typeof collectionOrId === 'string' ? null : collectionOrId;
    if (!c) return new Set(); // callers pass the record; unknown → none
    if (principal && this.admins.has(principal.id)) return expand(['admin']);
    const roles = new Set(principal?.roles || []);
    // Note: a creator role grants the ability to CREATE collections, not blanket
    // access to every collection — per-collection access comes only from the ACL below.
    const granted = new Set();
    for (const g of c.acl?.grants || []) {
      const match =
        g.type === 'anyone' ||
        (g.type === 'user' && principal && g.subject === principal.id) ||
        (g.type === 'role' && roles.has(g.subject));
      if (match) for (const cap of g.capabilities || []) granted.add(cap);
    }
    return expand([...granted]);
  }

  can(principal, collectionOrId, capability) {
    return this.capabilities(principal, collectionOrId).has(capability);
  }
  async assert(principal, collectionId, capability) {
    const c = await this.get(collectionId);
    if (!this.can(principal, c, capability)) {
      throw TroveError.forbidden(`You lack "${capability}" on collection "${c.name}"`);
    }
    return c;
  }

  /** Global admin (can do anything, incl. grant admin-only plugin capabilities). */
  isAdmin(principal) {
    return !!principal && this.admins.has(principal.id);
  }

  /** Global capability to create new collections. */
  canCreate(principal) {
    if (!principal) return false;
    if (this.admins.has(principal.id)) return true;
    return (principal.roles || []).some((r) => this.creatorRoles.has(r));
  }

  // --- CRUD ------------------------------------------------------------------

  /**
   * Create a collection from a store config. Requires the create capability.
   * The creator is granted admin on the new collection.
   */
  async create({ name, description, store, acl }, principal) {
    if (!this.canCreate(principal)) throw TroveError.forbidden('You cannot create collections');
    if (!name?.trim()) throw TroveError.invalid('Collection name is required');
    if (!store?.driver) throw TroveError.invalid('A backing store (driver + config) is required');
    // Validate the store config actually builds.
    try {
      this.storageFactory(store);
    } catch (err) {
      throw TroveError.invalid(`Invalid store config: ${err.message}`, { cause: err });
    }
    const id = newId('col');
    const grants = acl?.grants ? [...acl.grants] : [];
    grants.push({ type: 'user', subject: principal.id, capabilities: ['admin'] });
    const record = { id, name: name.trim(), description: description || '', store, acl: { grants }, createdAt: Date.now(), createdBy: principal.id };
    await this.kv.set(NS, id, record);
    return this.describe(record, principal);
  }

  async update(id, patch, principal) {
    const c = await this.assert(principal, id, 'admin');
    const next = { ...c };
    if (patch.name != null) next.name = patch.name;
    if (patch.description != null) next.description = patch.description;
    if (patch.acl) next.acl = patch.acl; // full ACL replace (admin-only)
    if (patch.store) {
      next.store = patch.store;
      this._storage.delete(id); // rebuild backend next use
    }
    await this.kv.set(NS, id, next);
    return this.describe(next, principal);
  }

  /** Remove the collection record. Caller is responsible for its nodes/objects. */
  async remove(id, principal) {
    if (id === 'default') throw TroveError.invalid('The default collection cannot be deleted');
    await this.assert(principal, id, 'admin');
    await this.kv.delete(NS, id);
    this._storage.delete(id);
    return { ok: true };
  }

  /** Full ACL grant management (admin-only). */
  async setGrant(id, grant, principal) {
    const c = await this.assert(principal, id, 'admin');
    const grants = (c.acl?.grants || []).filter((g) => !(g.type === grant.type && g.subject === grant.subject));
    if (grant.capabilities?.length) grants.push(grant);
    return this.update(id, { acl: { grants } }, principal);
  }
}

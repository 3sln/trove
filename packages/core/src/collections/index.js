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
// Exported because API keys grant capabilities too, and "admin" has to mean the same
// thing in a key as it does in an ACL — two implication tables would eventually diverge.
export function expand(caps) {
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

  /**
   * Nothing is created here any more.
   *
   * There used to be a `default` collection, minted on first boot and named by every
   * unscoped request. It made a fresh drive feel ready, and it cost more than it was
   * worth: `'default'` became a hardcoded assumption in routing, in maintenance, in the
   * metadata schema and in four core signatures, and on a multi-user drive it was a
   * collection most people could not read — so the fallback pointed new users at a
   * permission error and called it their drive.
   *
   * A drive with no collections now says so, and the client asks for one to be created.
   * That is a real first-run step rather than a magic id, and every request names the
   * collection it means.
   */
  async init() {}

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

  /**
   * Does `subject` — a string an operator or an ACL wrote down — name this principal?
   *
   * By id, or by email. The id is whatever the IdP put in `sub`, and for Cloudflare
   * Access that is an internal user UUID, not an address: `TROVE_ADMINS=you@example.com`
   * matched nothing and there was no way to discover the UUID short of decoding a JWT.
   * A drive that looks administered and isn't is the worst version of this to ship, so
   * the address people actually think of as their identity works too.
   *
   * Email compares case-insensitively, which is how mailboxes behave and how every IdP
   * hands them over.
   */
  #names(subject, principal) {
    if (!subject || !principal) return false;
    if (subject === principal.id) return true;
    const email = principal.email;
    return !!email && String(subject).toLowerCase() === String(email).toLowerCase();
  }

  /** Is this principal on the global admin list (by id or by email)? */
  #isNamedAdmin(principal) {
    if (!principal) return false;
    if (this.admins.has(principal.id)) return true;
    for (const a of this.admins) if (this.#names(a, principal)) return true;
    return false;
  }

  /** The set of capabilities `principal` holds on a collection record/id. */
  capabilities(principal, collectionOrId) {
    const c = typeof collectionOrId === 'string' ? null : collectionOrId;
    if (!c) return new Set(); // callers pass the record; unknown → none
    if (this.#isNamedAdmin(principal)) return expand(['admin']);
    const roles = new Set(principal?.roles || []);
    // Note: a creator role grants the ability to CREATE collections, not blanket
    // access to every collection — per-collection access comes only from the ACL below.
    const granted = new Set();
    for (const g of c.acl?.grants || []) {
      const match =
        g.type === 'anyone' ||
        // Same for a per-collection grant: sharing with someone by the address you know
        // them by has to work, or an ACL written by a human never matches.
        (g.type === 'user' && this.#names(g.subject, principal)) ||
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

  /**
   * May this principal act on the drive AS A WHOLE?
   *
   * True for a named admin, and also for anyone who can already read and write every
   * collection that exists — which is not a new grant, it is naming what is already
   * true. It matters because the default zero-config self-host is exactly that shape:
   * one anonymous user with full access to an open default collection. Gating
   * drive-wide maintenance (rebuilding the search index) behind a TROVE_ADMINS list
   * nobody is on would make it unreachable in the configuration most people run first,
   * while a locked-down multi-tenant drive still restricts it to real admins.
   *
   * Deliberately NOT used for anything that grants new power — installing a server
   * indexer runs code, and stays `isAdmin` only.
   */
  async hasWholeDrive(principal) {
    if (this.isAdmin(principal)) return true;
    if (!principal) return false;
    const all = (await this.kv.list(NS)).map((r) => r.value).filter(Boolean);
    if (!all.length) return false;
    return all.every((c) => this.can(principal, c, 'read') && this.can(principal, c, 'write'));
  }

  /** Global admin (can do anything, incl. grant admin-only plugin capabilities). */
  isAdmin(principal) {
    return this.#isNamedAdmin(principal);
  }

  /** Global capability to create new collections. */
  canCreate(principal) {
    if (!principal) return false;
    if (this.#isNamedAdmin(principal)) return true;
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

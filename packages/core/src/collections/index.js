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
import { normalizeEncryption, describeEncryption } from '../encryption/policy.js';
import { newCollectionKey, fromHex, toHex } from '../encryption/keys.js';

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

  // --- the same questions, asked of an API key ---------------------------------
  //
  // A key is authority that ARRIVED WITH THE REQUEST. There is nobody to look up in the
  // ACL, and `principal` is null on a key request — so asking the principal side answers
  // for the ANONYMOUS caller, which is wrong in both directions. On a locked drive a
  // correctly-scoped key is told it can read nothing; on a `defaultOpen` drive the
  // `anyone` grant lets a key scoped to one collection read and write every one of them.
  //
  // Decided from the key ALONE, never unioned with whatever session happens to be
  // attached — the same rule engine/providers/access.js states for node and collection
  // handles, and the reason a weak key cannot borrow a strong session.

  /** The collections an API key may read. `list`'s twin. */
  async listForGrant(grant) {
    const rows = await this.kv.list(NS);
    return rows
      .map((r) => r.value)
      .filter((c) => c && grant.can(c.id, 'read'))
      .map((c) => this.describeForGrant(c, grant))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  /** `assert`'s twin. Refuses with what the KEY lacks, not with what a user lacks. */
  async assertForGrant(grant, collectionId, capability) {
    const c = await this.get(collectionId);
    if (!grant.can(collectionId, capability)) {
      throw TroveError.forbidden(`This API key does not hold "${capability}" on collection "${c.name}"`);
    }
    return c;
  }

  /**
   * `hasWholeDrive`'s twin: a key that can read and write every collection that exists.
   *
   * Same definition, so the answer does not depend on which credential asked — and it
   * shrinks the moment a collection the key does not name is created, which is the safe
   * direction. A `*`-scoped key satisfies it by construction. There is no admin-list
   * shortcut, because a key is never a named admin: the drive-wide verbs that grant new
   * power (minting keys, installing a server indexer) are gated by `requireHumanAdmin`
   * and `isAdmin` and stay out of a key's reach entirely.
   */
  async grantHasWholeDrive(grant) {
    const all = (await this.kv.list(NS)).map((r) => r.value).filter(Boolean);
    if (!all.length) return false;
    return all.every((c) => grant.can(c.id, 'read') && grant.can(c.id, 'write'));
  }

  /**
   * The encryption settings for a collection, generating a key the first time.
   *
   * The key is generated, not derived from anything a user types. A passphrase would buy
   * nothing: the server knows the key regardless — it hands it to clients and decrypts for
   * indexers — so there is no protection to gain from the user holding it, and every cost
   * would still apply. A random 256-bit key cannot be forgotten, guessed, or shoulder-read,
   * and needs no prompt in front of the collection.
   *
   * Generated ONCE. Re-enabling, or changing the rules, keeps the existing key: every
   * stored object names the key it was sealed with, so quietly minting a new one would
   * orphan all of them. Replacing a key is rotation, and rotation re-encrypts.
   *
   * @returns {Promise<{encryption: object, dataKey: Uint8Array|null}>}
   */
  async #encryptionFor(patch, existing, ring) {
    if (!patch || patch.enabled === false) return { encryption: null, keys: ring || null };
    if (existing?.fingerprint && ring?.[existing.fingerprint]) {
      // Keep the whole ring; only the rules can change here.
      return { encryption: normalizeEncryption(patch, existing.fingerprint), keys: ring };
    }
    const { dataKey, config } = await newCollectionKey();
    return {
      encryption: normalizeEncryption(patch, config.fingerprint),
      keys: { ...(ring || {}), [config.fingerprint]: toHex(dataKey) },
    };
  }

  /**
   * The key an object was sealed with, or the collection's current key.
   *
   * A collection holds a RING, not a key: rotation adds a new key and makes it current,
   * then re-encrypts objects onto it in the background. Until that finishes both keys are
   * live, and an object is opened with whichever one its envelope names — which is the
   * whole reason every object carries a fingerprint. Retiring a key is only safe once
   * nothing names it any more.
   *
   * Server-side only. Callers are the transfer plans, which hand the right key to a client
   * that may read the collection, and indexing, which decrypts to read content. Never
   * reachable through `describe`.
   *
   * @param {string} collectionId
   * @param {string} [fingerprint] which key; omitted means the current one
   */
  async dataKeyFor(collectionId, fingerprint) {
    const c = await this.get(collectionId);
    const ring = c?.$keys;
    if (!ring) return null;
    const want = fingerprint || c.encryption?.fingerprint;
    const hex = want && ring[want];
    return hex ? fromHex(hex) : null;
  }

  /**
   * Every key this collection can still open something with, current first.
   *
   * For rotation, and for anything that has to read objects it did not plan.
   */
  async keyRingFor(collectionId) {
    const c = await this.get(collectionId);
    if (!c?.$keys) return [];
    const current = c.encryption?.fingerprint;
    return Object.entries(c.$keys)
      .map(([fp, hex]) => ({ fingerprint: fp, dataKey: fromHex(hex), current: fp === current }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /**
   * Begin a rotation: mint a key, make it current, keep the old ones.
   *
   * Only makes the new key current. Nothing is re-encrypted here — objects move onto it
   * incrementally, and until every one has, the old keys must stay or their objects become
   * unreadable. `retireKey` is what finishes the job.
   */
  async beginRotation(collectionId, principal) {
    const c = await this.assert(principal, collectionId, 'admin');
    if (!c.encryption?.enabled) throw TroveError.invalid('This collection is not encrypted');
    const { dataKey, config } = await newCollectionKey();
    const next = {
      ...c,
      encryption: { ...c.encryption, fingerprint: config.fingerprint },
      $keys: { ...(c.$keys || {}), [config.fingerprint]: toHex(dataKey) },
    };
    await this.kv.set(NS, collectionId, next);
    return { fingerprint: config.fingerprint, previous: c.encryption.fingerprint };
  }

  /**
   * Drop a key from the ring, once nothing is sealed with it any more.
   *
   * Refuses to drop the current key: that would leave the collection encrypting with
   * something it cannot open.
   */
  async retireKey(collectionId, fingerprint, principal, { system = false } = {}) {
    // `system` is for the rotation walker, which has no user behind it — it is finishing
    // work an admin already authorized when they started the rotation. Named rather than
    // done by passing a fake principal, so the bypass is visible at both ends.
    const c = system ? await this.get(collectionId) : await this.assert(principal, collectionId, 'admin');
    if (fingerprint === c.encryption?.fingerprint) {
      throw TroveError.invalid('That is the collection\u2019s current key');
    }
    if (!c.$keys?.[fingerprint]) return { retired: false };
    const keys = { ...c.$keys };
    delete keys[fingerprint];
    await this.kv.set(NS, collectionId, { ...c, $keys: keys });
    return { retired: true };
  }

  /** What a collection encrypts, for the code that has to decide per item. */
  async encryptionFor(collectionId) {
    const c = await this.get(collectionId);
    return c?.encryption || null;
  }

  /**
   * Every collection record, with no principal and no ACL filtering.
   *
   * For system work — a scheduled scan, a storage self-check — which has no user and must
   * not pretend to have one. `list(null)` is the wrong tool for that, and quietly so: it
   * asks what the ANONYMOUS principal may read, which on a drive that is not open to the
   * public is nothing. Maintenance that called it looked like it ran and scanned no
   * collection at all.
   *
   * Never hand the result to a request — these records carry store configuration,
   * credentials included. `list(principal)` is the answer to "what may you see".
   */
  async all() {
    return (await this.kv.list(NS)).map((r) => r.value).filter(Boolean);
  }

  async get(id) {
    const c = await this.kv.get(NS, id);
    if (!c) throw TroveError.notFound('Collection');
    return c;
  }

  /** A safe, principal-scoped view (no secrets). */
  describe(c, principal) {
    return this.#describe(c, this.capabilities(principal, c));
  }

  /** The same record, with the capabilities an API KEY holds rather than a principal's. */
  describeForGrant(c, grant) {
    return this.#describe(c, grant.capabilitiesFor(c.id));
  }

  #describe(c, held) {
    const caps = [...held];
    return {
      id: c.id, name: c.name, description: c.description || '',
      driver: c.store?.driver, system: !!c.system,
      capabilities: caps, createdAt: c.createdAt,
      // Safe to hand to anyone who can see the collection: the salt, the KDF parameters
      // and the fingerprint are what turn a passphrase into the key, and are useless
      // without the passphrase. Null when the collection is not encrypted, so a client
      // never has to ask a second question to find out.
      encryption: describeEncryption(c.encryption),
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

  /**
   * What this principal may reach across the whole drive, and whether that is anything.
   *
   * The ACL as a DECISION rather than as a record, so something outside this library can
   * ask it — an edge policy deciding whether an email gets through the front door at all,
   * for instance. Everything it needs is already here; what was missing was a way to ask
   * without reimplementing `can()` against the grant shape, which is exactly how two
   * copies of an authorization rule start.
   *
   * "Allowed" means: a named admin, or read on at least one collection. Read on nothing is
   * the honest definition of someone with no business here — note that on a `defaultOpen`
   * drive the `anyone` grant makes that true for everybody, which is correct, because the
   * ACL is what says so.
   */
  async accessFor(principal) {
    const admin = this.isAdmin(principal);
    const collections = await this.list(principal);
    return {
      allowed: admin || collections.length > 0,
      admin,
      collections: collections.map((c) => ({ id: c.id, name: c.name, capabilities: c.capabilities })),
    };
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
  /**
   * Create a collection if it is absent; leave it alone if it is present.
   *
   * Idempotent, and that is the point: this is the shape a deploy script, a boot hook or
   * a test setup wants — "make sure this exists" — where `create` throws the second time
   * and forces every caller to write the same try/ignore around it.
   *
   * Unlike `create` this takes an explicit `id` and no principal. It is a server-side
   * operation, the way `init()` used to be, so anything exposing it over HTTP does its
   * own authorization first. `store` defaults to the service's configured store, so the
   * common case — one collection on the drive's own storage — is a name and nothing else.
   *
   * @param {object} spec
   * @param {string} spec.id
   * @param {string} [spec.name]
   * @param {object} [spec.store] defaults to the configured defaultStore
   * @param {object} [spec.acl] defaults to open when the service was built with defaultOpen
   * @returns {Promise<{record: object, created: boolean}>}
   */
  async ensure({ id, name, description, store, acl, system = false } = {}) {
    if (!id) throw TroveError.invalid('ensure needs a collection id');
    const existing = await this.kv.get(NS, id);
    if (existing) return { record: existing, created: false };

    const config = store || this.defaultStore;
    if (!config?.driver) throw TroveError.invalid('A backing store (driver + config) is required');
    try {
      this.storageFactory(config);
    } catch (err) {
      throw TroveError.invalid(`Invalid store config: ${err.message}`, { cause: err });
    }
    const record = {
      id,
      name: (name || id).trim(),
      description: description || '',
      store: config,
      acl: acl || {
        grants: this.defaultOpen
          ? [{ type: 'anyone', capabilities: [...CAPABILITIES] }]
          : [],
      },
      createdAt: Date.now(),
      createdBy: 'system',
      system,
    };
    await this.kv.set(NS, id, record);
    return { record, created: true };
  }

  async create({ name, description, store, acl, encryption }, principal) {
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
    // Set at creation so the very first upload is covered. Enabling it later is allowed and
    // only affects what arrives after — nothing retroactively encrypts what is already
    // there, and pretending otherwise would be the more dangerous lie.
    if (encryption !== undefined) {
      const set = await this.#encryptionFor(encryption, null, null);
      record.encryption = set.encryption;
      if (set.keys) record.$keys = set.keys;
    }
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
    // Turning encryption ON affects only what is uploaded from now on, and turning it OFF
    // does not decrypt anything: every object records its own envelope, so what is already
    // stored keeps working either way. Changing the FINGERPRINT is a different act — that
    // is a key rotation, and rotating without re-encrypting would orphan every existing
    // object. Refused here; the rotation job is what does it safely.
    if (patch.encryption !== undefined) {
      // Turning encryption ON affects only what is uploaded from now on, and turning it OFF
      // decrypts nothing: every object records its own envelope, so what is already stored
      // keeps working either way. The KEY is never replaced here — it is generated once and
      // kept, because every stored object names the key it was sealed with. Replacing one
      // is rotation, and rotation re-encrypts.
      const set = await this.#encryptionFor(patch.encryption, c.encryption, c.$keys);
      next.encryption = set.encryption;
      if (set.keys) next.$keys = set.keys;
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

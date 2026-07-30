// API keys: a credential that carries CAPABILITIES and no identity.
//
// This is deliberately not "log in as a robot user". An API key does not answer "who is
// this", it answers "what may this request do" — and those are different questions that
// the rest of the drive already keeps apart: IdentityProvider says who, the collection
// ACL says what. A key skips the first question entirely.
//
// The pattern is not new here. Signed URLs (signedUrls.js) already work this way: a valid
// signature is served WITHOUT a principal because it was minted by someone who held the
// capability it grants. A key is that idea with a longer life, a broader scope, and a
// record you can revoke. Both are grants; neither is a login.
//
// Consequences worth being deliberate about:
//
//   Attribution is to the KEY, not a person. `createdBy` records who minted it, so an
//   audit trail exists, but a write made with a key is the key's write. If you need
//   per-person attribution, that is what identity is for — do not hand one key to five
//   people and expect the log to tell them apart.
//
//   Scope is per collection and explicit. A key names the collections it may touch and
//   the capabilities it holds on each. Drive-wide access exists but has to be asked for
//   ('*'), because the difference between "this one bucket" and "everything" should never
//   be a thing you get by leaving a field blank.
//
//   The secret is never stored. Only a SHA-256 of it, so a dump of the KV store yields
//   nothing replayable. It is shown to the minter exactly once.

import { TroveError } from './errors.js';
import { CAPABILITIES, expand } from './collections/index.js';

const NS = 'api-keys';

/** Every collection, rather than a named one. Spelled out so it cannot be a typo. */
export const ANY_COLLECTION = '*';

// `trv_<id>_<secret>`. The id travels in the credential so verification is a single
// keyed read rather than a scan-and-compare over every key in the store — which is both
// slower and a timing oracle over how many keys exist.
const PREFIX = 'trv';
const ID_PREFIX = 'key';
const SECRET_BYTES = 32;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomB64(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

/**
 * Hex, for the id half only.
 *
 * base64url would be shorter but its alphabet includes `_`, which is the separator —
 * so an id could contain one and the credential would no longer parse into id and
 * secret. Hex has no such overlap, and the id is not the part carrying the entropy.
 */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return b64url(new Uint8Array(digest));
}

/**
 * Compare without leaking where two strings diverge.
 *
 * The hash of a presented secret against the stored hash. A `===` here would return
 * faster the earlier it finds a difference, which over enough attempts is a way to learn
 * a prefix — the classic reason credential comparison is not string equality.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Normalise and validate one `{ collectionId, capabilities }` entry. */
function normalizeScope(scope) {
  const collectionId = String(scope?.collectionId ?? '').trim();
  if (!collectionId) throw TroveError.invalid('Every scope needs a collectionId (or "*")');
  const caps = [...new Set(scope?.capabilities ?? [])];
  if (!caps.length) throw TroveError.invalid(`Scope for "${collectionId}" grants no capabilities`);
  for (const c of caps) {
    if (!CAPABILITIES.includes(c)) {
      throw TroveError.invalid(`Unknown capability "${c}" — expected one of: ${CAPABILITIES.join(', ')}`);
    }
  }
  return { collectionId, capabilities: caps };
}

/**
 * A resolved key, as the authorization layer sees it.
 *
 * Shaped to be the answer to one question — "what may this request do to this
 * collection" — so the access layer never has to know it came from a key rather than
 * from a signature or an ACL.
 */
export class ApiKeyGrant {
  constructor({ keyId, name, scopes }) {
    this.kind = 'api-key';
    this.keyId = keyId;
    this.name = name;
    this.scopes = scopes;
  }

  /**
   * The capabilities this key holds on one collection, `admin` expanded to everything
   * it implies (the same expansion the collection ACL uses, so a key and a grant mean
   * the same thing by the word "admin").
   *
   * @returns {Set<string>}
   */
  capabilitiesFor(collectionId) {
    const held = new Set();
    for (const scope of this.scopes) {
      if (scope.collectionId !== ANY_COLLECTION && scope.collectionId !== collectionId) continue;
      for (const c of scope.capabilities) held.add(c);
    }
    return expand(held);
  }

  /** Whether this key may do `capability` to `collectionId` at all. */
  can(collectionId, capability) {
    return this.capabilitiesFor(collectionId).has(capability);
  }
}

/**
 * Mint, verify and revoke API keys.
 *
 * Records live in the pluggable KV store, so this works on every backend the drive runs
 * on and survives restarts without a migration.
 */
export class ApiKeyService {
  /**
   * @param {object} deps
   * @param {import('./kv.js').KeyValueStore} deps.kv
   * @param {() => number} [deps.now] injected clock, for tests
   */
  constructor({ kv, now = () => Date.now() } = {}) {
    if (!kv) throw TroveError.invalid('ApiKeyService requires a kv store');
    this.kv = kv;
    this.now = now;
  }

  /**
   * Create a key. The secret is returned ONCE and never stored.
   *
   * @param {object} spec
   * @param {string} spec.name              what it is for, so a list of keys is readable
   * @param {Array<{collectionId: string, capabilities: string[]}>} spec.scopes
   * @param {number|null} [spec.expiresAt]  epoch ms; null never expires
   * @param {string|null} [spec.createdBy]  principal id of the minter, for the audit trail
   * @returns {Promise<{record: object, secret: string}>}
   */
  async mint({ name, scopes, expiresAt = null, createdBy = null } = {}) {
    const label = String(name ?? '').trim();
    if (!label) throw TroveError.invalid('An API key needs a name');
    if (!Array.isArray(scopes) || !scopes.length) {
      throw TroveError.invalid('An API key needs at least one scope — a key that grants nothing is not useful');
    }
    const normalized = scopes.map(normalizeScope);
    if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= this.now())) {
      throw TroveError.invalid('expiresAt must be a future timestamp');
    }

    const id = `${ID_PREFIX}_${randomHex(8)}`;
    const secret = `${PREFIX}_${id}_${randomB64(SECRET_BYTES)}`;
    const record = {
      id,
      name: label,
      // The hash of the WHOLE credential, so a stolen record cannot be turned back into
      // something presentable even by someone who knows the id.
      hash: await sha256(secret),
      scopes: normalized,
      createdAt: this.now(),
      createdBy,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.kv.set(NS, id, record);
    return { record: redact(record), secret };
  }

  /**
   * Resolve a presented secret into a grant, or null.
   *
   * Null for every failure — unknown, revoked, expired, malformed, wrong secret. The
   * caller turns that into one 401; distinguishing them in the response would tell an
   * attacker which key ids exist.
   *
   * @returns {Promise<ApiKeyGrant|null>}
   */
  async verify(secret) {
    if (typeof secret !== 'string') return null;
    // `trv_key_<hex id>_<secret>`. Parsed by prefix rather than by splitting on `_`,
    // because the secret half is base64url and may contain underscores of its own —
    // only the id is guaranteed not to.
    const head = `${PREFIX}_${ID_PREFIX}_`;
    if (!secret.startsWith(head)) return null;
    const rest = secret.slice(head.length);
    const boundary = rest.indexOf('_');
    if (boundary < 1 || boundary === rest.length - 1) return null;
    const id = `${ID_PREFIX}_${rest.slice(0, boundary)}`;

    const record = await this.kv.get(NS, id);
    if (!record || record.revokedAt) return null;
    if (record.expiresAt != null && record.expiresAt <= this.now()) return null;
    if (!timingSafeEqual(await sha256(secret), record.hash)) return null;

    return new ApiKeyGrant({ keyId: record.id, name: record.name, scopes: record.scopes });
  }

  /** Every key, without hashes. Newest first. */
  async list() {
    const rows = await this.kv.list(NS);
    return rows
      .map((r) => r.value)
      .filter(Boolean)
      .map(redact)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id) {
    const record = await this.kv.get(NS, id);
    return record ? redact(record) : null;
  }

  /**
   * Revoke by marking, not deleting.
   *
   * The record is what explains a key that used to work, and "why did this stop" is a
   * question worth being able to answer. It also keeps the id from being reissued.
   */
  async revoke(id) {
    const record = await this.kv.get(NS, id);
    if (!record) throw TroveError.notFound('API key');
    if (record.revokedAt) return redact(record);
    record.revokedAt = this.now();
    await this.kv.set(NS, id, record);
    return redact(record);
  }

  /**
   * Record that a key was used. Best-effort and never on the request path's critical
   * section: a failure to write "last used" must not fail the request it describes.
   */
  async touch(id) {
    try {
      const record = await this.kv.get(NS, id);
      if (!record || record.revokedAt) return;
      record.lastUsedAt = this.now();
      await this.kv.set(NS, id, record);
    } catch { /* the timestamp is a convenience, not a control */ }
  }
}

/** A record safe to send to a client: everything except the hash. */
function redact(record) {
  const { hash, ...rest } = record;
  return rest;
}

// --- the injection point -------------------------------------------------------

/**
 * How a request becomes a capability grant.
 *
 * The counterpart to IdentityProvider, and the reason it is separate: identity and
 * authority are different questions, and some credentials only answer the second.
 * Implement this to authorize from something other than a key — a mutual-TLS
 * certificate, a signed webhook, a service mesh header.
 */
export class CapabilityProvider {
  /**
   * @param {Request} request
   * @returns {Promise<ApiKeyGrant|null>} a grant, or null to abstain
   */
  async resolve(request) { // eslint-disable-line no-unused-vars
    return null;
  }
}

/** `Authorization: Bearer trv_key_…`, verified against the key store. */
export class ApiKeyCapabilityProvider extends CapabilityProvider {
  constructor({ apiKeys } = {}) {
    super();
    if (!apiKeys) throw TroveError.invalid('ApiKeyCapabilityProvider requires an ApiKeyService');
    this.apiKeys = apiKeys;
  }

  async resolve(request) {
    const header = request?.headers?.get?.('authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    // Only OUR prefix. A bearer token that is someone's OIDC access token must fall
    // through to the identity provider untouched, not be spent as a failed key lookup.
    if (!match || !match[1].startsWith(`${PREFIX}_`)) return null;
    return this.apiKeys.verify(match[1]);
  }
}

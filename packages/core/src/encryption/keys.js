// Turning what a user typed into the key an object is encrypted with, and into the
// fingerprint that says which key that was.
//
// The threat model this serves is the STORAGE HOST: the bucket holds ciphertext and
// nothing else, so a leaked bucket credential, a public-bucket misconfiguration, or a
// storage vendor who is not the compute vendor learns sizes and timestamps and no content.
// It is explicitly NOT end-to-end: the server holds the key so it can hand it to the
// client in an upload or download plan, and can decrypt for an indexer. The door to e2e
// stays open because nothing here depends on the server retaining the key — drop that and
// the client derives it from the passphrase instead, and every format below is unchanged.
//
// Two things in here are the difference between that story being true and being a story:
//
// THE KEY IS NOT A HASH OF THE PASSPHRASE. The adversary holds the ciphertext. Against
// `SHA-256(passphrase)` they can guess offline at billions of attempts a second, and a
// passphrase a human chose does not survive that. The key is derived with a deliberately
// slow KDF and a per-collection salt, so each guess costs real time and a guess against
// one collection is worthless against another.
//
// THE FINGERPRINT IS NOT A HASH OF THE KEY EITHER. It is published on every object and on
// the collection, which is exactly what makes it a free verification oracle: with
// `H(H(passphrase))` an attacker checks a guess with one hash instead of an attempted
// decryption. Deriving it through HKDF from the already-slow data key keeps the cost of a
// guess at the KDF, where it belongs.

import { TroveError } from '../errors.js';

const enc = new TextEncoder();

export const KEY_BYTES = 32; // AES-256
export const SALT_BYTES = 16;
export const FINGERPRINT_BYTES = 16;

/**
 * PBKDF2-HMAC-SHA256, and why it rather than Argon2id.
 *
 * Argon2id is the better function: it is memory-hard, so it resists GPUs and ASICs in a
 * way PBKDF2 does not. It is also not available in WebCrypto, which means shipping a WASM
 * build into a Cloudflare Workers bundle and into every browser page. PBKDF2 is in
 * WebCrypto on every runtime this drive supports, with no dependency at all.
 *
 * The honest summary: this is meaningfully weaker per unit of attacker cost than Argon2id,
 * and enormously stronger than the plain hash it replaces. The iteration count follows
 * OWASP's PBKDF2-SHA256 guidance.
 *
 * It is recorded per collection rather than assumed, so raising the count or moving to
 * Argon2id later is a new collection parameter and not a migration of everything that
 * already exists.
 */
export const DEFAULT_KDF = { name: 'PBKDF2-SHA256', iterations: 600_000 };

/** A fresh salt for a new collection. */
export function newSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * Derive a collection's data key from what the user typed.
 *
 * @param {string} userKey the passphrase
 * @param {Uint8Array} salt per collection
 * @param {{name?: string, iterations?: number}} [kdf]
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function deriveDataKey(userKey, salt, kdf = DEFAULT_KDF) {
  if (typeof userKey !== 'string' || !userKey) throw TroveError.invalid('A key is required');
  if (!(salt instanceof Uint8Array) || salt.length < 8) throw TroveError.invalid('A usable salt is required');
  const name = kdf?.name || DEFAULT_KDF.name;
  if (name !== 'PBKDF2-SHA256') {
    // Named, not guessed at. A collection written by a newer client with a different KDF
    // must say so rather than be silently derived the old way and fail to decrypt.
    throw TroveError.invalid(`This collection uses key derivation "${name}", which this client does not implement`);
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(userKey), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf?.iterations || DEFAULT_KDF.iterations },
    base,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The public name of a key.
 *
 * Safe to store on the collection and to stamp into every object, because it is derived
 * from the data key — which is already the expensive side of a guess — rather than from
 * the passphrase. Its job is matching, never proving: it says "this object wants that
 * key", and only an actual decryption says whether a key is right.
 *
 * @param {Uint8Array} dataKey
 * @returns {Promise<Uint8Array>} 16 bytes
 */
export async function fingerprint(dataKey) {
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== KEY_BYTES) {
    throw TroveError.invalid('A data key must be 32 bytes');
  }
  const base = await crypto.subtle.importKey('raw', dataKey, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    // A fixed, distinct label: the same key derived for another purpose must not produce
    // this value, or the fingerprint would leak something usable elsewhere.
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('trove-key-id') },
    base,
    FINGERPRINT_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Bytes as lowercase hex — how a salt and a fingerprint are written into a record. */
export function toHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** Fingerprints as text, for a collection record and for comparing. */
export const fingerprintHex = toHex;
export function fingerprintFromHex(hex) {
  if (typeof hex !== 'string' || hex.length !== FINGERPRINT_BYTES * 2 || /[^0-9a-f]/i.test(hex)) {
    throw TroveError.invalid('Not a key fingerprint');
  }
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

/**
 * Everything a collection needs to record about its key, given the passphrase.
 *
 * The passphrase itself is not in the result. What the collection stores is the salt, the
 * KDF parameters and the fingerprint — enough to derive the key again from the passphrase,
 * and not enough to derive it without.
 */
export async function describeKey(userKey, { salt = newSalt(), kdf = DEFAULT_KDF } = {}) {
  const dataKey = await deriveDataKey(userKey, salt, kdf);
  const fp = await fingerprint(dataKey);
  return {
    dataKey,
    config: {
      kdf: { ...kdf },
      salt: toHex(salt),
      fingerprint: fingerprintHex(fp),
    },
  };
}

/**
 * Does this passphrase open this collection?
 *
 * Answers before a download rather than after, so a wrong key is "that is not the key for
 * this collection" at the prompt instead of a failed decryption on an unrelated screen.
 */
export async function matchesCollection(userKey, config) {
  const salt = fingerprintFromHexLoose(config.salt);
  const dataKey = await deriveDataKey(userKey, salt, config.kdf);
  const fp = fingerprintHex(await fingerprint(dataKey));
  return { ok: fp === config.fingerprint, dataKey: fp === config.fingerprint ? dataKey : null };
}

/** Salt is the same hex shape as a fingerprint but its own length. */
function fingerprintFromHexLoose(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 || /[^0-9a-f]/i.test(hex)) {
    throw TroveError.invalid('Not a salt');
  }
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

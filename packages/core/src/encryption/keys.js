// The key a collection's objects are encrypted with, and the fingerprint that names it.
//
// The threat model is the STORAGE HOST, and only that: the bucket holds ciphertext, so a
// leaked bucket credential, a public-bucket misconfiguration, or a storage vendor who is
// not the compute vendor learns sizes and timestamps and no content. The server holds the
// key — it has to, in order to hand it to a client and to decrypt for an indexer — so this
// is explicitly not end-to-end and does not pretend to be.
//
// Which is why the key is GENERATED rather than derived from something a user types.
// A passphrase would buy nothing here: the server knows the key either way, so there is no
// protection to gain from the user holding it, and every cost still applies — a slow KDF
// on every unlock, a prompt in front of every collection, a key that can be forgotten and
// then cannot be reset by anyone, and a re-encryption of everything whenever someone
// changes their password. A random 256-bit key has none of that and is stronger than any
// passphrase a person would choose.
//
// Access to the key is therefore an ACCESS-CONTROL question, not a knowledge one: whoever
// may read the collection may have the key, because they may already read its contents.
//
// If this ever becomes end-to-end, the change is confined to where the key comes from and
// who is allowed it. The envelope, the fingerprint, and every stored object are unchanged.

import { TroveError } from '../errors.js';

const enc = new TextEncoder();

export const KEY_BYTES = 32; // AES-256
export const FINGERPRINT_BYTES = 16;

/** A new collection key. Random, because there is nothing to derive it from. */
export function generateDataKey() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * The public name of a key.
 *
 * Stamped into every object and recorded on the collection, so an object can be matched to
 * a key by whoever holds it — which is what makes a sideloaded object identifiable and
 * what lets a key rotation tell what it has already converted.
 *
 * Derived through HKDF rather than being a plain hash of the key. With a random 256-bit key
 * there is nothing to guess, so this is no longer load-bearing against an offline attack;
 * it stays because a fingerprint should be a value derived FOR this purpose, and a bare
 * `SHA-256(key)` is a value that might mean something somewhere else. The label makes it
 * unambiguously this and nothing else.
 *
 * @param {Uint8Array} dataKey
 * @returns {Promise<Uint8Array>} 16 bytes — far past collision risk for "which key is this"
 */
export async function fingerprint(dataKey) {
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== KEY_BYTES) {
    throw TroveError.invalid('A data key must be 32 bytes');
  }
  const base = await crypto.subtle.importKey('raw', dataKey, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('trove-key-id') },
    base,
    FINGERPRINT_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Bytes as lowercase hex — how a key and a fingerprint are written down. */
export function toHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 || /[^0-9a-f]/i.test(hex)) {
    throw TroveError.invalid('Not hex');
  }
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

/** Kept as the name the rest of the code already uses for a fingerprint in hex. */
export const fingerprintHex = toHex;

/**
 * A fresh key and what the collection records about it.
 *
 * The key is returned separately from the config because they go to different places: the
 * config is what any reader may see, and the key is what the server keeps.
 */
export async function newCollectionKey() {
  const dataKey = generateDataKey();
  return { dataKey, config: { fingerprint: toHex(await fingerprint(dataKey)) } };
}

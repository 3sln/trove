// Which items in a collection get encrypted, and what the collection tells a client
// about its key.
//
// Encryption is per collection and selective within it, because "encrypt everything" is
// not always what someone wants and the cost is not free: an encrypted object cannot be
// served straight from the bucket to something that does not hold the key, and the storage
// host can no longer deduplicate it. So a collection says which extensions and which media
// types are sensitive, and the rest is stored as it always was.
//
// The rules are matched at UPLOAD time and the answer is recorded in the object itself —
// the envelope header — rather than re-derived later. Rules change; an object that was
// encrypted must stay readable as an encrypted object regardless of what the collection
// says today, and one that was not must not suddenly be interpreted as one.

import { TroveError } from '../errors.js';
import { DEFAULT_KDF } from './keys.js';

/**
 * What a collection stores about its encryption.
 *
 * `salt`, `kdf` and `fingerprint` are safe to show anyone: they are what a client needs in
 * order to turn a passphrase into the key, and they are useless without the passphrase.
 * That is the point of deriving the fingerprint through HKDF rather than hashing the
 * passphrase — see keys.js.
 *
 * @typedef {object} EncryptionConfig
 * @property {boolean} enabled
 * @property {string} salt hex
 * @property {string} fingerprint hex — which key this collection wants
 * @property {{name: string, iterations: number}} kdf
 * @property {{extensions: string[], mimeTypes: string[], all: boolean}} rules
 */

const normList = (v) => (Array.isArray(v) ? v : [])
  .map((s) => String(s || '').trim().toLowerCase())
  .filter(Boolean);

/** An extension without its dot, so ".PDF", "PDF" and "pdf" are one rule. */
const normExt = (e) => e.replace(/^\./, '');

/**
 * Validate and normalise what a caller asked for.
 *
 * Refuses rather than repairs when the key material is incoherent: a collection recorded
 * as encrypted with no fingerprint is one whose objects can never be matched to a key.
 */
export function normalizeEncryption(input) {
  if (!input || input.enabled === false) return null;
  const { salt, fingerprint, kdf, rules } = input;
  if (!salt || !fingerprint) {
    throw TroveError.invalid('An encrypted collection needs a salt and a key fingerprint');
  }
  if (!/^[0-9a-f]{32}$/.test(String(fingerprint))) {
    throw TroveError.invalid('Not a key fingerprint');
  }
  const r = rules || {};
  const out = {
    enabled: true,
    salt: String(salt),
    fingerprint: String(fingerprint),
    kdf: { name: kdf?.name || DEFAULT_KDF.name, iterations: kdf?.iterations || DEFAULT_KDF.iterations },
    rules: {
      all: !!r.all,
      extensions: [...new Set(normList(r.extensions).map(normExt))],
      mimeTypes: [...new Set(normList(r.mimeTypes))],
    },
  };
  if (!out.rules.all && !out.rules.extensions.length && !out.rules.mimeTypes.length) {
    // Enabling encryption and matching nothing is almost certainly a mistake, and a silent
    // one: every upload would be stored in the clear on a collection labelled encrypted.
    throw TroveError.invalid(
      'This collection is set to encrypt, but no file would match. Choose "all files", or name some extensions or media types.',
    );
  }
  return out;
}

/**
 * Should this item be encrypted?
 *
 * A media type match is by full type or by its leading part, so `image` covers
 * `image/png` without listing every format — which is how someone actually thinks about
 * "encrypt my photos".
 */
export function shouldEncrypt(encryption, { name = '', contentType = '' } = {}) {
  if (!encryption?.enabled) return false;
  const { rules } = encryption;
  if (rules.all) return true;

  const ext = normExt((String(name).match(/\.[^./\\]+$/) || [''])[0].toLowerCase());
  if (ext && rules.extensions.includes(ext)) return true;

  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!type) return false;
  if (rules.mimeTypes.includes(type)) return true;
  const [top] = type.split('/');
  return !!top && rules.mimeTypes.includes(top);
}

/**
 * What a client is told about a collection's encryption.
 *
 * Includes everything needed to derive the key from a passphrase and nothing that helps
 * without one. `locked` is the client's cue to prompt: the collection wants a key, and
 * whether this browser currently holds it is not something the server knows.
 */
export function describeEncryption(encryption) {
  if (!encryption?.enabled) return null;
  return {
    enabled: true,
    salt: encryption.salt,
    fingerprint: encryption.fingerprint,
    kdf: { ...encryption.kdf },
    rules: { ...encryption.rules },
  };
}

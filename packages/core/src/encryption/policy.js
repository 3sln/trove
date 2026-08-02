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

/**
 * What a collection stores about its encryption.
 *
 * The fingerprint is safe to show anyone who may see the collection: it names the key
 * without being it. The key itself is never part of this, and never reaches a client at
 * all — see `#planEncryption`, which answers `sealedBy: 'server'`.
 *
 * @typedef {object} EncryptionConfig
 * @property {boolean} enabled
 * @property {string} fingerprint hex — which key this collection's objects are sealed with
 * @property {{extensions: string[], mimeTypes: string[], all: boolean}} rules
 */

const normList = (v) => (Array.isArray(v) ? v : [])
  .map((s) => String(s || '').trim().toLowerCase())
  .filter(Boolean);

/** An extension without its dot, so ".PDF", "PDF" and "pdf" are one rule. */
const normExt = (e) => e.replace(/^\./, '');

/**
 * Validate and normalise what a caller asked for, against the key the server holds.
 *
 * The fingerprint is a separate argument rather than a field of `input` because the two
 * come from different places and only one of them is the caller's to decide: rules are
 * asked for, the key is minted. A collection recorded as encrypted with no fingerprint is
 * one whose objects could never be matched to a key, so it is refused rather than repaired.
 *
 * @param {object|null} input   what the caller asked for: `{ enabled, rules }`
 * @param {string} [fingerprint] hex, from the collection's key
 */
export function normalizeEncryption(input, fingerprint) {
  if (!input || input.enabled === false) return null;
  const fp = fingerprint ?? input.fingerprint;
  if (!fp) throw TroveError.invalid('An encrypted collection needs a key fingerprint');
  if (!/^[0-9a-f]{32}$/.test(String(fp))) {
    throw TroveError.invalid('Not a key fingerprint');
  }
  const r = input.rules || {};
  const out = {
    enabled: true,
    fingerprint: String(fp),
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
 * What a client is told about a collection's encryption: `{ enabled, fingerprint, rules }`.
 *
 * Enough to know that objects here are sealed and which key seals them. There is no salt
 * and no KDF material, because there is no passphrase — the key is generated, and this
 * comment used to explain why handing out the KDF parameters was safe, describing a design
 * that no longer exists in the subsystem where being wrong is most expensive.
 *
 * A fingerprint names a key without being it, which is the whole reason it is safe to
 * publish: it is what lets a stored object say which key opens it, and a client say which
 * key a collection is currently on, without either of them holding one.
 *
 * There is no "locked" state and nothing to prompt for. The drive seals and unseals; a
 * client never decrypts, so there is nothing it needs beyond knowing that it happens.
 */
export function describeEncryption(encryption) {
  if (!encryption?.enabled) return null;
  return {
    enabled: true,
    fingerprint: encryption.fingerprint,
    rules: { ...encryption.rules },
  };
}

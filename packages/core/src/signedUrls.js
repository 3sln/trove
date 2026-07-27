// A URL that carries its own authorization.
//
// Some things cannot send an `Authorization` header and still need one object's bytes:
// an `<img src>`, a `<video src>`, `cache.add()` behind a service worker, an external
// API an indexer wants to hand a file to. For those the grant travels IN the URL.
//
// Two implementations, one contract — see docs/design/signed-urls.md:
//
//   - the backend can presign (S3/R2)  → the storage URL, bytes never touch the server
//   - it cannot (filesystem, NAS, …)   → ours: ?id=…&op=…&exp=…&sig=<hmac>
//
// Both are stateless with the expiry baked in: nothing stored, nothing to revoke,
// nothing to clean up. They stop verifying at `exp` and that is the whole lifecycle.
//
// The signature is a GRANT, not a hint. A request carrying a valid one is served without
// a principal, because the signature was minted by someone who held `read` on that node
// at the time. Which is why it covers the id and the op: a valid signature for a file you
// may see must not be editable into one for a file you may not.

import { TroveError } from './errors.js';

const MINUTES = 60;
const HOURS = 60 * MINUTES;

/**
 * What a signed URL may be for, and how long each may live.
 *
 * Content URLs are LONG on purpose — longer than it takes to consume almost anything.
 * The failure they prevent is a film that stops forty minutes in, or a download that
 * dies at 90% and cannot resume, and those are much worse than the exposure of a URL
 * that stays fetchable for a day.
 *
 * `index` is the exception and stays short: that one is handed to an external service
 * and leaves our control entirely, so it should be good for one prompt fetch and then
 * nothing.
 */
export const URL_PURPOSES = {
  index: { maxAge: 15 * MINUTES, defaultAge: 5 * MINUTES },
  // A browser download that stalls and resumes must not find its URL dead. Validated
  // when the transfer STARTS, so an in-flight 4 GB transfer finishes regardless.
  download: { maxAge: 12 * HOURS, defaultAge: 2 * HOURS },
  // A <video> re-requests on every seek, so this outlives the SITTING, not the request:
  // a long film, an audiobook session, an evening of episodes.
  media: { maxAge: 24 * HOURS, defaultAge: 12 * HOURS },
};

const enc = new TextEncoder();

/** base64url, because this ends up in a query string. */
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Signs and verifies one-object grants.
 *
 * The secret is the server's, never a user's — this is the deployment vouching for a
 * decision it already made, not an identity claim.
 */
export class SignedUrls {
  /**
   * @param {object} opts
   * @param {string} opts.secret signing secret (see the `urlSecret` provider — configured,
   *   or generated once and kept in the KV store so it survives restarts and is shared
   *   between instances)
   * @param {() => number} [opts.now] injected clock, for tests
   */
  constructor({ secret, now = () => Date.now() } = {}) {
    if (!secret || typeof secret !== 'string') {
      throw TroveError.invalid('SignedUrls requires a signing secret');
    }
    this._secret = secret;
    this._key = null;
    this.now = now;
  }

  async #hmacKey() {
    if (!this._key) {
      this._key = await crypto.subtle.importKey(
        'raw', enc.encode(this._secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
    }
    return this._key;
  }

  /**
   * The signature over one grant.
   *
   * Length-prefixed rather than joined on a separator: `('a|b', 'c')` and `('a', 'b|c')`
   * join to the same string, so a separator alone lets one field's value be pushed into
   * the next. Nobody has ever been bitten by that here, and nobody will be.
   */
  async sign({ id, op, exp }) {
    const parts = [String(id), String(op), String(exp)];
    const payload = parts.map((p) => `${p.length}:${p}`).join('');
    const sig = await crypto.subtle.sign('HMAC', await this.#hmacKey(), enc.encode(payload));
    return b64url(new Uint8Array(sig));
  }

  /** The query parameters that make a grant, for `op` on `id`, good for `expiresIn` seconds. */
  async grant(id, { op = 'download', expiresIn } = {}) {
    const purpose = URL_PURPOSES[op];
    if (!purpose) throw TroveError.invalid(`Unknown signed-URL purpose "${op}"`);
    // Capped server-side: `expiresIn` reaches here from a client and a URL good for a
    // year is the one thing this design cannot take back.
    const age = Math.min(Math.max(1, expiresIn || purpose.defaultAge), purpose.maxAge);
    const exp = Math.floor(this.now() / 1000) + age;
    return { id, op, exp, sig: await this.sign({ id, op, exp }), expiresAt: exp * 1000 };
  }

  /**
   * Whether these parameters are a grant we issued and that is still good.
   *
   * Returns a reason rather than a bare false: "expired" and "not ours" are different
   * events — the first is ordinary and the client should re-mint, the second is someone
   * editing URLs and is worth being able to see in a log.
   */
  async check({ id, op, exp, sig }) {
    if (!id || !op || !exp || !sig) return { ok: false, reason: 'incomplete' };
    if (!URL_PURPOSES[op]) return { ok: false, reason: 'unknown-purpose' };
    const at = Number(exp);
    if (!Number.isFinite(at)) return { ok: false, reason: 'malformed' };
    // Expiry BEFORE the signature check: an expired grant is not a security event, and
    // it is the overwhelmingly common failure. Cheap first.
    if (at * 1000 <= this.now()) return { ok: false, reason: 'expired' };
    const expected = await this.sign({ id, op, exp: at });
    return timingSafeEqual(expected, String(sig))
      ? { ok: true, id: String(id), op: String(op), expiresAt: at * 1000 }
      : { ok: false, reason: 'bad-signature' };
  }
}

/**
 * Constant-time string compare.
 *
 * `a === b` on a signature leaks where the first differing byte is, which over enough
 * requests is a forgery oracle. The cost of not caring is small and the cost of caring is
 * nothing.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A secret that survives a restart and is shared between instances.
 *
 * Configured is best. Failing that, one is generated and kept in the KV store — which is
 * what makes the fallback safe rather than convenient: a per-process random secret would
 * work perfectly on one machine and invalidate half the URLs in flight the moment a
 * second instance answered a request.
 */
const SECRET_NS = 'server';
const SECRET_KEY = 'urlSecret';

export async function resolveUrlSecret({ configured, kv } = {}) {
  if (configured) return configured;
  if (!kv) throw TroveError.invalid('Signed URLs need either a configured secret or a KV store to keep one in');
  const existing = await kv.get(SECRET_NS, SECRET_KEY);
  if (existing) return existing;
  const generated = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await kv.set(SECRET_NS, SECRET_KEY, generated);
  // Re-read rather than trust the write: a racing instance may have got there first, and
  // two instances signing with different secrets reject each other's URLs.
  return (await kv.get(SECRET_NS, SECRET_KEY)) || generated;
}

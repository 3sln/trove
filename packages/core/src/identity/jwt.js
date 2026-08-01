// JWT verification on Web Crypto — no node crypto, no deps, so it runs on Node,
// Bun, and Cloudflare Workers. Supports the algorithms an identity provider like
// Cloudflare Access / Zero Trust actually issues (RS256, ES256 via a JWKS
// endpoint) plus HS256 (shared secret) for local/dev. Trove never issues tokens;
// it only VERIFIES the one a trusted IdP put on the request, then builds a
// profile from the claims.

import { TroveError } from '../errors.js';

const enc = new TextEncoder();
// How long a `kid` miss suppresses another JWKS refetch. Long enough that a flood of
// unknown kids costs one request, short enough that a real key rotation is picked up
// well inside a token's lifetime.
const MISS_REFRESH_COOLDOWN_MS = 30_000;

export function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function base64urlToString(str) {
  return new TextDecoder().decode(base64urlToBytes(str));
}

/** Split & decode without verifying (header + payload only). */
export function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw TroveError.invalid('Malformed JWT');
  let header, payload;
  try {
    header = JSON.parse(base64urlToString(parts[0]));
    payload = JSON.parse(base64urlToString(parts[1]));
  } catch {
    throw TroveError.invalid('JWT is not valid JSON');
  }
  return { header, payload, parts };
}

const ALGS = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  HS256: { import: { name: 'HMAC', hash: 'SHA-256' }, verify: { name: 'HMAC' } },
};

/** A JWKS resolver with a small in-memory cache; refetches on a kid miss. */
export class JwksClient {
  constructor(url, { fetch: f = globalThis.fetch?.bind(globalThis), ttlMs = 3600_000 } = {}) {
    if (!url) throw TroveError.invalid('JwksClient requires a url');
    this.url = url;
    this._fetch = f;
    this.ttlMs = ttlMs;
    this.keys = new Map(); // kid -> jwk
    this.fetchedAt = 0;
  }
  async #refresh(force) {
    const now = this._now();
    if (!force && this.keys.size && now - this.fetchedAt < this.ttlMs) return;
    let res;
    try {
      res = await this._fetch(this.url);
    } catch (err) {
      throw TroveError.transient('Could not fetch JWKS', { cause: err });
    }
    if (!res.ok) throw TroveError.transient(`JWKS fetch failed (${res.status})`);
    const json = await res.json();
    this.keys = new Map((json.keys || []).map((k) => [k.kid, k]));
    this.fetchedAt = now;
  }
  _now() {
    // Date.now() is unavailable in some sandboxes; tolerate its absence.
    try {
      return Date.now();
    } catch {
      return this.fetchedAt || 0;
    }
  }
  async getJwk(kid) {
    await this.#refresh(false);
    // A miss forces a refetch so a freshly-rotated key is picked up — but ONLY if we
    // haven't just done that. Unbounded, this ran during authentication, before any
    // credential was checked, so anyone who could reach the API pinned one outbound
    // HTTPS request to the IdP per inbound request simply by varying `kid`.
    if (!this.keys.has(kid) && Date.now() - (this._lastMissRefresh || 0) > MISS_REFRESH_COOLDOWN_MS) {
      this._lastMissRefresh = Date.now();
      await this.#refresh(true);
    }
    return this.keys.get(kid) || null;
  }
}

/**
 * A fixed set of trusted keys — a JWKS you hold rather than one you fetch.
 *
 * Same interface as JwksClient, so `verifyJwt` can't tell them apart. It exists because
 * a JWKS URL assumes someone is running an endpoint to serve it, and plenty of
 * deployments simply mint their own tokens: a small team, a script, a gateway that
 * signs with a key you already have. Pointing those at a URL means standing up an HTTP
 * server whose entire job is to hand back a JSON document you could have pasted in.
 *
 * A token whose `kid` isn't in the set is refused. A set with exactly one key accepts a
 * token with no `kid` at all, since there is no ambiguity about which key was meant —
 * but with several, an unlabelled token is rejected rather than tried against each,
 * because "try every key until one verifies" turns key rotation into key confusion.
 */
export class StaticJwks {
  /** @param {{keys: object[]}|object[]} jwks a JWKS document or a bare array of JWKs */
  constructor(jwks) {
    const keys = Array.isArray(jwks) ? jwks : jwks?.keys;
    if (!Array.isArray(keys) || !keys.length) throw TroveError.invalid('StaticJwks requires at least one JWK');
    this.list = keys;
    this.keys = new Map(keys.filter((k) => k.kid).map((k) => [k.kid, k]));
  }
  async getJwk(kid) {
    if (kid) return this.keys.get(kid) || null;
    return this.list.length === 1 ? this.list[0] : null;
  }
}

async function importVerifyKey(alg, key) {
  const spec = ALGS[alg];
  if (!spec) throw TroveError.unsupported(`Unsupported JWT alg ${alg}`);
  if (alg === 'HS256') {
    const raw = typeof key === 'string' ? enc.encode(key) : key;
    return crypto.subtle.importKey('raw', raw, spec.import, false, ['verify']);
  }
  // key is a JWK object.
  return crypto.subtle.importKey('jwk', key, spec.import, false, ['verify']);
}

/**
 * Verify a JWT and return its payload, or throw a TroveError.
 * @param {string} token
 * @param {object} opts
 * @param {JwksClient} [opts.jwks]     for RS256/ES256
 * @param {string|Uint8Array} [opts.secret] for HS256
 * @param {string} [opts.issuer]       required `iss`
 * @param {string|string[]} [opts.audience] required `aud` (any match)
 * @param {string[]} [opts.algorithms] allow-list (default derived from key material)
 * @param {number} [opts.clockToleranceSec]
 * @param {number|null} [opts.now]     ms epoch; pass null to say there is no clock
 */
/** base64url WITHOUT padding, which is what a JWT wants everywhere. */
function bytesToBase64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a JWT with an EC P-256 private key.
 *
 * The mirror of `verifyJwt`, and it exists for one caller: answering an external policy
 * evaluation, where the asker fetches OUR public key to check the answer. That is why it
 * is asymmetric where `signedUrls.js` is happy with HMAC — a shared secret would mean
 * handing the verifier the ability to mint answers.
 *
 * ES256 only, deliberately. RS256 would work and needs a far larger key for the same
 * strength; there is one caller and it can use the better curve.
 */
export async function signJwt(payload, { privateJwk, kid, expiresInSec = 60, now = Date.now() } = {}) {
  if (!privateJwk) throw TroveError.invalid('Signing a JWT needs a private JWK');
  const iat = Math.floor(now / 1000);
  const body = { iat, exp: iat + expiresInSec, ...payload };
  const header = { alg: 'ES256', typ: 'JWT', ...(kid ? { kid } : {}) };
  const signingInput = `${bytesToBase64url(enc.encode(JSON.stringify(header)))}.`
    + `${bytesToBase64url(enc.encode(JSON.stringify(body)))}`;
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALGS.ES256.import, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(ALGS.ES256.verify, key, enc.encode(signingInput)));
  return `${signingInput}.${bytesToBase64url(sig)}`;
}

/**
 * The public half of a private JWK, as a JWKS entry.
 *
 * Strips `d` — the private scalar — and everything else a signer needs and a verifier must
 * not have. Written as a subtraction rather than a copy of the public fields so a JWK that
 * grows a field cannot silently start publishing it.
 */
export function publicJwkOf(privateJwk, { kid } = {}) {
  const { d, p, q, dp, dq, qi, ...pub } = privateJwk || {};
  return { ...pub, key_ops: ['verify'], use: 'sig', ...(kid ? { kid } : {}) };
}

export async function verifyJwt(token, opts = {}) {
  const { header, payload, parts } = decodeJwt(token);
  const alg = header.alg;
  const allowed = opts.algorithms || (opts.secret ? ['HS256'] : ['RS256', 'ES256']);
  if (!allowed.includes(alg)) throw TroveError.unauthorized(`JWT alg ${alg} not allowed`);

  let key;
  if (alg === 'HS256') {
    if (!opts.secret) throw TroveError.unauthorized('No secret configured for HS256');
    key = await importVerifyKey(alg, opts.secret);
  } else {
    if (!opts.jwks) throw TroveError.unauthorized('No JWKS configured');
    const jwk = await opts.jwks.getJwk(header.kid);
    if (!jwk) throw TroveError.unauthorized(`No JWKS key for kid ${header.kid}`);
    key = await importVerifyKey(alg, jwk);
  }

  const signingInput = enc.encode(parts[0] + '.' + parts[1]);
  const signature = base64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify(ALGS[alg].verify, key, signature, signingInput);
  if (!ok) throw TroveError.unauthorized('JWT signature is invalid');

  // Claims.
  // undefined means "not specified" (use the real clock); null means "there is no
  // clock". `??` would collapse the two, hiding the very case being configured — and
  // callers routinely pass `now: cfg.now` with cfg.now undefined.
  const nowMs = opts.now === undefined ? safeNow() : opts.now;
  const skew = opts.clockToleranceSec ?? 60;
  // No clock means no way to honour `exp`. Refusing is the only safe answer: treating
  // an unreadable clock as "not expired yet" would accept a token that expired last
  // year, which is precisely the failure expiry exists to prevent. Tokens carrying no
  // time claims are unaffected — there is nothing to check.
  if (nowMs == null && (payload.exp != null || payload.nbf != null)) {
    throw TroveError.unauthorized('JWT carries time claims but this runtime has no clock to check them against');
  }
  const now = Math.floor(nowMs / 1000);
  if (payload.exp != null && now > payload.exp + skew) throw TroveError.unauthorized('JWT expired');
  if (payload.nbf != null && now + skew < payload.nbf) throw TroveError.unauthorized('JWT not yet valid');
  if (opts.issuer && payload.iss !== opts.issuer) throw TroveError.unauthorized('JWT issuer mismatch');
  if (opts.audience) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const want = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
    if (!auds.some((a) => want.includes(a))) throw TroveError.unauthorized('JWT audience mismatch');
  }
  return payload;
}

/** ms epoch, or null when the runtime has no clock. Null, NOT 0 — see verifyJwt. */
function safeNow() {
  try {
    const t = Date.now();
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

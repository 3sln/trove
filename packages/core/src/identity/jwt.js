// JWT verification on Web Crypto — no node crypto, no deps, so it runs on Node,
// Bun, and Cloudflare Workers. Supports the algorithms an identity provider like
// Cloudflare Access / Zero Trust actually issues (RS256, ES256 via a JWKS
// endpoint) plus HS256 (shared secret) for local/dev. Trove never issues tokens;
// it only VERIFIES the one a trusted IdP put on the request, then builds a
// profile from the claims.

import { TroveError } from '../errors.js';

const enc = new TextEncoder();

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
    if (!this.keys.has(kid)) await this.#refresh(true);
    return this.keys.get(kid) || null;
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
 * @param {number} [opts.now]          ms epoch (for testing / sandboxes)
 */
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
  const now = Math.floor((opts.now ?? safeNow()) / 1000);
  const skew = opts.clockToleranceSec ?? 60;
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

function safeNow() {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

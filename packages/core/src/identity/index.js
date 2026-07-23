// Identity — Trove does not run a login system. It expects a trusted identity
// provider (Cloudflare Access / Zero Trust, an oauth2-proxy, an API gateway…) to
// authenticate the user and attach proof to each request, and it builds a
// *profile* (a Principal) around that. An IdentityProvider turns a request into a
// Principal (or null when anonymous access is allowed).
//
// Providers (all injectable into the server):
//   - JwtIdentityProvider    verify a bearer / Cf-Access-Jwt-Assertion JWT (JWKS)
//   - HeaderIdentityProvider trust a header a verifying proxy already set
//   - AnonymousIdentityProvider  everyone is one shared anonymous user (dev)
//
// A Principal: { id, email?, name?, picture?, roles?, claims }.

import { TroveError } from '../errors.js';
import { verifyJwt, JwksClient } from './jwt.js';

export class IdentityProvider {
  /** @returns {Promise<Principal|null>} */
  async authenticate(request) {
    return null;
  }
}

/** Normalize varied IdP claim shapes into a Principal. */
export function principalFromClaims(claims) {
  const id = claims.sub || claims.email || claims.user_id || claims.id;
  if (!id) return null;
  return {
    id: String(id),
    email: claims.email || null,
    name: claims.name || claims.given_name || claims.preferred_username || (claims.email ? claims.email.split('@')[0] : null),
    picture: claims.picture || null,
    roles: claims.roles || claims.groups || [],
    claims,
  };
}

function bearer(request) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1];
  // Cloudflare Access puts the assertion here.
  return request.headers.get('cf-access-jwt-assertion') || null;
}

export class JwtIdentityProvider extends IdentityProvider {
  /**
   * @param {object} cfg
   * @param {string} [cfg.jwksUrl]  e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
   * @param {string|Uint8Array} [cfg.secret]  for HS256 (dev)
   * @param {string} [cfg.issuer]
   * @param {string|string[]} [cfg.audience]  the Access application AUD
   * @param {boolean} [cfg.required]  reject anonymous requests (default false)
   * @param {(req)=>string|null} [cfg.getToken]  override token extraction
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.jwks = cfg.jwksUrl ? new JwksClient(cfg.jwksUrl, { fetch: cfg.fetch }) : null;
    this.getToken = cfg.getToken || bearer;
  }
  async authenticate(request) {
    const token = this.getToken(request);
    if (!token) {
      if (this.cfg.required) throw TroveError.unauthorized('Authentication required');
      return null;
    }
    const claims = await verifyJwt(token, {
      jwks: this.jwks, secret: this.cfg.secret,
      issuer: this.cfg.issuer, audience: this.cfg.audience,
      algorithms: this.cfg.algorithms, now: this.cfg.now,
    });
    const principal = principalFromClaims(claims);
    if (!principal) throw TroveError.unauthorized('JWT has no subject');
    return principal;
  }
}

/** Trust a header set by a verifying reverse proxy (already authenticated). */
export class HeaderIdentityProvider extends IdentityProvider {
  /** @param {{idHeader?: string, emailHeader?: string, nameHeader?: string, required?: boolean}} cfg */
  constructor(cfg = {}) {
    super();
    this.cfg = { idHeader: 'x-auth-user-id', emailHeader: 'x-auth-email', nameHeader: 'x-auth-name', ...cfg };
  }
  async authenticate(request) {
    const id = request.headers.get(this.cfg.idHeader) || request.headers.get(this.cfg.emailHeader);
    if (!id) {
      if (this.cfg.required) throw TroveError.unauthorized('Authentication required');
      return null;
    }
    const email = request.headers.get(this.cfg.emailHeader);
    return principalFromClaims({ sub: id, email, name: request.headers.get(this.cfg.nameHeader) });
  }
}

/** Everyone is the same anonymous user — the zero-config default. */
export class AnonymousIdentityProvider extends IdentityProvider {
  constructor({ id = 'anonymous', name = 'Anonymous' } = {}) {
    super();
    this.principal = { id, email: null, name, picture: null, roles: [], claims: {} };
  }
  async authenticate() {
    return this.principal;
  }
}

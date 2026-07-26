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
import { verifyJwt, JwksClient, StaticJwks } from './jwt.js';

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

/**
 * The credential on a request.
 *
 * `Cf-Access-Jwt-Assertion` is checked FIRST, and that order matters twice.
 *
 * Correctness: with Cloudflare's managed OAuth an agent holds an OPAQUE token, not a
 * JWT. It sends that in `Authorization: Bearer`, Access resolves it at the edge, and
 * the origin receives the real signed JWT in the assertion header. Reading Authorization
 * first means picking up the opaque string, failing to decode it, and refusing a request
 * that arrived with a perfectly good assertion attached.
 *
 * Security: the assertion header is set by the edge that just authenticated the request.
 * The Authorization header is whatever the client typed. When both are present, the one
 * we did not have to trust the client for is the one to believe.
 */
function bearer(request) {
  const assertion = request.headers.get('cf-access-jwt-assertion');
  if (assertion) return assertion;
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

/**
 * Everything Cloudflare Access needs, derived from the team name.
 *
 * Access is the deployment Trove was designed around, and configuring it by hand means
 * writing the team domain into three settings that must agree: a JWKS URL with a
 * `/cdn-cgi/access/certs` path nobody remembers, an issuer, and — since Access became an
 * OAuth authorization server for agents — the authorization server too. They are all the
 * same domain, so ask for it once.
 *
 * The audience is the Access **application** AUD tag, which is per-application and the
 * one value that genuinely cannot be derived. Without it a token minted for any other
 * app in the same Access account would be accepted here, so it is worth the argument.
 *
 * @param {{team: string, audience?: string|string[], required?: boolean}} cfg
 */
export function cloudflareAccess({ team, audience, required = true, ...rest } = {}) {
  const host = accessHost(team);
  if (!host) throw TroveError.invalid('cloudflareAccess requires a team name, e.g. "myteam" or "myteam.cloudflareaccess.com"');
  const issuer = `https://${host}`;
  return {
    jwksUrl: `${issuer}/cdn-cgi/access/certs`,
    issuer,
    audience: audience || undefined,
    // Behind Access, every request has already been authenticated at the edge. An
    // "anonymous" fallthrough would only fire when something is misconfigured, and
    // silently serving the drive to a shared anonymous user is the wrong way to find out.
    required,
    ...rest,
  };
}

/** Normalize `myteam`, `myteam.cloudflareaccess.com`, or the full URL to a hostname. */
export function accessHost(team) {
  if (!team) return null;
  let t = String(team).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!t) return null;
  if (!t.includes('.')) t = `${t}.cloudflareaccess.com`;
  // A team domain that isn't Cloudflare's is a typo we should not paper over: it would
  // send token verification, and now agent sign-in, to somewhere unintended.
  if (!t.endsWith('.cloudflareaccess.com')) {
    throw TroveError.invalid(`"${team}" is not a Cloudflare Access team domain (expected <team>.cloudflareaccess.com)`);
  }
  return t;
}

export class JwtIdentityProvider extends IdentityProvider {
  /**
   * @param {object} cfg
   * @param {string} [cfg.jwksUrl]  e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
   * @param {object|object[]} [cfg.jwks]  a JWKS document (or bare JWK array) to trust
   *   directly — the keychain for a deployment that mints its own tokens and has no
   *   JWKS endpoint to point at. Takes precedence over `jwksUrl`.
   * @param {string|Uint8Array} [cfg.secret]  for HS256 (dev)
   * @param {string} [cfg.issuer]
   * @param {string|string[]} [cfg.audience]  the Access application AUD
   * @param {boolean} [cfg.required]  reject anonymous requests (default false)
   * @param {(req)=>string|null} [cfg.getToken]  override token extraction
   */
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    // A held key set beats a fetched one: if you named the keys explicitly, that is the
    // stronger statement of intent, and it can't fail because a network hop did.
    this.jwks = cfg.jwks ? new StaticJwks(cfg.jwks)
      : cfg.jwksUrl ? new JwksClient(cfg.jwksUrl, { fetch: cfg.fetch })
        : null;
    this.getToken = cfg.getToken || bearer;
  }
  async authenticate(request) {
    const token = this.getToken(request);
    if (!token) {
      if (this.cfg.required) throw TroveError.unauthorized('Authentication required');
      return null;
    }
    let claims;
    try {
      claims = await verifyJwt(token, {
        jwks: this.jwks, secret: this.cfg.secret,
        issuer: this.cfg.issuer, audience: this.cfg.audience,
        algorithms: this.cfg.algorithms, now: this.cfg.now,
      });
    } catch (err) {
      // A credential we can't parse is an AUTHENTICATION failure, not a malformed
      // request: `decodeJwt` reports a garbled token as `invalid` (400), which tells a
      // client "you sent a bad request" when the truth is "sign in again". A transient
      // failure (the JWKS endpoint being down) is left alone — that is not the user's
      // token being wrong, and retrying is the right response to it.
      if (err?.code === 'transient') throw err;
      throw TroveError.unauthorized(err?.message || 'Authentication failed', { cause: err });
    }
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
    // `anonymous: true` is what lets everything downstream tell "one shared unnamed
    // user" apart from "a person who signed in". Without it the shape is identical to a
    // real principal, and the UI ends up showing a profile for somebody who doesn't
    // exist — an avatar, a name, a menu, all describing nobody.
    this.principal = { id, email: null, name, picture: null, roles: [], anonymous: true, claims: {} };
  }
  async authenticate() {
    return this.principal;
  }
}

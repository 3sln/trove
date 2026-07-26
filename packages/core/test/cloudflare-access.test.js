// Cloudflare Access, which is the deployment Trove was designed around.
//
// Two things are being pinned here. One is ergonomic: Access's JWKS path, its issuer,
// and — since it became an OAuth authorization server for agents — the place agents sign
// in are all the same domain, so asking for it three times is three chances to have them
// disagree. The other is a genuine correctness trap in how a token arrives.

import { test, expect } from 'bun:test';
import {
  cloudflareAccess, accessHost, JwtIdentityProvider, resolveAuthDiscovery, verifyJwt,
} from '../src/index.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function sign(claims) {
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

test('a team name is all it takes', () => {
  const cfg = cloudflareAccess({ team: 'acme', audience: 'aud-tag' });
  expect(cfg.jwksUrl).toBe('https://acme.cloudflareaccess.com/cdn-cgi/access/certs');
  expect(cfg.issuer).toBe('https://acme.cloudflareaccess.com');
  expect(cfg.audience).toBe('aud-tag');
  // Behind Access every request is already authenticated at the edge; falling through to
  // a shared anonymous user would only happen when something is misconfigured, and is
  // the wrong way to discover that.
  expect(cfg.required).toBe(true);
});

test('the team can be written any of the ways people write it', () => {
  for (const t of ['acme', 'acme.cloudflareaccess.com', 'https://acme.cloudflareaccess.com', 'https://acme.cloudflareaccess.com/']) {
    expect(accessHost(t)).toBe('acme.cloudflareaccess.com');
  }
  expect(accessHost('ACME')).toBe('acme.cloudflareaccess.com');
});

test('a domain that is not Cloudflare is refused rather than papered over', () => {
  // It would send both token verification and agent sign-in somewhere unintended.
  expect(() => accessHost('acme.example.com')).toThrow(/Cloudflare Access team domain/);
  expect(() => cloudflareAccess({ team: '' })).toThrow(/requires a team name/);
});

test('agents sign in at the same place tokens come from', () => {
  // Access is both the issuer and, under managed OAuth, the authorization server. One
  // domain, so the discovery document should need no separate setting.
  const auth = resolveAuthDiscovery({ identity: { jwt: cloudflareAccess({ team: 'acme' }) } });
  expect(auth.authorizationServers).toEqual(['https://acme.cloudflareaccess.com']);
  expect(auth.source).toBe('jwt-issuer');
  expect(auth.warnings).toEqual([]);
});

test('the Access assertion is preferred over an Authorization header', async () => {
  // THE trap. Under Cloudflare's managed OAuth an agent holds an OPAQUE token, not a
  // JWT: it sends that in Authorization, Access resolves it at the edge, and the origin
  // gets the real signed JWT in Cf-Access-Jwt-Assertion. Reading Authorization first
  // means grabbing an opaque string, failing to decode it, and refusing a request that
  // arrived properly authenticated.
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] }, issuer: 'https://acme.cloudflareaccess.com' });
  const assertion = await sign({ sub: 'alice@example.com', email: 'alice@example.com', iss: 'https://acme.cloudflareaccess.com' });

  const principal = await idp.authenticate(new Request('http://drive/api/items', {
    headers: {
      // What the agent sent — meaningless to us.
      authorization: 'Bearer AT.aBcDeF-opaque-cloudflare-token',
      // What the edge vouched for.
      'cf-access-jwt-assertion': assertion,
    },
  }));
  expect(principal.email).toBe('alice@example.com');
});

test('and it is also the one we did not have to trust the client for', async () => {
  // Same order, different reason: the assertion header is set by the edge that just
  // authenticated the request, while Authorization is whatever the caller typed.
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] }, issuer: 'https://acme.cloudflareaccess.com' });
  const real = await sign({ sub: 'alice@example.com', email: 'alice@example.com', iss: 'https://acme.cloudflareaccess.com' });
  const forged = await sign({ sub: 'admin@example.com', email: 'admin@example.com', iss: 'https://acme.cloudflareaccess.com' });
  const principal = await idp.authenticate(new Request('http://drive/api/items', {
    headers: { authorization: `Bearer ${forged}`, 'cf-access-jwt-assertion': real },
  }));
  expect(principal.email).toBe('alice@example.com');
});

test('a plain bearer token still works where there is no Access in front', async () => {
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] } });
  const token = await sign({ sub: 'bob@example.com', email: 'bob@example.com' });
  const principal = await idp.authenticate(new Request('http://drive/api/items', {
    headers: { authorization: `Bearer ${token}` },
  }));
  expect(principal.email).toBe('bob@example.com');
});

test('the audience check is what separates one Access app from another', async () => {
  // Every app in an Access account is signed by the same team keys. Without the AUD tag
  // a token minted for a different app in the same account verifies here perfectly.
  const idp = new JwtIdentityProvider(cloudflareAccess({ team: 'acme', audience: 'this-app' }));
  idp.jwks = { getJwk: async () => publicJwk }; // no network in a test
  const forOtherApp = await sign({ sub: 'x', email: 'x@e.com', iss: 'https://acme.cloudflareaccess.com', aud: 'some-other-app' });
  await expect(idp.authenticate(new Request('http://d/', { headers: { 'cf-access-jwt-assertion': forOtherApp } })))
    .rejects.toThrow(/audience/i);

  const forThisApp = await sign({ sub: 'x', email: 'x@e.com', iss: 'https://acme.cloudflareaccess.com', aud: 'this-app' });
  const p = await idp.authenticate(new Request('http://d/', { headers: { 'cf-access-jwt-assertion': forThisApp } }));
  expect(p.email).toBe('x@e.com');
});

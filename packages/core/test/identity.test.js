// JWT verification + identity providers. Mints tokens in-test (HS256 with a
// shared secret, ES256 with a generated key) and verifies the full claim checks,
// then drives JwtIdentityProvider / HeaderIdentityProvider / Anonymous.

import { test, expect } from 'bun:test';
import { verifyJwt, JwtIdentityProvider, HeaderIdentityProvider, AnonymousIdentityProvider, principalFromClaims, TroveError } from '../src/index.js';

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function mintHS256(payload, secret) {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

const NOW = 1_700_000_000_000;

test('verifyJwt HS256 with issuer/audience/exp', async () => {
  const secret = 'super-secret';
  const token = await mintHS256({ sub: 'u1', email: 'a@b.com', name: 'Ada', iss: 'trove', aud: 'app', exp: NOW / 1000 + 3600 }, secret);
  const claims = await verifyJwt(token, { secret, issuer: 'trove', audience: 'app', now: NOW });
  expect(claims.sub).toBe('u1');

  // Wrong audience rejected.
  await expect(verifyJwt(token, { secret, audience: 'other', now: NOW })).rejects.toThrow(TroveError);
  // Tampered signature rejected.
  await expect(verifyJwt(token.slice(0, -2) + 'xx', { secret, now: NOW })).rejects.toThrow();
  // Expired rejected.
  const old = await mintHS256({ sub: 'u1', exp: NOW / 1000 - 3600 }, secret);
  await expect(verifyJwt(old, { secret, now: NOW })).rejects.toThrow(/expired/i);
});

test('verifyJwt ES256 with a generated JWKS key', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  jwk.kid = 'k1';
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1' })));
  const body = b64url(enc.encode(JSON.stringify({ sub: 'u9', exp: NOW / 1000 + 60 })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(`${header}.${body}`));
  const token = `${header}.${body}.${b64url(sig)}`;

  const jwks = { getJwk: async (kid) => (kid === 'k1' ? jwk : null) };
  const claims = await verifyJwt(token, { jwks, now: NOW });
  expect(claims.sub).toBe('u9');
});

test('JwtIdentityProvider extracts a principal from the bearer token', async () => {
  const secret = 'k';
  const provider = new JwtIdentityProvider({ secret, now: NOW, algorithms: ['HS256'] });
  const token = await mintHS256({ sub: 'user-42', email: 'x@y.z', name: 'Grace', exp: NOW / 1000 + 60 }, secret);
  const req = new Request('http://t/api/me', { headers: { authorization: `Bearer ${token}` } });
  const principal = await provider.authenticate(req);
  expect(principal.id).toBe('user-42');
  expect(principal.name).toBe('Grace');

  // Missing token → null when not required, throws when required.
  expect(await provider.authenticate(new Request('http://t/'))).toBe(null);
  const strict = new JwtIdentityProvider({ secret, required: true, now: NOW });
  await expect(strict.authenticate(new Request('http://t/'))).rejects.toThrow(/required/i);
});

test('HeaderIdentityProvider + Anonymous', async () => {
  const h = new HeaderIdentityProvider({ idHeader: 'x-user', emailHeader: 'x-email' });
  const p = await h.authenticate(new Request('http://t/', { headers: { 'x-user': 'bob', 'x-email': 'bob@x.io' } }));
  expect(p.id).toBe('bob');
  expect(p.email).toBe('bob@x.io');

  const anon = new AnonymousIdentityProvider();
  expect((await anon.authenticate(new Request('http://t/'))).id).toBe('anonymous');
});

test('principalFromClaims normalizes shapes', () => {
  expect(principalFromClaims({ email: 'e@x.io' }).id).toBe('e@x.io');
  expect(principalFromClaims({})).toBe(null);
});

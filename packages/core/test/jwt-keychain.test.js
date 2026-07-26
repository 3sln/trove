// Naming the keys a deployment trusts, without running a JWKS endpoint to serve them.
//
// `jwksUrl` assumes someone is publishing a JWKS over HTTP. Plenty of deployments mint
// their own tokens — a gateway, a script, a small team — and for those, standing up an
// HTTP server whose whole job is to return a JSON document you already have is pure
// ceremony. `jwks` takes that document directly.

import { test, expect } from 'bun:test';
import { JwtIdentityProvider, StaticJwks, verifyJwt } from '../src/index.js';

// Mint a real ES256 key pair and sign real tokens — the point is to exercise the
// verifier, so nothing here is stubbed.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function sign(claims, { kid = 'k1', key = pair.privateKey } = {}) {
  const signingInput = `${enc({ alg: 'ES256', typ: 'JWT', ...(kid ? { kid } : {}) })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const request = (token) => new Request('http://t/api/items', { headers: { authorization: `Bearer ${token}` } });
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test('a held key set authenticates a token the same as a fetched one would', async () => {
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] }, issuer: 'https://trove.test', audience: 'trove' });
  const principal = await idp.authenticate(request(await sign({
    sub: 'alice', email: 'alice@example.com', name: 'Alice', roles: ['staff'],
    iss: 'https://trove.test', aud: 'trove', exp: soon(),
  })));
  expect(principal).toMatchObject({ id: 'alice', email: 'alice@example.com', name: 'Alice', roles: ['staff'] });
});

test('a token signed by a key we do not hold is rejected', async () => {
  // The whole value of naming keys: something signed by anything else is not us.
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] } });
  const forged = await sign({ sub: 'mallory', exp: soon() }, { key: other.privateKey });
  await expect(idp.authenticate(request(forged))).rejects.toMatchObject({ code: 'unauthorized' });
});

test('an unknown kid is refused rather than tried against every key', async () => {
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk, { ...publicJwk, kid: 'k2' }] } });
  await expect(idp.authenticate(request(await sign({ sub: 'a', exp: soon() }, { kid: 'k9' }))))
    .rejects.toMatchObject({ code: 'unauthorized' });
});

test('one key needs no kid; several do', async () => {
  // With a single key there is no ambiguity about which was meant. With several,
  // "try each until one verifies" would turn key rotation into key confusion — the
  // old key would keep working forever because nothing ever said which was intended.
  const single = new StaticJwks({ keys: [{ ...publicJwk, kid: undefined }] });
  expect(await single.getJwk(null)).toBeTruthy();
  const many = new StaticJwks({ keys: [publicJwk, { ...publicJwk, kid: 'k2' }] });
  expect(await many.getJwk(null)).toBe(null);
  expect(await many.getJwk('k2')).toBeTruthy();
});

test('issuer, audience, and expiry are all still enforced', async () => {
  const idp = new JwtIdentityProvider({ jwks: { keys: [publicJwk] }, issuer: 'https://trove.test', audience: 'trove' });
  const base = { sub: 'alice', iss: 'https://trove.test', aud: 'trove', exp: soon() };
  await expect(idp.authenticate(request(await sign({ ...base, iss: 'https://evil.test' })))).rejects.toThrow();
  await expect(idp.authenticate(request(await sign({ ...base, aud: 'another-app' })))).rejects.toThrow();
  await expect(idp.authenticate(request(await sign({ ...base, exp: Math.floor(Date.now() / 1000) - 600 })))).rejects.toThrow();
  // A minute of clock tolerance is deliberate — two machines are never exactly in step,
  // and rejecting a token that expired one second ago would produce mystery logouts.
  const barely = await sign({ ...base, exp: Math.floor(Date.now() / 1000) - 5 });
  expect((await idp.authenticate(request(barely))).id).toBe('alice');
});

test('a runtime with no clock refuses a token it cannot check, rather than trusting it', async () => {
  // Treating an unreadable clock as "not expired yet" would accept a token that expired
  // last year — exactly what expiry exists to prevent. Refusing is the only safe answer.
  const token = await sign({ sub: 'alice', exp: soon() });
  await expect(verifyJwt(token, { jwks: new StaticJwks({ keys: [publicJwk] }), now: null }))
    .rejects.toMatchObject({ code: 'unauthorized' });
  // …but a token with no time claims has nothing to check, so it still verifies.
  const timeless = await sign({ sub: 'alice' });
  expect((await verifyJwt(timeless, { jwks: new StaticJwks({ keys: [publicJwk] }), now: null })).sub).toBe('alice');
});

test('a held key set takes precedence over a URL, and needs no network', async () => {
  // If you named the keys, that is the stronger statement of intent — and it cannot
  // fail because a network hop did.
  const idp = new JwtIdentityProvider({
    jwks: { keys: [publicJwk] },
    jwksUrl: 'https://unreachable.invalid/keys',
    fetch: () => { throw new Error('the network must not be touched'); },
  });
  const principal = await idp.authenticate(request(await sign({ sub: 'alice', exp: soon() })));
  expect(principal.id).toBe('alice');
});

test('an empty key set is a configuration error, raised where it can be seen', async () => {
  expect(() => new StaticJwks({ keys: [] })).toThrow(/at least one JWK/);
  expect(() => new StaticJwks(null)).toThrow(/at least one JWK/);
});

test('required auth refuses an anonymous request; optional lets it through', async () => {
  const bare = new Request('http://t/api/items');
  expect(await new JwtIdentityProvider({ jwks: { keys: [publicJwk] } }).authenticate(bare)).toBe(null);
  await expect(new JwtIdentityProvider({ jwks: { keys: [publicJwk] }, required: true }).authenticate(bare))
    .rejects.toMatchObject({ code: 'unauthorized' });
});

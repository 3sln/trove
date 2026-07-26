// Where a refused client is told to go.
//
// This is the one piece of auth that Trove cannot verify for itself: it publishes a URL
// and a client sends a user — and eventually a bearer token — to whatever is there. So
// the failure modes are about publishing something wrong rather than accepting something
// wrong, and the worst of them is publishing a value that LOOKS configured.

import { test, expect } from 'bun:test';
import {
  resolveAuthDiscovery, usableAuthServer, protectedResourceMetadata, challengeHeaders, metadataUrl,
} from '../src/index.js';

test('the JWT issuer doubles as the authorization server when it is a URL', () => {
  // For an OIDC provider the issuer identifier IS the authorization server, and RFC 8414
  // locates its metadata relative to it. Making someone state the same URL under a
  // second name is a way to end up with two different answers.
  const r = resolveAuthDiscovery({ identity: { jwt: { issuer: 'https://login.example.com/' } } });
  expect(r.authorizationServers).toEqual(['https://login.example.com']);
  expect(r.source).toBe('jwt-issuer');
  expect(r.warnings).toEqual([]);
});

test('an issuer that is not a URL is NOT published as one', () => {
  // A JWT `iss` is StringOrURI. A deployment minting its own tokens routinely sets it to
  // a bare name, and publishing that as an authorization server sends a client off to
  // fetch `.well-known` from a string. An absent field makes a client say "nowhere to
  // sign in"; a garbage one makes it fail inside a fetch, which is strictly worse.
  for (const iss of ['my-gateway', 'urn:my:issuer', 'trove']) {
    const r = resolveAuthDiscovery({ identity: { jwt: { issuer: iss } } });
    expect(r.authorizationServers).toEqual([]);
    expect(r.source).toBe('none');
    // And it says why, rather than looking like nothing was configured at all.
    expect(r.warnings.join(' ')).toMatch(/not a URL/);
  }
  // Which means the document omits the field entirely — see protectedResourceMetadata.
  const doc = protectedResourceMetadata('https://d/mcp', resolveAuthDiscovery({ identity: { jwt: { issuer: 'my-gateway' } } }));
  expect('authorization_servers' in doc).toBe(false);
});

test('an http issuer is not inferred either, except on loopback', () => {
  // The OAuth flow and the token at the end of it travel over whatever this names.
  expect(usableAuthServer('https://auth.example.com')).toBe(true);
  expect(usableAuthServer('http://auth.example.com')).toBe(false);
  expect(usableAuthServer('http://localhost:9000')).toBe(true); // someone developing
  expect(usableAuthServer('http://127.0.0.1:9000')).toBe(true);
  expect(usableAuthServer('not a url')).toBe(false);
  expect(usableAuthServer('')).toBe(false);

  expect(resolveAuthDiscovery({ identity: { jwt: { issuer: 'http://auth.example.com' } } }).authorizationServers).toEqual([]);
});

test('an explicitly set plaintext server is honoured but complained about', () => {
  // The operator said what they meant, and refusing to boot over a config value is
  // heavy-handed. Publishing it silently is not an option either.
  const r = resolveAuthDiscovery({ authServer: 'http://auth.example.com' });
  expect(r.authorizationServers).toEqual(['http://auth.example.com']);
  expect(r.source).toBe('configured');
  expect(r.warnings.join(' ')).toMatch(/not an https URL/);
});

test('an explicit setting beats the issuer, for the deployments where they differ', () => {
  const r = resolveAuthDiscovery({
    authServer: 'https://auth.example.com',
    identity: { jwt: { issuer: 'https://login.example.com' } },
  });
  expect(r.authorizationServers).toEqual(['https://auth.example.com']);
  expect(r.source).toBe('configured');
});

test('nothing configured is reported as nothing, and the challenge says so', () => {
  const r = resolveAuthDiscovery({});
  expect(r.source).toBe('none');
  expect(r.authorizationServers).toEqual([]);
  const h = challengeHeaders('https://d', r);
  expect(h['www-authenticate']).toMatch(/TROVE_AUTH_SERVER/);
  // The pointer survives regardless — a client with no authorization server still needs
  // to be able to read the document that says so.
  expect(h['www-authenticate']).toContain(`resource_metadata="${metadataUrl('https://d')}"`);
});

test('several servers are accepted, and each is checked', () => {
  const r = resolveAuthDiscovery({ authServer: 'https://a.example.com, https://b.example.com/' });
  expect(r.authorizationServers).toEqual(['https://a.example.com', 'https://b.example.com']);
  expect(r.warnings).toEqual([]);
});

// Unit tests for the plugin package format, signing, and domain-verified trust.

import { test, expect } from 'bun:test';
import { parsePackage, reviewSummary } from '../src/platform/pluginPackage.js';
import { verifyPackage, assessTrust, checkAssetlinks, displayFingerprint } from '../src/platform/pluginSigning.js';
import { isAllowedUrl, endpointSummary, parseEndpoint } from '../src/platform/pluginNet.js';
import { buildModuleGraph, isModuleEntry, isSourceModule } from '../src/platform/pluginModules.js';
import { strToU8 } from 'fflate';
import { buildPackage, assetlinksFor } from './pluginFixture.mjs';

test('parsePackage reads + validates the manifest', async () => {
  const { zip } = await buildPackage();
  const pkg = parsePackage(zip);
  expect(pkg.manifest.id).toBe('com.trove.demo');
  expect(pkg.files.has('plugin.js')).toBe(true);
  expect(pkg.files.has('data.txt')).toBe(true);
});

test('parsePackage rejects a bad package', async () => {
  expect(() => parsePackage(new Uint8Array([1, 2, 3]))).toThrow(/zip/i);
  const { zip } = await buildPackage({ manifest: { entry: 'missing.js' } });
  expect(() => parsePackage(zip)).toThrow(/entry/i);
});

test('unsigned package → unverified', async () => {
  const { zip } = await buildPackage();
  const pkg = parsePackage(zip);
  const v = await verifyPackage(pkg);
  expect(v.signed).toBe(false);
  const trust = await assessTrust(pkg, async () => null);
  expect(trust.status).toBe('unverified');
});

test('signed package verifies; tampering breaks it', async () => {
  const { zip, fingerprint } = await buildPackage({ sign: true, domain: 'plugins.example.com' });
  const pkg = parsePackage(zip);
  const v = await verifyPackage(pkg);
  expect(v.signed).toBe(true);
  expect(v.valid).toBe(true);
  expect(v.fingerprint).toBe(fingerprint);

  // Tamper a file → content hash mismatch.
  pkg.files.set('plugin.js', new TextEncoder().encode('/* evil */'));
  const v2 = await verifyPackage(pkg);
  expect(v2.valid).toBe(false);
});

test('assessTrust: verified when the domain vouches for the key', async () => {
  const { zip, fingerprint } = await buildPackage({ sign: true, domain: 'plugins.example.com' });
  const pkg = parsePackage(zip);

  // Domain lists the key → verified.
  const verified = await assessTrust(pkg, async () => assetlinksFor(fingerprint, 'com.trove.demo'));
  expect(verified.status).toBe('verified');
  expect(verified.domain).toBe('plugins.example.com');

  // Domain doesn't list it → signed (self), not verified.
  const signed = await assessTrust(pkg, async () => ({ version: 1, keys: [] }));
  expect(signed.status).toBe('signed');

  // Domain unreachable → signed, with a reason.
  const unreachable = await assessTrust(pkg, async () => { throw new Error('offline'); });
  expect(unreachable.status).toBe('signed');
});

test('checkAssetlinks matches ignoring colon formatting + wildcard', () => {
  const fp = 'aabbccddeeff00112233';
  expect(checkAssetlinks(assetlinksFor(displayFingerprint(fp), 'x'), fp, 'x')).toBe(true);
  expect(checkAssetlinks({ version: 1, keys: [{ fingerprint: fp, plugins: ['*'] }] }, fp, 'anything')).toBe(true);
  expect(checkAssetlinks(assetlinksFor(fp, 'other'), fp, 'x')).toBe(false);
});

test('network allowlist: host/path/port/scheme + wildcard matching', () => {
  const eps = ['https://api.example.com/v1/', 'https://*.cdn.example.com/', 'http://localhost:8080/'];
  expect(isAllowedUrl(eps, 'https://api.example.com/v1/users?q=1')).toBe(true);
  expect(isAllowedUrl(eps, 'https://api.example.com/v2/users')).toBe(false); // path prefix
  expect(isAllowedUrl(eps, 'http://api.example.com/v1/users')).toBe(false); // scheme
  expect(isAllowedUrl(eps, 'https://img.cdn.example.com/a.png')).toBe(true); // wildcard subdomain
  expect(isAllowedUrl(eps, 'https://cdn.example.com/a.png')).toBe(true); // wildcard matches apex
  expect(isAllowedUrl(eps, 'https://evil.com/?x=https://api.example.com/v1/')).toBe(false);
  expect(isAllowedUrl(eps, 'http://localhost:8080/x')).toBe(true);
  expect(isAllowedUrl(eps, 'http://localhost:9090/x')).toBe(false); // port
  expect(isAllowedUrl([], 'https://api.example.com/')).toBe(false); // nothing declared → nothing allowed
});

test('parseEndpoint rejects non-http(s) + endpointSummary is review-friendly', () => {
  expect(() => parseEndpoint('ftp://example.com/')).toThrow(/http/i);
  expect(() => parseEndpoint('not a url')).toThrow(/http/i);
  const s = endpointSummary(['https://*.example.com/v1/']);
  expect(s[0]).toEqual({ scheme: 'https', host: '*.example.com', path: '/v1/', raw: 'https://*.example.com/v1/' });
});

test('package with a bad network endpoint is rejected; good ones surface in review', async () => {
  const bad = await buildPackage({ manifest: { network: ['ws://nope.example.com'] } });
  expect(() => parsePackage(bad.zip)).toThrow(/http/i);
  const { zip } = await buildPackage({ manifest: { capabilities: ['network', 'ui'], network: ['https://api.example.com/'] } });
  const s = reviewSummary(parsePackage(zip), { status: 'unverified' });
  expect(s.capabilities.find((c) => c.id === 'network')).toBeTruthy();
  expect(s.network.map((e) => e.host)).toEqual(['api.example.com']);
});

test('module graph: only src/ code is wired; relative imports are canonicalized', async () => {
  const files = new Map([
    ['manifest.json', strToU8('{}')],
    ['src/index.js', strToU8("import { helper } from './lib/util.js';\nimport 'trove';\nconst d = () => import('../src/late.js');\nexport const x = helper;")],
    ['src/lib/util.js', strToU8('export const helper = 1;')],
    ['src/late.js', strToU8('export default 2;')],
    ['data.txt', strToU8('an asset, not a module')],
  ]);
  const manifest = { entry: 'src/index.js' };
  expect(isModuleEntry(manifest)).toBe(true);
  expect(isSourceModule('data.txt')).toBe(false);

  const g = await buildModuleGraph({ manifest, files });
  expect(Object.keys(g.modules).sort()).toEqual(['src/index.js', 'src/late.js', 'src/lib/util.js']);
  const idx = g.modules['src/index.js'];
  expect(idx).toContain("from 'trove:/src/lib/util.js'");  // static relative → canonical key
  expect(idx).toContain("import 'trove'");                  // bare specifier left as-is
  expect(idx).toContain('import("trove:/src/late.js")');    // dynamic relative → re-quoted key
});

test('classic single-file packages stay in classic mode', () => {
  expect(isModuleEntry({ entry: 'plugin.js' })).toBe(false);
});

test('reviewSummary surfaces caps, contributions, settings + admin-only flag', async () => {
  const { zip } = await buildPackage({ manifest: { capabilities: ['ui', 'commands', 'serverStorage'] } });
  const pkg = parsePackage(zip);
  const s = reviewSummary(pkg, { status: 'unverified' });
  expect(s.name).toBe('Demo Plugin');
  expect(s.capabilities.find((c) => c.id === 'serverStorage').adminOnly).toBe(true);
  expect(s.contributions.length).toBeGreaterThan(0);
  expect(s.settings.find((x) => x.key === 'apiKey').secret).toBe(true);
});

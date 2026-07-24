// Unit tests for the plugin package format, signing, and domain-verified trust.

import { test, expect } from 'bun:test';
import { parsePackage, reviewSummary } from '../src/platform/pluginPackage.js';
import { verifyPackage, assessTrust, checkAssetlinks, displayFingerprint } from '../src/platform/pluginSigning.js';
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

test('reviewSummary surfaces caps, contributions, settings + admin-only flag', async () => {
  const { zip } = await buildPackage({ manifest: { capabilities: ['ui', 'commands', 'serverStorage'] } });
  const pkg = parsePackage(zip);
  const s = reviewSummary(pkg, { status: 'unverified' });
  expect(s.name).toBe('Demo Plugin');
  expect(s.capabilities.find((c) => c.id === 'serverStorage').adminOnly).toBe(true);
  expect(s.contributions.length).toBeGreaterThan(0);
  expect(s.settings.find((x) => x.key === 'apiKey').secret).toBe(true);
});

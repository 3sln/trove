// The injectable SDK (browser.js) is inlined into the sandboxed frame as TEXT, so it
// can't import protocol.js — it declares its own SDK_PROTOCOL_VERSION. These tests are
// the drift guard that keeps the two in step, plus the compatibility rules the host
// applies at handshake time.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, isCompatible, majorOf, METHODS } from '../src/protocol.js';

const browserSrc = readFileSync(fileURLToPath(new URL('../src/browser.js', import.meta.url)), 'utf8');

test('the injected SDK declares the same protocol version as protocol.js', () => {
  const m = browserSrc.match(/SDK_PROTOCOL_VERSION\s*=\s*'([^']+)'/);
  expect(m).toBeTruthy();
  expect(m[1]).toBe(PROTOCOL_VERSION);
});

test('the SDK sends its protocol version in the ready handshake', () => {
  expect(browserSrc).toContain("__trove: 'ready', protocolVersion: SDK_PROTOCOL_VERSION");
});

test('compatibility is by MAJOR; a missing version is accepted (pre-versioning SDK)', () => {
  expect(isCompatible(PROTOCOL_VERSION)).toBe(true);
  expect(isCompatible(undefined)).toBe(true); // predates the field
  expect(isCompatible(`${majorOf(PROTOCOL_VERSION)}.99`)).toBe(true); // additive minor
  expect(isCompatible('99.0')).toBe(false); // breaking major
});

test('every host method the SDK calls is declared in METHODS', () => {
  const declared = new Set(collect(METHODS));
  // Method names the SDK sends over the wire, e.g. call('storage:sql', …).
  const used = [...browserSrc.matchAll(/call\('([a-z]+:[a-zA-Z]+|activated)'/g)].map((m) => m[1]);
  expect(used.length).toBeGreaterThan(0);
  const undeclared = [...new Set(used)].filter((m) => !declared.has(m));
  expect(undeclared).toEqual([]);
});

function collect(obj) {
  return Object.values(obj).flatMap((v) => (typeof v === 'string' ? [v] : collect(v)));
}

// The ESM package entry must expose `activate` and be import-safe outside a
// browser (no DOM touched at import time), and it must be the SAME implementation
// the host injects — one source of truth, no drift.

import { test, expect } from 'bun:test';
import { activate as namedActivate, default as trove, RpcChannel } from '../src/index.js';

test('ESM entry exposes activate and sets globalThis.trove', () => {
  expect(typeof namedActivate).toBe('function');
  expect(globalThis.trove).toBeDefined();
  expect(typeof globalThis.trove.activate).toBe('function');
});

test('the named export IS the injected implementation (no second copy)', () => {
  expect(namedActivate).toBe(globalThis.trove.activate);
  expect(trove).toBe(globalThis.trove);
});

test('RpcChannel is re-exported for host/parity use', () => {
  expect(typeof RpcChannel).toBe('function');
});

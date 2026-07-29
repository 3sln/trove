// create-trove mints VAPID keys with its own copy of the algorithm, because it has no
// dependencies and runs before the project it writes has a node_modules. Duplication
// bought that, and this is the receipt: the pair it produces has to be one the drive
// can actually sign with, verified against the real implementation rather than against
// a description of it.

import { test, expect } from 'bun:test';
import { generateVapidKeys as scaffolderKeys } from '../src/vapid.js';
// A relative path, not the package name: create-trove is its own package with no
// dependency on the drive, which is the property being tested. Reaching across the
// repo is what a cross-package check looks like from inside one.
import { WebPushService, generateVapidKeys as coreKeys } from '../../core/src/notifications/webpush.js';

test('a scaffolded pair has the shape the Push API requires', async () => {
  const { publicKey, privateKey } = await scaffolderKeys();

  // The public half is the uncompressed EC point browsers want as
  // applicationServerKey: 0x04 followed by two 32-byte coordinates.
  const point = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  expect(point.length).toBe(65);
  expect(point[0]).toBe(0x04);

  // The private half is the raw 32-byte scalar.
  const d = Uint8Array.from(atob(privateKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  expect(d.length).toBe(32);

  // base64url, so it survives an env file and a TOML string without escaping.
  expect(publicKey).not.toMatch(/[+/=]/);
  expect(privateKey).not.toMatch(/[+/=]/);
});

test('the copy agrees with the implementation it was copied from', async () => {
  const mine = await scaffolderKeys();
  const theirs = await coreKeys();
  // Different keys — they are random — but the same encoding and the same lengths.
  expect(mine.publicKey.length).toBe(theirs.publicKey.length);
  expect(mine.privateKey.length).toBe(theirs.privateKey.length);
  expect(mine.publicKey).not.toBe(theirs.publicKey);
});

test('the drive accepts a scaffolded pair', async () => {
  // The assertion that matters: WebPushService is what signs a push, and it is the
  // thing that would reject a malformed key. A pair that gets this far is one a
  // deployed drive can use.
  const keys = await scaffolderKeys();
  const service = new WebPushService({ ...keys, subject: 'mailto:admin@example.com' });
  expect(service.publicKey).toBe(keys.publicKey);
});

test('every pair is a new pair', async () => {
  const [a, b] = await Promise.all([scaffolderKeys(), scaffolderKeys()]);
  expect(a.privateKey).not.toBe(b.privateKey);
});

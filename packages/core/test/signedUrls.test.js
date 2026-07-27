// Signed URLs: a grant that travels in the query string, for the things that cannot
// send a header — an <img src>, a <video src>, cache.add(), an external API an indexer
// hands a file to.

import { test, expect } from 'bun:test';
import { SignedUrls, resolveUrlSecret, URL_PURPOSES } from '../src/signedUrls.js';
import { MemoryKV } from '../src/kv.js';

const at = (ms) => () => ms;
const T0 = 1_700_000_000_000;

test('a grant verifies, and only for exactly what it was minted for', async () => {
  const s = new SignedUrls({ secret: 'shh', now: at(T0) });
  const g = await s.grant('node-1', { op: 'media' });
  expect((await s.check(g)).ok).toBe(true);

  // The signature covers the id, so a grant for a file you may see cannot be edited into
  // one for a file you may not. That is the whole reason this is safe to hand out.
  expect((await s.check({ ...g, id: 'node-2' }))).toEqual({ ok: false, reason: 'bad-signature' });
  // …and the op, so a read grant cannot be promoted to another purpose's longer life.
  expect((await s.check({ ...g, op: 'download' })).reason).toBe('bad-signature');
  // …and the expiry, so nobody extends their own grant.
  expect((await s.check({ ...g, exp: g.exp + 86400 })).reason).toBe('bad-signature');
  expect((await s.check({ ...g, sig: 'x'.repeat(43) })).reason).toBe('bad-signature');
});

test('it stops verifying at exp, and says so distinctly', async () => {
  const s = new SignedUrls({ secret: 'shh', now: at(T0) });
  const g = await s.grant('node-1', { op: 'download', expiresIn: 60 });

  const later = new SignedUrls({ secret: 'shh', now: at(T0 + 59_000) });
  expect((await later.check(g)).ok).toBe(true);
  const after = new SignedUrls({ secret: 'shh', now: at(T0 + 61_000) });
  // "Expired" and "not ours" are different events: the first is ordinary and the client
  // should re-mint, the second is somebody editing URLs.
  expect(await after.check(g)).toEqual({ ok: false, reason: 'expired' });
});

test('a different secret is a different server', async () => {
  const a = new SignedUrls({ secret: 'one', now: at(T0) });
  const b = new SignedUrls({ secret: 'two', now: at(T0) });
  expect((await b.check(await a.grant('n', { op: 'media' }))).reason).toBe('bad-signature');
});

test('TTL is per purpose and capped server-side', async () => {
  const s = new SignedUrls({ secret: 'shh', now: at(T0) });
  const age = (g) => g.exp - Math.floor(T0 / 1000);

  // A <video> re-requests on every seek, so a media URL outlives the sitting. An
  // indexer's is handed to an API that fetches it once.
  expect(age(await s.grant('n', { op: 'media' }))).toBe(URL_PURPOSES.media.defaultAge);
  expect(age(await s.grant('n', { op: 'index' }))).toBe(URL_PURPOSES.index.defaultAge);

  // Content URLs outlast the sitting, which is the whole reason they are long: a media
  // URL has to survive a four-hour film with an interval, and a download has to survive
  // a stall-and-resume on a slow line. Shortening either is a film that stops partway.
  expect(URL_PURPOSES.media.defaultAge).toBeGreaterThanOrEqual(8 * 3600);
  expect(URL_PURPOSES.download.defaultAge).toBeGreaterThanOrEqual(2 * 3600);
  // The one handed to an external service is the exception — it leaves our control, so
  // it is good for one prompt fetch and then nothing.
  expect(URL_PURPOSES.index.maxAge).toBeLessThanOrEqual(15 * 60);

  // `expiresIn` arrives from a caller, and a URL good for a year is the one thing this
  // design cannot take back.
  expect(age(await s.grant('n', { op: 'index', expiresIn: 999_999 }))).toBe(URL_PURPOSES.index.maxAge);
  expect(age(await s.grant('n', { op: 'media', expiresIn: 0 }))).toBe(URL_PURPOSES.media.defaultAge);
  expect(age(await s.grant('n', { op: 'media', expiresIn: -5 }))).toBe(1);
  await expect(s.grant('n', { op: 'admin' })).rejects.toThrow(/purpose/i);
});

test('junk is refused without pretending it was a signature', async () => {
  const s = new SignedUrls({ secret: 'shh', now: at(T0) });
  expect((await s.check({})).reason).toBe('incomplete');
  expect((await s.check({ id: 'n', op: 'media', exp: 'soon', sig: 'x' })).reason).toBe('malformed');
  expect((await s.check({ id: 'n', op: 'nope', exp: 9e9, sig: 'x' })).reason).toBe('unknown-purpose');
});

// A separator-joined payload lets one field's value be pushed into the next: ('a|b','c')
// and ('a','b|c') sign identically. Length prefixes make that impossible, and node ids
// are not a field anyone should have to promise never contains a delimiter.
test('field boundaries cannot be moved around inside the payload', async () => {
  const s = new SignedUrls({ secret: 'shh', now: at(T0) });
  const a = await s.sign({ id: 'ab', op: 'media', exp: 1 });
  const b = await s.sign({ id: 'a', op: 'bmedia', exp: 1 });
  expect(a).not.toBe(b);
});

test('the secret survives a restart, and two instances agree on it', async () => {
  const kv = new MemoryKV();
  const first = await resolveUrlSecret({ kv });
  expect(first).toBeTruthy();
  // A restart re-reads rather than re-generates — otherwise every URL in flight dies
  // with the process.
  expect(await resolveUrlSecret({ kv })).toBe(first);
  // A second instance sharing the KV signs the same way, which is what makes the
  // generated fallback safe rather than merely convenient.
  const other = new SignedUrls({ secret: await resolveUrlSecret({ kv }) });
  const mine = new SignedUrls({ secret: first });
  expect((await other.check(await mine.grant('n', { op: 'media' }))).ok).toBe(true);

  // Configured always wins, and is the only option without a KV to keep one in.
  expect(await resolveUrlSecret({ configured: 'explicit', kv })).toBe('explicit');
  await expect(resolveUrlSecret({})).rejects.toThrow(/secret|KV/i);
});

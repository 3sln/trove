// Telling someone what a rotation will cost before they start one.
//
// The thing being tested is mostly editorial judgement rather than arithmetic: that we
// lead with how a provider bills rather than with a number, that we never present a
// fabricated figure for a host we do not know, and that every answer carries the date its
// rates came from and a link to the source.

import { test, expect } from 'bun:test';
import { estimateRotationCost, recognizeProvider, RATES_AS_OF } from '../src/storage/cost.js';

const GB = 1024 ** 3;

test('the providers we know are recognised from their endpoints', () => {
  expect(recognizeProvider('https://abc123.r2.cloudflarestorage.com').id).toBe('r2');
  expect(recognizeProvider('https://s3.us-east-1.amazonaws.com').id).toBe('aws');
  expect(recognizeProvider('https://s3.eu-west-2.amazonaws.com').id).toBe('aws');
  // The legacy global endpoint, the older dashed regional form, and virtual-host style —
  // all still in the wild, and all AWS.
  expect(recognizeProvider('https://s3.amazonaws.com').id).toBe('aws');
  expect(recognizeProvider('https://s3-us-west-2.amazonaws.com').id).toBe('aws');
  expect(recognizeProvider('https://mybucket.s3.us-east-1.amazonaws.com').id).toBe('aws');
  expect(recognizeProvider('https://s3.us-west-002.backblazeb2.com').id).toBe('b2');
  expect(recognizeProvider('https://s3.wasabisys.com').id).toBe('wasabi');
  expect(recognizeProvider('https://nyc3.digitaloceanspaces.com').id).toBe('spaces');
  expect(recognizeProvider('https://storage.googleapis.com').id).toBe('gcs');
});

test('anything else is simply not recognised, rather than guessed at', () => {
  expect(recognizeProvider('https://minio.internal:9000')).toBe(null);
  expect(recognizeProvider('https://storage.example.com')).toBe(null);
  expect(recognizeProvider('not a url')).toBe(null);
  expect(recognizeProvider(undefined)).toBe(null);
  // A lookalike hostname must not match — this decides what someone is told about money.
  expect(recognizeProvider('https://evil-r2.cloudflarestorage.com.attacker.test')).toBe(null);
});

test('storage nobody bills you for does not get a price', () => {
  // Offering an estimate here would be inventing a concern.
  for (const driver of ['filesystem', 'memory', 'nats']) {
    const e = estimateRotationCost({ driver }, { objects: 10_000, bytes: 500 * GB });
    expect(e.applicable).toBe(false);
    expect(e.total).toBe(null);
    expect(e.summary).toMatch(/nobody bills you for/);
  }
});

test('a store with no egress charge is reported as cheap, and says why', () => {
  // The durable half of the answer: R2's model, not R2's current per-GB rate.
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com' },
    { objects: 10_000, bytes: 500 * GB },
  );
  expect(e.provider).toBe('Cloudflare R2');
  expect(e.summary).toMatch(/does not charge for data transferred out/);
  const egress = e.lines.find((l) => l.label === 'Egress');
  expect(egress.value).toBe('not charged');
  // Half a terabyte, and the bill is operations only — single-digit dollars.
  expect(e.total.amount).toBeLessThan(1);
});

test('a store that meters egress says the size is what drives the price', () => {
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://s3.us-east-1.amazonaws.com' },
    { objects: 10_000, bytes: 500 * GB },
  );
  expect(e.summary).toMatch(/charges for data read out/);
  // 500GB at roughly $0.09/GB dominates everything else by orders of magnitude, which is
  // exactly the surprise this button exists to prevent.
  expect(e.total.amount).toBeGreaterThan(40);
});

test('the AWS answer names where the drive runs, because it changes the number', () => {
  // In-region reads are normally free and out-of-region are not; a drive on Workers is
  // firmly the second. Getting this wrong is an order-of-magnitude error, so it is said
  // rather than assumed.
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://s3.us-east-1.amazonaws.com' },
    { objects: 1, bytes: GB },
  );
  const egress = e.lines.find((l) => l.label === 'Egress');
  expect(egress.note).toMatch(/outside AWS/);
  expect(egress.note).toMatch(/same region/);
});

test('an unknown endpoint gets how billing usually works, never a made-up number', () => {
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://minio.internal:9000' },
    { objects: 5_000, bytes: 100 * GB },
  );
  expect(e.applicable).toBe(true);
  expect(e.confidence).toBe('unknown');
  expect(e.total).toBe(null);
  expect(e.summary).toMatch(/do not recognise this storage endpoint/);
  // Still useful: it explains what to look for on their own provider's pricing page.
  expect(e.summary).toMatch(/requests/);
  expect(e.summary).toMatch(/egress/);
  // And it still reports the work, which is true regardless of who bills for it.
  expect(e.lines.length).toBeGreaterThan(0);
});

test('every priced answer is dated, caveated and linked to the source', () => {
  // We will be wrong eventually. The estimate has to say where it came from rather than
  // leave the UI to remember.
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com' },
    { objects: 100, bytes: GB },
  );
  expect(e.asOf).toBe(RATES_AS_OF);
  expect(e.caveat).toMatch(/prices change/);
  expect(e.caveat).toMatch(/not a quote/);
  expect(e.caveat).toMatch(/Free tiers/);
  expect(e.docs).toMatch(/^https:\/\/developers\.cloudflare\.com/);
  expect(e.total.approximate).toBe(true);
});

test('the work is reported even where it is free, so the scale is visible', () => {
  // "This will read and rewrite 40,000 objects" is worth knowing even at zero cost — it is
  // how long it will take, and how much can go wrong partway.
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://s3.wasabisys.com' },
    { objects: 40_000, bytes: 2 * GB },
  );
  expect(e.lines[0].value).toBe('40,000');
  expect(e.lines[1].value).toBe('2.00 GB');
  // Ingress is named rather than priced — a listed zero invites wondering what it hides.
  expect(e.lines[2].value).toMatch(/not normally charged/);
  // And Wasabi's own catch is surfaced rather than buried in a total of zero.
  expect(e.lines.find((l) => l.label === 'Egress').note).toMatch(/minimum storage duration/);
});

test('an empty collection costs nothing and still answers', () => {
  const e = estimateRotationCost(
    { driver: 's3', endpoint: 'https://abc.r2.cloudflarestorage.com' },
    { objects: 0, bytes: 0 },
  );
  expect(e.total.amount).toBe(0);
  expect(e.lines[0].value).toBe('0');
});

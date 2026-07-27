// Leases — the one KV operation that has to be atomic.
//
// A scan writes a resume cursor. Two scans of the same collection running at once both
// write it, last-writer-wins, and a slice of the bucket is silently skipped: scan A is
// at cursor 900, scan B at 300, B writes last, and everything between 300 and 900 is
// walked twice while the *next* run resumes from 300 and never reaches what came after
// A's position in that pass. The in-memory "is one already running?" guard cannot see
// this, because the other scan is in another process — another Worker isolate, another
// container behind the same load balancer.
//
// Every implementation is tested against the same behaviour, because a lease that is
// only atomic on one backend is not a lease.

import { test, expect, describe } from 'bun:test';
import { MemoryKV, SqliteKV, LocalSqliteProvider } from '../src/index.js';

const backends = {
  memory: async () => new MemoryKV(),
  sqlite: async () => {
    const kv = new SqliteKV({ provider: new LocalSqliteProvider({ path: ':memory:' }) });
    await kv.init();
    return kv;
  },
};

for (const [name, make] of Object.entries(backends)) {
  describe(name, () => {
    test('only one holder at a time', async () => {
      const kv = await make();
      const a = await kv.acquire('scan', 'default', 60_000);
      const b = await kv.acquire('scan', 'default', 60_000);
      expect(a).toBeTruthy();
      expect(b).toBe(null);
    });

    test('a different key is a different lease', async () => {
      const kv = await make();
      expect(await kv.acquire('scan', 'photos', 60_000)).toBeTruthy();
      expect(await kv.acquire('scan', 'docs', 60_000)).toBeTruthy();
    });

    test('releasing hands it to the next caller', async () => {
      const kv = await make();
      const token = await kv.acquire('scan', 'default', 60_000);
      await kv.release('scan', 'default', token);
      expect(await kv.acquire('scan', 'default', 60_000)).toBeTruthy();
    });

    test('a lease expires, so a holder that died does not block forever', async () => {
      // The holder can die without releasing — an isolate evicted mid-scan, a container
      // killed. A lock that outlives its holder stops the work permanently and nobody
      // is left to notice, which is worse than no lock at all.
      const kv = await make();
      expect(await kv.acquire('scan', 'default', 1)).toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
      expect(await kv.acquire('scan', 'default', 60_000)).toBeTruthy();
    });

    test('someone else\'s token cannot release or renew yours', async () => {
      const kv = await make();
      const mine = await kv.acquire('scan', 'default', 60_000);
      await kv.release('scan', 'default', 'lse_not-mine');
      // Still held: the bogus release did nothing.
      expect(await kv.acquire('scan', 'default', 60_000)).toBe(null);
      expect(await kv.renew('scan', 'default', 'lse_not-mine', 60_000)).toBe(false);
      expect(await kv.renew('scan', 'default', mine, 60_000)).toBe(true);
    });

    test('renewing a lease you already lost fails, so you can stop working', async () => {
      const kv = await make();
      const stale = await kv.acquire('scan', 'default', 1);
      await new Promise((r) => setTimeout(r, 20));
      await kv.acquire('scan', 'default', 60_000); // someone else takes over
      expect(await kv.renew('scan', 'default', stale, 60_000)).toBe(false);
    });

    test('concurrent callers: exactly one wins', async () => {
      const kv = await make();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => kv.acquire('scan', 'default', 60_000)),
      );
      expect(results.filter(Boolean).length).toBe(1);
    });
  });
}

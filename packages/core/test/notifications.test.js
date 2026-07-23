// Mention batching + web-push fan-out. Uses MemoryKV and a fake WebPushService
// that records sends (and can simulate a dead subscription).

import { test, expect } from 'bun:test';
import { NotificationCenter, MemoryKV } from '../src/index.js';

class FakePush {
  constructor() { this.sent = []; this.publicKey = 'PUBKEY'; this.dead = new Set(); }
  async send(sub) {
    this.sent.push(sub.endpoint);
    return this.dead.has(sub.endpoint) ? { ok: false, gone: true } : { ok: true, status: 201 };
  }
}

test('enqueue → flush batches into inbox and pushes', async () => {
  const kv = new MemoryKV();
  const push = new FakePush();
  const nc = new NotificationCenter({ kv, push });

  await nc.subscribePush('bob', { endpoint: 'https://push/bob-1' });

  await nc.enqueue([
    { userId: 'bob', nodeId: 'f1', commentId: 'c1', by: { id: 'alice', name: 'Alice' }, excerpt: 'hi', at: 1 },
    { userId: 'bob', nodeId: 'f1', commentId: 'c2', by: { id: 'alice', name: 'Alice' }, excerpt: 'again', at: 2 },
  ]);

  const notified = await nc.flush(1_700_000_000_000);
  expect(notified).toBe(1);
  expect(push.sent).toEqual(['https://push/bob-1']); // bodyless push fired

  const inbox = await nc.inbox('bob');
  expect(inbox.unread).toBe(1);
  expect(inbox.items[0].count).toBe(2); // batch collapsed
  expect(inbox.items[0].title).toMatch(/2 new mentions/);

  // Pending cleared → a second flush notifies nobody.
  expect(await nc.flush()).toBe(0);

  await nc.markRead('bob');
  expect((await nc.inbox('bob')).unread).toBe(0);
});

test('dead subscriptions are pruned on flush', async () => {
  const kv = new MemoryKV();
  const push = new FakePush();
  push.dead.add('https://push/dead');
  const nc = new NotificationCenter({ kv, push });
  await nc.subscribePush('u', { endpoint: 'https://push/dead' });
  await nc.subscribePush('u', { endpoint: 'https://push/live' });
  await nc.enqueue([{ userId: 'u', by: { name: 'X' }, excerpt: 'y' }]);
  await nc.flush();
  const subs = await kv.get('push-subs', 'u');
  expect(subs.map((s) => s.endpoint)).toEqual(['https://push/live']);
});

test('single mention gets a personalised title', async () => {
  const nc = new NotificationCenter({ kv: new MemoryKV() });
  await nc.enqueue([{ userId: 'z', by: { name: 'Kate' }, excerpt: 'yo' }]);
  await nc.flush();
  expect((await nc.inbox('z')).items[0].title).toBe('Kate mentioned you');
});

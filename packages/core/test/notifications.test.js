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

// --- the drain has more than one driver now ------------------------------------

test('concurrent flushes deliver a batch once, not twice', async () => {
  // Two things drive the drain: the interval timer, and maintenance on a runtime whose
  // timers do not survive a request. Both can be live at once, and the read of the
  // pending batch and the delete of it are not one operation — so an unguarded pair of
  // drains put the same mentions in the inbox twice and pushed twice.
  const kv = new MemoryKV();
  const push = new FakePush();
  const nc = new NotificationCenter({ kv, push });
  await nc.subscribePush('bob', { endpoint: 'https://push/bob-1' });
  await nc.enqueue([{ userId: 'bob', by: { name: 'Alice' }, excerpt: 'hi' }]);

  const [a, b] = await Promise.all([nc.flush(), nc.flush()]);

  // One of them did the work; both saw the same answer.
  expect(a).toBe(b);
  expect((await nc.inbox('bob')).items.length).toBe(1);
  expect(push.sent).toEqual(['https://push/bob-1']);
});

test('a drain that finished does not block the next one', async () => {
  const kv = new MemoryKV();
  const nc = new NotificationCenter({ kv });
  await nc.enqueue([{ userId: 'u', by: { name: 'A' }, excerpt: '1' }]);
  expect(await nc.flush()).toBe(1);
  await nc.enqueue([{ userId: 'u', by: { name: 'A' }, excerpt: '2' }]);
  expect(await nc.flush()).toBe(1);
  expect((await nc.inbox('u')).items.length).toBe(2);
});

// --- channels ------------------------------------------------------------------

import { NotificationChannel, WebPushChannel } from '../src/index.js';

class RecordingChannel extends NotificationChannel {
  constructor(id, { fail = false } = {}) { super(); this._id = id; this.fail = fail; this.got = []; }
  get id() { return this._id; }
  async deliver(userId, note) {
    if (this.fail) throw new Error('channel is down');
    this.got.push({ userId, title: note.title });
  }
}

test('every channel gets the notification', async () => {
  const kv = new MemoryKV();
  const email = new RecordingChannel('email');
  const chat = new RecordingChannel('chat');
  const nc = new NotificationCenter({ kv, channels: [email, chat] });

  await nc.enqueue([{ userId: 'bob', by: { name: 'Alice' }, excerpt: 'hi' }]);
  await nc.flush();

  expect(email.got).toEqual([{ userId: 'bob', title: 'Alice mentioned you' }]);
  expect(chat.got).toEqual([{ userId: 'bob', title: 'Alice mentioned you' }]);
});

test('one channel failing does not stop the others, or lose the notification', async () => {
  // The inbox is written before anything is delivered, which is what makes a channel
  // allowed to fail: the notification still exists, only the ping was lost.
  const kv = new MemoryKV();
  const broken = new RecordingChannel('broken', { fail: true });
  const working = new RecordingChannel('working');
  const nc = new NotificationCenter({ kv, channels: [broken, working] });

  await nc.enqueue([{ userId: 'bob', by: { name: 'Alice' }, excerpt: 'hi' }]);
  expect(await nc.flush()).toBe(1);

  expect(working.got.length).toBe(1);
  expect((await nc.inbox('bob')).items.length).toBe(1);
});

test('a bare push service is still accepted, as one channel among others', async () => {
  // The pre-channel spelling. Wrapped rather than special-cased, so there is exactly
  // one delivery path regardless of how it was configured.
  const kv = new MemoryKV();
  const push = new FakePush();
  const email = new RecordingChannel('email');
  const nc = new NotificationCenter({ kv, push, channels: [email] });

  expect(nc.channel('web-push')).toBeInstanceOf(WebPushChannel);
  expect(nc.vapidPublicKey()).toBe('PUBKEY');

  await nc.subscribePush('bob', { endpoint: 'https://push/bob-1' });
  await nc.enqueue([{ userId: 'bob', by: { name: 'Alice' }, excerpt: 'hi' }]);
  await nc.flush();

  expect(push.sent).toEqual(['https://push/bob-1']);
  expect(email.got.length).toBe(1);
});

test('no channels at all still fills the inbox', async () => {
  const nc = new NotificationCenter({ kv: new MemoryKV() });
  await nc.enqueue([{ userId: 'bob', by: { name: 'Alice' }, excerpt: 'hi' }]);
  expect(await nc.flush()).toBe(1);
  expect((await nc.inbox('bob')).items.length).toBe(1);
});

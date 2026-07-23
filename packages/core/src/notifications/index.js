// NotificationCenter — batches @mentions and flushes them on a configurable
// interval, exactly as requested: as conversations mutate, mentions accumulate
// per user; every `flushIntervalMs` we drain the batch, drop it into each user's
// inbox, and fire a (bodyless) web push so their service worker wakes and pulls
// the inbox. Push subscriptions, pending batches, and inboxes live in the
// pluggable KeyValueStore, so this survives restarts and works multi-instance.
//
// Bodyless push (see webpush.js) means we never put mention text on a third-party
// push service — the client fetches /api/notifications over its authenticated
// channel instead.

const NS_SUBS = 'push-subs'; // userId -> [subscription]
const NS_PENDING = 'mentions-pending'; // userId -> [mention]
const NS_INBOX = 'notifications-inbox'; // userId -> [notification]

export class NotificationCenter {
  /**
   * @param {object} deps
   * @param {import('../kv.js').KeyValueStore} deps.kv
   * @param {import('./webpush.js').WebPushService} [deps.push]
   * @param {number} [deps.flushIntervalMs] default 30s
   * @param {number} [deps.inboxCap] keep at most N per user (default 200)
   */
  constructor({ kv, push, flushIntervalMs = 30_000, inboxCap = 200 }) {
    this.kv = kv;
    this.push = push || null;
    this.flushIntervalMs = flushIntervalMs;
    this.inboxCap = inboxCap;
    this._timer = null;
  }

  vapidPublicKey() {
    return this.push?.publicKey || null;
  }

  /** Queue mention events (from SidecarService.onMentions). */
  async enqueue(mentions) {
    for (const m of mentions || []) {
      const pending = (await this.kv.get(NS_PENDING, m.userId)) || [];
      pending.push(m);
      await this.kv.set(NS_PENDING, m.userId, pending);
    }
  }

  /** Drain all pending batches: inbox + push. Returns how many users notified. */
  async flush(now = Date.now()) {
    const pendingUsers = await this.kv.list(NS_PENDING);
    let notified = 0;
    for (const { key: userId, value: mentions } of pendingUsers) {
      if (!mentions?.length) {
        await this.kv.delete(NS_PENDING, userId);
        continue;
      }
      // Collapse into one notification summarising the batch.
      const note = {
        id: `note_${now}_${userId}`,
        kind: 'mentions',
        count: mentions.length,
        items: mentions,
        title: mentions.length === 1
          ? `${mentions[0].by?.name || 'Someone'} mentioned you`
          : `${mentions.length} new mentions`,
        createdAt: now,
        read: false,
      };
      const inbox = (await this.kv.get(NS_INBOX, userId)) || [];
      inbox.unshift(note);
      await this.kv.set(NS_INBOX, userId, inbox.slice(0, this.inboxCap));
      await this.kv.delete(NS_PENDING, userId);
      await this.#pushTo(userId, note);
      notified++;
    }
    return notified;
  }

  async #pushTo(userId, note) {
    if (!this.push) return;
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    const alive = [];
    for (const sub of subs) {
      try {
        const res = await this.push.send(sub, { topic: 'mentions', urgency: 'normal' });
        if (!res.gone) alive.push(sub);
      } catch {
        alive.push(sub); // transient — keep the subscription, retry next flush
      }
    }
    if (alive.length !== subs.length) await this.kv.set(NS_SUBS, userId, alive);
  }

  // --- subscriptions & inbox (called by routes) ------------------------------

  async subscribePush(userId, subscription) {
    if (!subscription?.endpoint) throw new Error('Invalid push subscription');
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    if (!subs.some((s) => s.endpoint === subscription.endpoint)) {
      subs.push(subscription);
      await this.kv.set(NS_SUBS, userId, subs);
    }
    return { ok: true };
  }
  async unsubscribePush(userId, endpoint) {
    const subs = (await this.kv.get(NS_SUBS, userId)) || [];
    await this.kv.set(NS_SUBS, userId, subs.filter((s) => s.endpoint !== endpoint));
    return { ok: true };
  }

  async inbox(userId) {
    const items = (await this.kv.get(NS_INBOX, userId)) || [];
    return { items, unread: items.filter((n) => !n.read).length };
  }
  async markRead(userId, ids) {
    const items = (await this.kv.get(NS_INBOX, userId)) || [];
    const set = ids ? new Set(ids) : null;
    for (const n of items) if (!set || set.has(n.id)) n.read = true;
    await this.kv.set(NS_INBOX, userId, items);
    return { ok: true };
  }

  // --- lifecycle -------------------------------------------------------------

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.flush().catch((e) => console.error('mention flush failed', e)), this.flushIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

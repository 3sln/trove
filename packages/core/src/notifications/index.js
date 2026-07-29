// NotificationCenter — batches @mentions and drains them on a configurable
// interval: as conversations mutate, mentions accumulate per user; every
// `flushIntervalMs` we drain the batch, collapse it into one notification, drop that
// into the user's inbox, and hand it to each delivery channel. Pending batches and
// inboxes live in the pluggable KeyValueStore, so this survives restarts and works
// multi-instance.
//
// The split worth keeping straight: the INBOX is the record, and it is written whether
// or not anything can be delivered — /api/notifications serves it and a drive with no
// channels configured still notifies people perfectly well. A CHANNEL is the part that
// goes and tells someone, and it is allowed to fail. Web push is one channel (see
// webpush.js); email or a chat workspace would be others, and nothing here knows the
// difference between them.
//
// Bodyless push means mention text never reaches a third-party push service — the
// client fetches /api/notifications over its authenticated channel instead. That is a
// property of the web-push channel rather than of this file, but it is the reason the
// inbox has to exist independently of delivery.

import { TroveError } from '../errors.js';
import { WebPushChannel } from './webpush.js';

const NS_PENDING = 'mentions-pending'; // userId -> [mention]
const NS_INBOX = 'notifications-inbox'; // userId -> [notification]

export class NotificationCenter {
  /**
   * @param {object} deps
   * @param {import('../kv.js').KeyValueStore} deps.kv
   * @param {import('./channel.js').NotificationChannel[]} [deps.channels] delivery
   * @param {import('./webpush.js').WebPushService} [deps.push] the pre-channel
   *   spelling of "web push": a bare service, wrapped into a channel here so there is
   *   still exactly one delivery path.
   * @param {number} [deps.flushIntervalMs] default 30s
   * @param {number} [deps.inboxCap] keep at most N per user (default 200)
   */
  constructor({ kv, push, channels, flushIntervalMs = 30_000, inboxCap = 200 }) {
    this.kv = kv;
    this.channels = [
      ...(channels || []),
      ...(push ? [new WebPushChannel({ kv, service: push })] : []),
    ];
    this.flushIntervalMs = flushIntervalMs;
    this.inboxCap = inboxCap;
    this._timer = null;
  }

  /** A channel by id, for the callers that need a specific one. */
  channel(id) {
    return this.channels.find((c) => c.id === id) || null;
  }

  vapidPublicKey() {
    return this.channel('web-push')?.publicKey || null;
  }

  /** Queue mention events (from SidecarService.onMentions). */
  async enqueue(mentions) {
    for (const m of mentions || []) {
      const pending = (await this.kv.get(NS_PENDING, m.userId)) || [];
      pending.push(m);
      await this.kv.set(NS_PENDING, m.userId, pending);
    }
  }

  /**
   * Drain all pending batches: inbox + push. Returns how many users notified.
   *
   * Concurrent calls collapse onto one drain. There are two callers — the interval
   * timer, and maintenance on a runtime whose timers do not survive a request — and
   * both can be live at once. Two drains reading the same pending batch would deliver
   * it twice, because the read and the delete are not one operation.
   *
   * This makes one PROCESS safe, not a cluster: two servers over a shared KV can still
   * both read a batch before either deletes it. That race predates this and wants a
   * claim in the store to fix properly.
   */
  async flush(now = Date.now()) {
    if (this._draining) return this._draining;
    this._draining = this.#drain(now).finally(() => { this._draining = null; });
    return this._draining;
  }

  async #drain(now) {
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
      await this.#deliver(userId, note);
      notified++;
    }
    return notified;
  }

  /**
   * Hand one notification to every channel.
   *
   * Sequential and forgiving: a channel that throws is logged and the others still run.
   * The inbox was written above, so a failed send costs the ping and not the
   * notification — which is the whole reason the inbox is not itself a channel.
   */
  async #deliver(userId, note) {
    for (const channel of this.channels) {
      try {
        await channel.deliver(userId, note);
      } catch (err) {
        console.error(`[trove] notification channel "${channel.id}" failed for ${userId}`, err);
      }
    }
  }

  // --- subscriptions & inbox (called by routes) ------------------------------

  async subscribePush(userId, subscription) {
    const channel = this.channel('web-push');
    if (!channel) throw TroveError.unsupported('Web push is not configured');
    return channel.subscribe(userId, subscription);
  }

  async unsubscribePush(userId, endpoint) {
    const channel = this.channel('web-push');
    if (!channel) throw TroveError.unsupported('Web push is not configured');
    return channel.unsubscribe(userId, endpoint);
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

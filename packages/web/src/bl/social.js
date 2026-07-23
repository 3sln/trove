// SocialService — the client side of identity, conversations, tags, and mention
// notifications. Reactive (the workbench `watch`es it): it holds the current
// principal, the notification inbox (polled + refreshed on demand), and the
// active file's sidecar (tags + threaded comments). It also owns the web-push
// subscription flow (register the service worker, subscribe with the server's
// VAPID key). All mutations optimistically reload the affected sidecar.

import { ObservableSubject } from '../runtime.js';

export class SocialService {
  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.state = {
      me: null,
      notifications: { items: [], unread: 0 },
      inboxOpen: false,
      pushSupported: 'serviceWorker' in navigator && 'PushManager' in window,
      pushEnabled: false,
      sidecar: null, // { nodeId, tags, comments, subscribers, loading, error }
      posting: false,
      replyTo: null, // { id, author } when composing a reply
    };
    this.subject = new ObservableSubject(this.state);
    this._pollTimer = null;
  }

  observe() {
    return this.subject;
  }
  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.subject.next(this.state);
  }

  async init() {
    try {
      const me = await this.api.me();
      this.#set({ me: me.principal });
    } catch { /* anonymous / offline */ }
    await this.refreshNotifications();
    // Light polling; the service worker also nudges on push.
    this._pollTimer = setInterval(() => this.refreshNotifications(), 45_000);
    if (this._pollTimer.unref) this._pollTimer.unref();
    this.#detectPush();
    window.addEventListener('focus', () => this.refreshNotifications());
    navigator.serviceWorker?.addEventListener?.('message', (e) => {
      if (e.data?.type === 'trove-push') this.refreshNotifications();
    });
  }

  async refreshNotifications() {
    try {
      const n = await this.api.notifications();
      this.#set({ notifications: n });
    } catch { /* not enabled / offline */ }
  }

  toggleInbox(open) {
    const next = open ?? !this.state.inboxOpen;
    this.#set({ inboxOpen: next });
    if (next && this.state.notifications.unread) this.markAllRead();
  }
  async markAllRead() {
    try {
      await this.api.markNotificationsRead();
      this.#set({ notifications: { ...this.state.notifications, unread: 0, items: this.state.notifications.items.map((i) => ({ ...i, read: true })) } });
    } catch { /* ignore */ }
  }

  // --- sidecar (per active file) ---------------------------------------------

  async loadSidecar(nodeId) {
    if (!nodeId) return this.#set({ sidecar: null });
    this.#set({ sidecar: { nodeId, loading: true, tags: [], comments: [], subscribers: [] } });
    try {
      const view = await this.api.sidecar(nodeId);
      this.#set({ sidecar: { ...view, loading: false } });
    } catch (err) {
      this.#set({ sidecar: { nodeId, loading: false, error: err.message, tags: [], comments: [] } });
    }
  }
  async #reload() {
    if (this.state.sidecar?.nodeId) await this.loadSidecar(this.state.sidecar.nodeId);
  }

  setReplyTo(target) {
    this.#set({ replyTo: target });
  }
  async comment(body) {
    const nodeId = this.state.sidecar?.nodeId;
    if (!nodeId || !body.trim()) return;
    const parentId = this.state.replyTo?.id || null;
    this.#set({ posting: true });
    try {
      await this.api.addComment(nodeId, { body, parentId });
      this.#set({ replyTo: null });
      await this.#reload();
    } catch (err) {
      this.platform.notifications.error(`Couldn't post comment: ${err.message}`);
    } finally {
      this.#set({ posting: false });
    }
  }
  async deleteComment(cid) {
    const nodeId = this.state.sidecar?.nodeId;
    await this.api.deleteComment(nodeId, cid).catch((e) => this.platform.notifications.error(e.message));
    await this.#reload();
  }
  async react(cid, emoji) {
    const nodeId = this.state.sidecar?.nodeId;
    const comment = findComment(this.state.sidecar?.comments || [], cid);
    const on = !(comment?.reactions?.[emoji] || []).includes(this.state.me?.id);
    await this.api.reactComment(nodeId, cid, emoji, on).catch(() => {});
    await this.#reload();
  }
  async addTag(name, value) {
    const nodeId = this.state.sidecar?.nodeId;
    if (!name.trim()) return;
    await this.api.setTag(nodeId, name.trim(), value).catch((e) => this.platform.notifications.error(e.message));
    await this.#reload();
  }
  async removeTag(name) {
    const nodeId = this.state.sidecar?.nodeId;
    await this.api.removeTag(nodeId, name).catch(() => {});
    await this.#reload();
  }

  // --- web push --------------------------------------------------------------

  async #detectPush() {
    if (!this.state.pushSupported) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      this.#set({ pushEnabled: !!sub });
    } catch { /* ignore */ }
  }

  async enablePush() {
    if (!this.state.pushSupported) {
      this.platform.notifications.warn('Push notifications are not supported in this browser.');
      return;
    }
    try {
      const { publicKey } = await this.api.vapidKey();
      if (!publicKey) {
        this.platform.notifications.warn('This server has no VAPID key configured for web push.');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return this.platform.notifications.info('Notifications permission was denied.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await this.api.subscribePush(sub.toJSON());
      this.#set({ pushEnabled: true });
      this.platform.notifications.success('Notifications enabled — you’ll be pinged when someone @mentions you.');
    } catch (err) {
      this.platform.notifications.error(`Couldn't enable notifications: ${err.message}`);
    }
  }
}

function findComment(list, cid) {
  for (const c of list) {
    if (c.id === cid) return c;
    const inner = findComment(c.replies || [], cid);
    if (inner) return inner;
  }
  return null;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// SidecarService — the API surface over sidecar documents: conversations
// (threaded comments, edits, reactions), tags, and thread
// subscriptions. It resolves the acting Principal into comment authorship,
// extracts @mentions, auto-subscribes participants, and emits mention events to
// a callback (wired to the notification batcher). Routes call these methods.

import { SidecarStore } from './store.js';
import { SidecarManager } from './manager.js';
import {
  addComment, editComment, deleteComment, react, setTag, removeTag,
  subscribe, unsubscribe, viewDoc, extractMentions,
} from './document.js';
import { newId } from '../util.js';
import { TroveError } from '../errors.js';

export class SidecarService {
  /**
   * @param {object} deps
   * @param {import('../storage/interface.js').StorageBackend} deps.storage
   * @param {(mentions: Array) => void} [deps.onMentions]  batch-notify sink
   * @param {SidecarManager} [deps.manager]
   * @param {import('../issues.js').IssueRegistry} [deps.issues] so a write-back that
   *   keeps failing becomes a standing problem rather than a console line
   */
  constructor({ storage, onMentions, manager, issues } = {}) {
    this.store = new SidecarStore({ storage });
    this.manager = manager ?? new SidecarManager({ store: this.store, issues });
    this.onMentions = onMentions ?? (() => {});
  }

  async view(nodeId) {
    return viewDoc(await this.manager.get(nodeId));
  }

  /**
   * Flush and evict idle documents — the maintenance timer's entry point.
   *
   * It called `sidecar.sweep?.()`, which did not exist here; the optional call swallowed
   * it, so nothing ever evicted and every sidecar ever loaded (one per file opened,
   * commented on, or tagged) stayed resident for the life of the process. Delegating
   * makes the name the caller already uses the real one.
   */
  sweep() {
    return this.manager.sweep();
  }
  /** Write back everything still holding unsaved changes (shutdown). */
  flushAll() {
    return this.manager.flushAll();
  }
  /**
   * Try again to save what could not be saved — what the `sidecar-flush` issue's Retry
   * button runs. Clears the issue for each document that lands.
   */
  retryPending() {
    return this.manager.retryPending();
  }

  // --- conversation ----------------------------------------------------------

  /**
   * @param {string} nodeId
   * @param {{ body: string, parentId?: string, mentions?: string[] }} input
   * @param {object} principal  { id, name, picture }
   */
  async addComment(nodeId, input, principal) {
    if (!principal?.id) throw TroveError.unauthorized('Sign in to comment');
    if (!input.body?.trim()) throw TroveError.invalid('Comment body is required');
    const id = newId('cmt');
    const author = { id: principal.id, name: principal.name || principal.id, picture: principal.picture || null };
    const mentions = uniq([...(input.mentions || []), ...extractMentions(input.body)]).filter((m) => m !== principal.id);

    const comment = await this.manager.mutate(nodeId, (doc) => {
      const c = addComment(doc, { id, parentId: input.parentId || null, author, body: input.body, mentions, actor: principal.id });
      // Auto-subscribe mentioned users and the parent author to the thread.
      for (const uid of mentions) subscribe(doc, uid, { actor: principal.id });
      if (input.parentId && doc.comments[input.parentId]) subscribe(doc, doc.comments[input.parentId].author?.id, { actor: principal.id });
      return c;
    });

    if (mentions.length) {
      this.onMentions(mentions.map((userId) => ({
        userId, nodeId, commentId: id, by: author, at: Date.now(),
        excerpt: excerpt(input.body),
      })));
    }
    return this.#commentView(nodeId, comment.id);
  }

  async editComment(nodeId, commentId, body, principal) {
    await this.#assertAuthor(nodeId, commentId, principal);
    await this.manager.mutate(nodeId, (doc) => editComment(doc, commentId, { body, actor: principal.id }));
    return this.#commentView(nodeId, commentId);
  }

  async deleteComment(nodeId, commentId, principal) {
    await this.#assertAuthor(nodeId, commentId, principal);
    await this.manager.mutate(nodeId, (doc) => deleteComment(doc, commentId, { actor: principal.id }));
    return { ok: true };
  }

  async react(nodeId, commentId, emoji, on, principal) {
    if (!principal?.id) throw TroveError.unauthorized('Sign in to react');
    await this.manager.mutate(nodeId, (doc) => react(doc, commentId, emoji, principal.id, on));
    return this.#commentView(nodeId, commentId);
  }

  // --- tags ------------------------------------------------------------------

  async setTag(nodeId, name, value, principal) {
    await this.manager.mutate(nodeId, (doc) => setTag(doc, name, { value: value ?? true, actor: principal?.id }));
    return this.view(nodeId);
  }
  async removeTag(nodeId, name, principal) {
    await this.manager.mutate(nodeId, (doc) => removeTag(doc, name, { actor: principal?.id }));
    return this.view(nodeId);
  }

  // --- subscriptions ---------------------------------------------------------

  async subscribe(nodeId, principal, muted = false) {
    if (!principal?.id) throw TroveError.unauthorized('Sign in to follow');
    await this.manager.mutate(nodeId, (doc) => subscribe(doc, principal.id, { muted, actor: principal.id }));
    return { ok: true };
  }
  async unsubscribe(nodeId, principal) {
    if (!principal?.id) throw TroveError.unauthorized('Sign in');
    await this.manager.mutate(nodeId, (doc) => unsubscribe(doc, principal.id, { actor: principal.id }));
    return { ok: true };
  }

  /** Delete a file's sidecar (called when the file is deleted). */
  async remove(nodeId) {
    await this.store.remove(nodeId);
    this.manager.hot.delete(nodeId);
  }

  async dispose() {
    await this.manager.dispose();
  }

  // --- helpers ---------------------------------------------------------------

  async #assertAuthor(nodeId, commentId, principal) {
    if (!principal?.id) throw TroveError.unauthorized('Sign in');
    const doc = await this.manager.get(nodeId);
    const c = doc.comments[commentId];
    if (!c) throw TroveError.notFound('Comment');
    if (c.author?.id !== principal.id) throw TroveError.forbidden('You can only edit your own comments');
  }

  async #commentView(nodeId, commentId) {
    const view = viewDoc(await this.manager.get(nodeId));
    const find = (list) => {
      for (const c of list) {
        if (c.id === commentId) return c;
        const inner = find(c.replies || []);
        if (inner) return inner;
      }
      return null;
    };
    return find(view.comments) || { id: commentId };
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}
function excerpt(body, n = 140) {
  const clean = body.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

export { SidecarStore, SidecarManager };

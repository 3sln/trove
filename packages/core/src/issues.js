// IssueRegistry — standing problems: something that was expected to happen didn't, and
// is still not fixed.
//
// This is the counterpart to TaskRegistry, and the split between them is by LIFETIME:
//
//   Task   in-flight, ephemeral, per-process. "A reindex is running."
//   Issue  standing, durable, outlives the process. "welcome.md failed to index."
//
// The distinction matters because of how these fail. A task that dies with its process
// is correctly forgotten — it isn't running any more. But a file that failed to index
// is *still* unindexed after a restart, and a console line that scrolled away three
// deploys ago is not a record of that. So issues go in the KeyValueStore, which is
// durable whenever the drive is.
//
// Three properties make this a registry rather than a log:
//
//   1. Keyed by (kind, subject), so raising the same problem twice UPDATES it. A file
//      that fails to index on every retry is one issue with a count, not fifty rows.
//   2. Cleared by the success that fixes it — `clear('index', nodeId)` on a successful
//      index. An issue list nobody can empty gets ignored, and then it's just a log.
//   3. Carries a declarative `retry` descriptor, so the thing that reports the problem
//      also says how to attempt the fix. Most standing problems are retryable; one that
//      makes the user go find the right button is only half-reported.

import { TroveError } from './errors.js';

const NS = 'issues';
/** Bounded: a systemic failure (storage down mid-reindex) must not fill the store. */
const MAX_ISSUES = 500;

/** A stable, human-readable id. Clients must encodeURIComponent it for a path segment. */
export function issueId(kind, subject) {
  return subject ? `${kind}:${subject}` : kind;
}

export class IssueRegistry {
  /**
   * @param {{kv: import('./kv.js').KeyValueStore, now?: () => number}} deps
   */
  constructor({ kv, now = () => Date.now() } = {}) {
    if (!kv) throw TroveError.invalid('IssueRegistry needs a KeyValueStore');
    this.kv = kv;
    this.now = now;
    this._handlers = new Map(); // retry op -> (issue) => Promise
  }

  /**
   * Register how to retry one class of issue. Kept as a registration rather than a
   * switch inside this class so core doesn't need to know what a reindex is — the
   * server, which owns the Vfs, supplies the verbs.
   *
   * @param {string} op
   * @param {(issue: object) => Promise<any>} handler
   */
  handle(op, handler) {
    this._handlers.set(op, handler);
  }
  canRetry(issue) {
    return !!(issue?.retry?.op && this._handlers.has(issue.retry.op));
  }

  /**
   * Record (or refresh) a standing problem.
   *
   * @param {object} spec
   * @param {string} spec.kind          'index', 'reindex', 'upload' — the class of problem
   * @param {string} [spec.subject]     what it is about (a node id); omit for drive-wide
   * @param {string} spec.title         one line, in the user's terms
   * @param {string} [spec.detail]      the underlying error, for someone who wants it
   * @param {string} [spec.severity]    'error' (default) | 'warning'
   * @param {string} [spec.collectionId] scopes visibility; null = drive-wide (admin)
   * @param {{op: string}} [spec.retry] declarative retry, executed by a registered handler
   */
  async raise(spec) {
    if (!spec?.kind || !spec?.title) throw TroveError.invalid('An issue needs a kind and a title');
    const id = issueId(spec.kind, spec.subject);
    const existing = await this.kv.get(NS, id);
    const at = this.now();
    const issue = {
      id,
      kind: spec.kind,
      subject: spec.subject ?? null,
      title: spec.title,
      detail: spec.detail ?? null,
      severity: spec.severity || 'error',
      collectionId: spec.collectionId ?? null,
      retry: spec.retry ?? null,
      // Keep the FIRST sighting: "failing since 09:14" is the useful fact, and it would
      // be lost if every recurrence reset the clock.
      firstAt: existing?.firstAt ?? at,
      lastAt: at,
      count: (existing?.count ?? 0) + 1,
    };
    await this.kv.set(NS, id, issue);
    if (!existing) await this.#enforceCap();
    return issue;
  }

  /** Remove the issue for (kind, subject) — call this on the success that resolves it. */
  async clear(kind, subject) {
    await this.kv.delete(NS, issueId(kind, subject));
  }

  async get(id) {
    return this.kv.get(NS, id);
  }
  async remove(id) {
    await this.kv.delete(NS, id);
  }

  /**
   * @param {{collectionIds?: string[], includeGlobal?: boolean, limit?: number}} [opts]
   *   `collectionIds` restricts to issues about collections the caller can read. A
   *   drive-wide issue (collectionId null) is only for someone allowed the whole drive,
   *   because its title can name things a scoped reader shouldn't learn about.
   */
  async list({ collectionIds, includeGlobal = true, limit = 100 } = {}) {
    const rows = await this.kv.list(NS, '');
    return rows
      .map((r) => r.value)
      .filter(Boolean)
      .filter((i) => (i.collectionId == null ? includeGlobal : !collectionIds || collectionIds.includes(i.collectionId)))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, limit);
  }

  /**
   * Attempt the fix this issue describes. The issue is NOT cleared here — it is cleared
   * by whatever succeeds, so a retry that reports success while the underlying problem
   * persists can't quietly hide it.
   */
  async retry(id) {
    const issue = await this.get(id);
    if (!issue) throw TroveError.notFound('Issue');
    const handler = this._handlers.get(issue.retry?.op);
    if (!handler) throw TroveError.invalid('This problem cannot be retried automatically');
    return handler(issue);
  }

  async #enforceCap() {
    const rows = await this.kv.list(NS, '');
    if (rows.length <= MAX_ISSUES) return;
    const oldest = rows
      .map((r) => r.value)
      .filter(Boolean)
      .sort((a, b) => a.lastAt - b.lastAt)
      .slice(0, rows.length - MAX_ISSUES);
    for (const issue of oldest) await this.kv.delete(NS, issue.id);
  }
}

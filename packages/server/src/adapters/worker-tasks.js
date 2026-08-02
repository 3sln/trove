// Background work on Workers, in a Durable Object.
//
// The TaskRegistry is in-memory and per-process, and that is the right lifetime: a task
// describes work in flight, and work in flight does not survive the thing doing it.
// What breaks on Workers is not the lifetime — it is that the process boundary stopped
// matching the work boundary. On a long-lived server one process runs the scan AND
// answers the polls, so "in memory" and "where the work is" are the same place. On
// Workers they come apart: the scan runs in whichever isolate served the POST, and the
// GET that asks about it lands wherever the router feels like.
//
// The fix is NOT to make the task list durable. A stored record saying "running" after
// the isolate that owned it was evicted is a phantom that nothing can ever correct —
// on a server a restart clears it, in durable storage it is forever. The fix is to give
// the work a real process again. A Durable Object is one: addressable by name, so every
// request reaches the same instance; single-threaded, so "is one already running?" can
// be answered truthfully; and long-lived, with `setAlarm` to pick work back up.
//
// So the registry stays exactly as it is, and moves in here with the work it describes.
//
// Three things this fixes that `waitUntil` alone does not:
//   • progress polling — /api/tasks reaches the isolate that owns the task
//   • cancel — the AbortController is in the same place as the work it aborts
//   • the "already running" guard — one instance, not one per isolate
//
// Eviction is still possible mid-slice, and that is what the alarm is for: the scan
// cursor is persisted, `pending:` says the collection is not finished, and the alarm
// brings the object back to continue. Losing the isolate costs a slice, not the scan.

import { TaskRegistry } from '@3sln/trove/core';

/** How long one scan slice may run before it yields and stores its cursor. */
const DEFAULT_SLICE_MS = 20_000;
/** Gap between slices. Long enough not to hammer the store, short enough to feel live. */
const SLICE_GAP_MS = 5_000;
const PENDING = 'pending:';

/**
 * The Durable Object. Export it from the Worker entry module and declare it in
 * wrangler.toml; see the README section "Work that outlives a request".
 *
 * @param {(env: object) => Promise<object>} getServer builds (and caches) the server
 */
export function createTaskHost(getServer) {
  return class TroveTasks {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.server = null;
      this.sliceMs = Number(env?.TROVE_SLICE_MS || DEFAULT_SLICE_MS);
    }

    async #boot() {
      this.server ||= await getServer(this.env);
      return this.server;
    }

    /** Wake up in `ms` — unless we are already due sooner. */
    async #arm(ms) {
      const at = Date.now() + ms;
      const current = await this.state.storage.getAlarm();
      if (current == null || current > at) await this.state.storage.setAlarm(at);
    }

    async #beginScan(collectionId, reason) {
      const server = await this.#boot();
      const { task, alreadyRunning, done } = await server.beginScan(collectionId, {
        reason, deadlineMs: this.sliceMs,
      });
      if (!alreadyRunning) {
        // Recorded BEFORE the slice runs. If this object is evicted half way through,
        // the alarm is what brings it back — and it can only do that if it knows the
        // collection is unfinished. Writing this after the slice would mean an eviction
        // silently ends the scan, which is the failure this whole file is about.
        await this.state.storage.put(`${PENDING}${collectionId}`, { reason: reason || 'Continuing' });
        this.state.waitUntil?.(done.then(
          // `stopped`, not `nextCursor`: a slice that runs out of budget before it
          // processes anything stops with a null cursor — correctly, since it got
          // nowhere and must resume from the start. Reading that as "finished" would
          // drop the collection off the list having scanned none of it.
          (r) => (r && !r.stopped ? this.state.storage.delete(`${PENDING}${collectionId}`) : null),
          () => null, // a failed slice stays pending; the alarm retries it
        ));
      }
      await this.#arm(SLICE_GAP_MS);
      return { task, alreadyRunning };
    }

    async #beginBackfill(indexerIds, reason) {
      const server = await this.#boot();
      const { task, alreadyRunning, done } = await server.beginBackfill({ indexerIds, reason });
      // Same shape as a reindex: nothing to resume from, so it either finishes in this
      // object's lifetime or the files stay unindexed until something asks again.
      if (!alreadyRunning) this.state.waitUntil?.(done.catch(() => null));
      return { task, alreadyRunning };
    }

    async #beginReindex(reason) {
      const server = await this.#boot();
      const { task, alreadyRunning, done } = await server.beginReindex({ reason });
      // A reindex has no cursor to resume from, so there is nothing to continue — it
      // either finishes in this object's lifetime or it is retried, and a failure
      // leaves an Issue behind either way.
      if (!alreadyRunning) this.state.waitUntil?.(done.catch(() => null));
      return { task, alreadyRunning };
    }

    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      const server = await this.#boot();
      switch (url.pathname) {
        case '/begin':
          if (body.kind === 'backfill') return json(await this.#beginBackfill(body.indexerIds, body.reason));
          return json(body.kind === 'index'
            ? await this.#beginReindex(body.reason)
            : await this.#beginScan(body.collectionId || 'default', body.reason));
        case '/tasks':
          return json({ tasks: server.tasks.list(body) });
        case '/task':
          return json({ task: server.tasks.get(body.id) });
        case '/cancel':
          return json({ cancelled: server.tasks.cancel(body.id) });
        case '/dismiss':
          server.tasks.dismiss(body.id);
          return json({ ok: true });
        case '/maintain':
          return json({ result: await server.runMaintenance({ budgetMs: body.budgetMs ?? this.sliceMs }) });
        default:
          return new Response('not found', { status: 404 });
      }
    }

    /**
     * Continue every collection that has not finished its pass. This is the durable
     * half: a Cron Trigger starts things, but it is the alarm that keeps a bucket too
     * large for one slice moving, without waiting for the next cron tick.
     */
    async alarm() {
      const server = await this.#boot();
      const pending = await this.state.storage.list({ prefix: PENDING });
      for (const [key, meta] of pending) {
        const collectionId = key.slice(PENDING.length);
        const result = await server
          .startScan(collectionId, { reason: meta?.reason || 'Continuing', deadlineMs: this.sliceMs })
          .catch(() => null);
        // Done only when a pass ran to the end. `alreadyRunning` means another slice
        // holds the claim right now — still unfinished, so it stays on the list.
        if (result && !result.alreadyRunning && !result.stopped) await this.state.storage.delete(key);
      }
      if ((await this.state.storage.list({ prefix: PENDING })).size) await this.#arm(SLICE_GAP_MS);
    }
  };
}

/**
 * The other side: a TaskRegistry that answers from the Durable Object rather than from
 * this isolate's memory. Injected as `config.tasks`, so every route that reads tasks
 * gets the truth without knowing where it lives.
 */
export class RemoteTasks extends TaskRegistry {
  /** @param {() => object} stub resolves the Durable Object stub — see remoteBackground
   *  for why this is a function and not the stub itself. */
  constructor(stub) {
    super();
    this.stub = stub;
  }
  async #rpc(path, payload) {
    const res = await this.stub().fetch(`https://trove.tasks${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }
  async list(opts = {}) { return (await this.#rpc('/tasks', opts)).tasks; }
  async get(id) { return (await this.#rpc('/task', { id })).task; }
  async cancel(id) { return (await this.#rpc('/cancel', { id })).cancelled; }
  async dismiss(id) { await this.#rpc('/dismiss', { id }); }
  /**
   * Nothing to wait on here. The work is in the Durable Object, which keeps itself
   * alive; this isolate only forwarded a message. Returning the base class's answer
   * would make `ctx.waitUntil` hold the request open for work it does not own.
   */
  pending() { return null; }
}

/**
 * Everything the front-line Worker needs to hand background work to the object.
 * Pass into `createServer` as `{ tasks, background }`.
 */
export function remoteBackground(namespace) {
  // One instance for the whole drive, by name. Tasks are few and long, so there is no
  // throughput argument for sharding — and one instance is what makes GET /api/tasks a
  // complete answer rather than a per-shard sample.
  //
  // Resolved per call, never held. A stub belongs to the I/O context of the request that
  // created it, and the server that owns this one is cached at module scope for the life
  // of the isolate — so the stub outlived its request and every later use threw. The
  // first request worked and the second did not, which reads like a fluke and is not:
  // GET /api/tasks was broken for the entire life of every isolate after its first
  // request. `idFromName` is a pure hash, so re-deriving it costs nothing and always
  // names the same object.
  const stub = () => namespace.get(namespace.idFromName('trove-tasks'));
  const begin = (payload) => stub()
    .fetch('https://trove.tasks/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then((r) => r.json());
  return {
    tasks: new RemoteTasks(stub),
    background: {
      beginScan: (collectionId, { reason } = {}) => begin({ kind: 'scan', collectionId, reason }),
      beginReindex: ({ reason } = {}) => begin({ kind: 'index', reason }),
      beginBackfill: ({ indexerIds, reason } = {}) => begin({ kind: 'backfill', indexerIds, reason }),
    },
    maintain: (budgetMs) => stub()
      .fetch('https://trove.tasks/maintain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetMs }),
      })
      .then((r) => r.json()),
  };
}

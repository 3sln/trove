// ActivityService — the client's answer to "what is going on, and what is stuck".
//
// It holds two lists that look similar and mean different things, and keeping them
// distinct is the whole design:
//
//   TASKS   work happening now. Ephemeral. A task disappears when it finishes (after a
//           moment on screen) and when the process running it stops. That is correct:
//           the work stopped too.
//   ISSUES  a standing problem left behind by something that already failed. Durable on
//           the server. It stays until the thing it complains about actually works —
//           not until it is acknowledged, and not until a reload.
//
// WHY ONE SERVICE FOR BOTH SIDES. Work happens in two places — an upload runs in this
// browser, a reindex runs on the server — and a user does not care which. So this holds
// one list, with each task tagged by where it lives:
//
//   local   started here, driven here. The owner (TransfersService) reports progress
//           directly, and cancelling calls a function.
//   server  a read-only MIRROR of the server's registry. Nothing here drives it;
//           cancelling posts, and the next poll shows the result. Treating a mirror as
//           writable is how two sources of truth get invented.
//
// WHY POLLING. There is no streaming transport in this server, and adding SSE through
// three runtime adapters to move a progress bar is not a trade worth making yet. So:
// poll fast (1s) only while something is running, drop to nothing when the drive is
// idle, and re-check when the tab regains focus. At rest this costs one request when
// the app loads. If a real-time channel ever exists, only `#poll` changes.

import { cell } from '../runtime.js';

const ACTIVE_MS = 1000; // while something is running, we want a live-feeling bar
const IDLE_MS = 60_000; // otherwise just enough to notice a task someone else started

export class ActivityService {
  #state;

  constructor(platform) {
    this.platform = platform;
    this.api = platform.api;
    this.#state = {
      tasks: [], // merged: local first, then the server mirror
      issues: [],
      issuesLoading: false,
      // A load failure is state, not a shrug: "no problems" and "we couldn't ask" look
      // identical on screen unless one of them says so. TWO fields, not one, because
      // these are independent requests — a tasks poll that succeeds must not erase the
      // news that the issues poll failed, which is exactly the bug one shared field
      // produced.
      tasksError: null,
      issuesError: null,
      open: false, // the activity panel
    };
    this.cell = cell(this.#state);
    this._local = new Map(); // id -> local task (this browser owns these)
    this._server = [];
    this._timer = null;
    this._pollMs = null;
  }

  /**
   * The value, for whoever is about to decide something from it.
   *
   * The same door every slice offers. Actions read `.state` and queries read `.cell`, and
   * the two are only equal by habit — bl/state.js says so, and says a resource has one
   * value and one way to read it. `state` is also a public field on a service, which is one
   * typo from `social.state.sidecar = null` bypassing the cell and notifying nothing.
   */
  get() {
    return this.#state;
  }

  observe() {
    return this.cell;
  }
  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    this.cell.setValue(this.#state);
  }
  #merge() {
    this.#set({ tasks: [...this._local.values(), ...this._server] });
  }

  // --- local tasks -----------------------------------------------------------

  /**
   * Register work happening in this browser. Returns a handle with the same shape the
   * server's registry hands its callers, so code that reports progress doesn't need to
   * know which side it is running on.
   *
   * @param {{title: string, kind?: string, detail?: string, total?: number|null,
   *          unit?: string, onCancel?: () => void}} spec
   */
  start(spec = {}) {
    const id = spec.id || `local_${Math.random().toString(36).slice(2, 10)}`;
    const task = {
      id,
      source: 'local',
      kind: spec.kind || 'general',
      title: spec.title || 'Working',
      detail: spec.detail ?? null,
      status: 'running',
      done: 0,
      // No total means indeterminate, and that is a legitimate answer. A caller that
      // doesn't know how much work there is must not invent a number: a progress bar
      // that lies is worse than a spinner that admits it doesn't know.
      total: spec.total ?? null,
      unit: spec.unit || null,
      cancellable: !!spec.onCancel,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    this._local.set(id, task);
    this._cancels ||= new Map();
    if (spec.onCancel) this._cancels.set(id, spec.onCancel);
    this.#merge();
    this.#schedule();

    const patch = (p) => {
      const cur = this._local.get(id);
      if (!cur || cur.status !== 'running') return; // finished tasks are final
      this._local.set(id, { ...cur, ...p });
      this.#merge();
    };
    return {
      id,
      progress: (p = {}) => patch({
        done: p.done ?? this._local.get(id)?.done ?? 0,
        total: p.total === undefined ? this._local.get(id)?.total : p.total,
        unit: p.unit ?? this._local.get(id)?.unit,
        detail: p.detail ?? this._local.get(id)?.detail,
      }),
      succeed: (detail) => { patch({ status: 'done', endedAt: Date.now(), detail: detail ?? this._local.get(id)?.detail }); this.#expire(id); },
      fail: (err) => { patch({ status: 'failed', endedAt: Date.now(), error: err?.message || String(err || 'failed') }); },
      cancel: () => { patch({ status: 'cancelled', endedAt: Date.now() }); this.#expire(id); },
    };
  }

  /** A finished task lingers briefly so it is seen to finish, then goes. */
  #expire(id, after = 5000) {
    setTimeout(() => {
      this._local.delete(id);
      this._cancels?.delete(id);
      this.#merge();
    }, after);
  }

  async cancel(id) {
    const local = this._local.get(id);
    if (local) {
      this._cancels?.get(id)?.();
      return;
    }
    // A server task is a mirror: ask, then let the next poll tell the truth.
    try {
      await this.api.cancelTask(id);
      await this.refreshTasks();
    } catch (err) {
      this.#set({ tasksError: err.message });
    }
  }

  dismiss(id) {
    if (this._local.delete(id)) { this.#merge(); return; }
    this.api.dismissTask(id).catch(() => {});
    this._server = this._server.filter((t) => t.id !== id);
    this.#merge();
  }

  // --- server mirror + issues ------------------------------------------------

  async init() {
    await this.refresh();
    this.#schedule();
    // Coming back to the tab is the moment a stale list is most obvious.
    window.addEventListener('focus', () => this.refresh());
  }

  async refresh() {
    await Promise.all([this.refreshTasks(), this.refreshIssues()]);
  }

  async refreshTasks() {
    const wasRunning = this.running.length > 0;
    try {
      const { tasks } = await this.api.tasks();
      this._server = (tasks || []).map((t) => ({ ...t, source: 'server' }));
      this.#set({ tasksError: null });
      this.#merge();
    } catch (err) {
      // Offline or a server that doesn't have the endpoint: stop claiming to know.
      this._server = [];
      this.#set({ tasksError: err.message });
      this.#merge();
    }
    // The moment work STOPS is the moment an issue is most likely to have been fixed,
    // so re-read them then. Without this, a retry that succeeds in 50 ms leaves the
    // problem on screen until the next idle poll — up to a minute of the user being
    // told something is broken that isn't.
    if (wasRunning && !this.running.length) this.refreshIssues();
    this.#schedule();
  }

  async refreshIssues() {
    this.#set({ issuesLoading: true });
    try {
      const { issues } = await this.api.issues();
      this.#set({ issues: issues || [], issuesLoading: false, issuesError: null });
    } catch (err) {
      // Deliberately NOT clearing `issues`: the last known list is better than an empty
      // one that reads as "nothing is wrong".
      this.#set({ issuesLoading: false, issuesError: err.message });
    }
  }

  async retryIssue(id) {
    try {
      await this.api.retryIssue(id);
      // The fix runs as a task; adopt it now so the click visibly did something, and
      // let the poll clear the issue when the work actually succeeds. The retry may
      // finish faster than a poll interval, so re-read the issues directly too — a
      // Retry button that leaves the problem sitting there reads as a broken button.
      await this.refreshTasks();
      // A retry can finish faster than one poll interval — in which case there is no
      // running→idle transition to notice and the fixed problem would sit on screen
      // until the next idle poll. A couple of bounded follow-ups cover that window
      // without turning this into a busy loop.
      this.#followUp();
      this.platform.notifications.info('Retrying — watch its progress in Activity');
    } catch (err) {
      this.platform.notifications.error(`Couldn't retry: ${err.message}`);
    }
  }

  async dismissIssue(id) {
    const before = this.#state.issues;
    this.#set({ issues: before.filter((i) => i.id !== id) });
    try {
      await this.api.dismissIssue(id);
    } catch (err) {
      this.#set({ issues: before }); // put it back rather than pretend
      this.platform.notifications.error(`Couldn't dismiss: ${err.message}`);
    }
  }

  /** Two bounded re-reads after an action that may have resolved something. */
  #followUp() {
    for (const ms of [400, 1500]) {
      const t = setTimeout(() => { this.refreshTasks(); this.refreshIssues(); }, ms);
      t?.unref?.();
    }
  }

  /** Rebuild the whole search index. Surfaced as a command; reports as a task. */
  async rebuildIndex() {
    try {
      const res = await this.api.reindex();
      await this.refreshTasks();
      this.togglePanel(true);
      if (res.alreadyRunning) this.platform.notifications.info('A rebuild is already running');
      return res;
    } catch (err) {
      this.platform.notifications.error(`Couldn't rebuild the index: ${err.message}`);
      throw err;
    }
  }

  /**
   * Reconcile a collection with its object store — the way a drive notices files added,
   * replaced, or removed by anything that isn't Trove. Reports as a task, like a rebuild.
   */
  async scanCollection(collectionId) {
    try {
      const res = await this.api.scanCollection(collectionId);
      await this.refreshTasks();
      this.togglePanel(true);
      if (res.alreadyRunning) this.platform.notifications.info('A scan of this collection is already running');
      this.#followUp();
      return res;
    } catch (err) {
      this.platform.notifications.error(`Couldn't scan “${collectionId}”: ${err.message}`);
      throw err;
    }
  }

  /**
   * Ask the server whether the backing stores are actually usable from a browser.
   *
   * Unlike a scan or a reindex this finishes in one round trip, so it reports its own
   * result rather than handing back a task: the answer to "did I fix the bucket?" should
   * be available immediately, and the issue list is refreshed so a problem that is now
   * fixed visibly disappears rather than sitting there until the next poll.
   */
  async checkStorage() {
    try {
      const res = await this.api.checkStorage();
      await this.refresh();
      this.togglePanel(true);
      const problems = (res.results || []).reduce((n, r) => n + (r.findings?.length || 0), 0);
      if (problems) {
        this.platform.notifications.warn(`Found ${problems} storage problem${problems === 1 ? '' : 's'} — see Activity`);
      } else if (!res.checked) {
        this.platform.notifications.info('There are no collections to check yet');
      } else if (!res.corsChecked) {
        // Honest about what was not checked. Reporting "all good" having skipped the check
        // that matters is how a diagnostic stops being believed.
        this.platform.notifications.info('Stores are reachable. Browser access was not checked — this drive has no public URL configured.');
      } else {
        this.platform.notifications.success('Stores are reachable and allow browser access');
      }
      return res;
    } catch (err) {
      this.platform.notifications.error(`Couldn't check the stores: ${err.message}`);
      throw err;
    }
  }

  togglePanel(open) {
    this.#set({ open: open ?? !this.#state.open });
    if (this.#state.open) this.refresh();
  }

  get running() {
    return this.#state.tasks.filter((t) => t.status === 'running');
  }

  /**
   * Poll fast while something is running, slowly otherwise. Rescheduled rather than
   * fixed, so an idle drive costs one request a minute and a running rebuild feels
   * live — without a second transport to maintain.
   */
  #schedule() {
    const want = this.running.length ? ACTIVE_MS : IDLE_MS;
    if (this._timer && this._pollMs === want) return;
    clearTimeout(this._timer);
    this._pollMs = want;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.refreshTasks().then(() => {
        // Issues change when tasks end, so re-read them then rather than on their own
        // clock — a retry that fixed something should stop being listed promptly.
        if (!this.running.length) this.refreshIssues();
      });
    }, want);
    this._timer?.unref?.();
  }

  dispose() {
    clearTimeout(this._timer);
    this._timer = null;
  }
}

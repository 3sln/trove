// PluginIndexers — bridges installed plugin *indexer sub-packages* into the Vfs
// indexing pipeline. When an account installs (or, at startup, re-activates) a plugin
// that ships server indexers, this:
//   1. resolves each indexer's bundle from the PackageStore blob,
//   2. registers it into the Vfs IndexerRegistry (so it auto-runs on every upload),
//   3. backfills it over existing files.
// On uninstall it unregisters and purges the indexer's contributions.
//
// Execution goes through the injected IndexerRuntime, which is the isolation seam:
// tests/first-party use the in-process runtime; a deployment can swap an isolate one.

import { unzipSync } from 'fflate';
import { readAll, selectorMatches } from '../util.js';

export class PluginIndexers {
  /**
   * @param {object} deps
   * @param {import('../vfs.js').Vfs} deps.vfs
   * @param {import('./runtime.js').IndexerRuntime} deps.runtime
   * @param {import('./packageStore.js').PackageStore} deps.packages
   */
  constructor({ vfs, runtime, packages }) {
    this.vfs = vfs;
    this.runtime = runtime;
    this.packages = packages;
    this._bundles = new Map(); // packageRef -> Promise<Record<path, Uint8Array>>
    this._active = new Map(); // `${account}\0${indexerId}` -> unregister fn
  }

  /**
   * Register + backfill every indexer a record declares. Idempotent per (account,
   * indexer id): a re-activate replaces the prior registration. Records without server
   * indexers are a no-op.
   */
  async activate(record, { backfill = true } = {}) {
    const specs = record.indexers || [];
    // Retire anything this plugin used to declare and no longer does. Both this and
    // deactivate() iterated only the record in hand, so an indexer dropped by an
    // upgrade stayed registered — running code the user upgraded away from on every
    // upload, served from the in-memory bundle cache even after the blob was deleted —
    // and its contributions were orphaned in the index for good.
    const keep = new Set(specs.map((s) => s?.id).filter(Boolean));
    for (const id of this.#idsFor(record.account, record.pluginId)) {
      if (keep.has(id)) continue;
      this._active.get(this.#key(record.account, id))?.();
      this._active.delete(this.#key(record.account, id));
      try { await this.vfs.purgeIndexer(id); }
      catch (err) { console.error(`purge for retired indexer ${id} failed:`, err.message); }
    }
    for (const spec of specs) {
      if (!spec?.id) continue;
      const key = this.#key(record.account, spec.id);
      // Build BEFORE dropping the previous registration. Dropping first meant a
      // transient package-read failure left a previously-working indexer unregistered
      // while the install still reported success — and #loadPackage caches the rejected
      // promise, so it never recovered without a restart.
      const indexer = await this.#buildIndexer(record, spec);
      this._active.get(key)?.();
      const unregister = this.vfs.indexers.register(indexer);
      this._active.set(key, unregister);
      if (backfill) {
        try { await this.vfs.backfillIndexer(indexer); }
        catch (err) { console.error(`backfill for indexer ${spec.id} failed:`, err.message); }
      }
    }
    return specs.length;
  }

  /**
   * Can indexers actually run on this deployment? Passed straight through to the
   * runtime — PluginIndexers is the coordinator, not the thing that knows.
   */
  async probe() { return this.runtime?.probe?.() ?? { ok: true }; }

  /** Unregister + purge every indexer a record declared. */
  async deactivate(record) {
    for (const spec of record.indexers || []) {
      if (!spec?.id) continue;
      const key = this.#key(record.account, spec.id);
      this._active.get(key)?.();
      this._active.delete(key);
      try { await this.vfs.purgeIndexer(spec.id); }
      catch (err) { console.error(`purge for indexer ${spec.id} failed:`, err.message); }
    }
  }

  /** Which indexer ids this account currently has registered for one plugin. */
  #idsFor(account, pluginId) {
    const prefix = `${account}\0`;
    const out = [];
    for (const key of this._active.keys()) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      // Contribution URIs are `trove+contrib:<domain>/<name>/<contribution>`.
      if (pluginId && !id.includes(`:${pluginId}/`)) continue;
      out.push(id);
    }
    return out;
  }

  /** Re-activate all installed indexers across accounts at startup (no backfill). */
  async activateAll(records, opts = {}) {
    let n = 0;
    for (const record of records) n += await this.activate(record, { backfill: false, ...opts });
    return n;
  }

  #key(account, id) { return `${account}\0${id}`; }

  /**
   * An indexer is an ENTRY MODULE inside the plugin's one package — not a nested
   * sub-package — so it shares code with the rest of the plugin. The bundle handed to
   * the runtime is therefore the whole package, and `spec.entry` names which module to
   * run (e.g. "src/indexers/pdf.js").
   */
  async #buildIndexer(record, spec) {
    const files = await this.#loadPackage(record.packageRef);
    const entry = spec.entry;
    const match = matchFromSelector(spec.match);
    const runtime = this.runtime;
    const runSpec = { id: spec.id, entry, files, cacheKey: `${record.digest || record.packageRef}\0${spec.id}` };
    return {
      id: spec.id,
      displayName: spec.title || spec.name || spec.id,
      match,
      index: (node, ctx) => runtime.run(runSpec, node, { ...ctx, config: record.config || {}, secrets: record.secrets || {} }),
    };
  }

  #loadPackage(ref) {
    let p = this._bundles.get(ref);
    if (!p) {
      p = this.packages.get(ref).then(async ({ stream }) => unzipSync(await readAll(stream)));
      // Never cache a REJECTION. A transient read failure otherwise poisoned this ref
      // for the life of the process: every later activate got the same rejected promise
      // back and the indexer could not be brought up again without a restart.
      p.catch(() => this._bundles.delete(ref));
      this._bundles.set(ref, p);
    }
    return p;
  }
}

/** Turn an indexer `match` selector into a node predicate (shared matcher). */
export function matchFromSelector(sel = {}) {
  return (node) => selectorMatches(sel, node);
}


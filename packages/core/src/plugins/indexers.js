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
    for (const spec of specs) {
      if (!spec?.id) continue;
      const key = this.#key(record.account, spec.id);
      this._active.get(key)?.(); // drop any prior registration
      const indexer = await this.#buildIndexer(record, spec);
      const unregister = this.vfs.indexers.register(indexer);
      this._active.set(key, unregister);
      if (backfill) {
        try { await this.vfs.backfillIndexer(indexer); }
        catch (err) { console.error(`backfill for indexer ${spec.id} failed:`, err.message); }
      }
    }
    return specs.length;
  }

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
      this._bundles.set(ref, p);
    }
    return p;
  }
}

/** Turn an indexer `match` selector into a node predicate (shared matcher). */
export function matchFromSelector(sel = {}) {
  return (node) => selectorMatches(sel, node);
}


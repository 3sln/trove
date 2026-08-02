// PluginService — server-side install lifecycle for account-scoped plugins. Holds the
// pluggable PackageStore (blobs) + PluginInstallStore (records), re-parses uploaded
// packages, enforces the scope/authz gate (admin required for server indexers or
// shared resources), and is the authority for capability checks on plugin API calls.
//
// Device-scoped plugins (pure client capabilities) never reach here — they live only
// in the browser. Anything with a server footprint installs through this.

import { TroveError } from '../errors.js';
import { parsePluginPackage } from './package.js';

export { PackageStore, StoragePackageStore } from './packageStore.js';
export { PluginInstallStore, SqlitePluginInstallStore, MemoryPluginInstallStore } from './installStore.js';
export { parsePluginPackage, capabilityList, ALL_CAPABILITIES, serverIndexers, declaredOpeners, declaredContributions } from './package.js';
export * from './identity.js';
export { CONTRIBUTION_TYPES, contributionsOfType } from './contributions.js';
export { IndexerRuntime, InProcessIndexerRuntime } from './runtime.js';
export { WorkerLoaderIndexerRuntime } from './workerLoaderRuntime.js';
export { clampContribution, DEFAULT_CAPS } from '../indexers/contribution.js';
export { PluginIndexers, matchFromSelector } from './indexers.js';

// The account a principal installs into. Per-user for now; a workspace/org model can
// override this later without touching call sites.
function accountOf(principal) {
  if (!principal) throw TroveError.unauthorized('Authentication required');
  return principal.id;
}

export class PluginService {
  /**
   * @param {object} deps
   * @param {import('./packageStore.js').PackageStore} deps.packages
   * @param {import('./installStore.js').PluginInstallStore} deps.installs
   * @param {(principal:object)=>boolean} [deps.isAdmin]
   * @param {number} [deps.maxPackageBytes]
   * @param {import('./indexers.js').PluginIndexers} [deps.indexers] activate/deactivate server indexers
   */
  constructor({ packages, installs, isAdmin, indexers = null, maxPackageBytes = 32 * 1024 * 1024, strict = false } = {}) {
    this.packages = packages;
    this.installs = installs;
    this._isAdmin = isAdmin || (() => false);
    this.indexers = indexers; // PluginIndexers coordinator, or null when indexers are disabled
    this.maxPackageBytes = maxPackageBytes;
    // strict = deny a plugin API call when there's no server install record. Off by
    // default so plugins installed before server-installs existed keep working; a
    // deployment flips it on (once its clients have re-uploaded) to fully close the
    // "any client can name any pluginId" gap.
    this.strict = strict;
  }
  async init() {
    await this.installs?.init?.();
    // Re-register every installed server indexer into the pipeline (no backfill — the
    // files were indexed when installed; this just restores the live-upload hooks).
    if (this.indexers && this.installs?.all) {
      const records = (await this.installs.all()).filter((r) => r.indexers?.length);
      if (records.length) await this.indexers.activateAll(records);
    }
  }

  /** Whether a package needs admin approval: ships server code, or touches shared state. */
  requiresAdmin(pkg) {
    return (pkg.indexers && pkg.indexers.length > 0) || !!pkg.sharedStorage;
  }

  /**
   * Install (account scope). `bytes` is the raw package zip. `grants` is the caps the
   * user approved (defaults to all declared). Re-validates server-side, gates on scope,
   * stores the blob (deduped by digest) + the install record.
   */
  async install({ principal, bytes, grants }) {
    const account = accountOf(principal);
    if (bytes.byteLength > this.maxPackageBytes) throw TroveError.invalid('Package exceeds the maximum size');
    const pkg = await parsePluginPackage(bytes);
    const granted = (grants || pkg.capabilities).filter((c) => pkg.capabilities.includes(c));

    if (this.requiresAdmin(pkg) && !this._isAdmin(principal)) {
      throw TroveError.forbidden('This plugin ships server components or uses shared resources and needs an administrator to install it');
    }
    // Refuse server-indexer plugins when this deployment has no indexer runtime.
    if (pkg.indexers.length && !this.indexers) {
      throw TroveError.unsupported('Server indexers are disabled on this deployment');
    }
    // ...or when it HAS one that cannot run here — the in-process runner on workerd,
    // which cannot import a `data:` URL. That case DEGRADES rather than refusing: a
    // plugin is more than its indexer, and refusing the install would take the viewers,
    // commands and everything else away over one part the deployment cannot host.
    //
    // What it must not do is what it used to: run anyway and fail once per file forever,
    // with nothing said. So the reason is recorded ON the record — `indexersSkipped` —
    // and travels to the client, which is what turns "my search is empty" into a sentence
    // someone can act on. Asked once per install, not per node.
    const probe = pkg.indexers.length ? (await this.indexers?.probe?.() ?? { ok: true }) : { ok: true };

    const version = pkg.manifest.version || '0';
    // CONTENT-addressed. The ref used to be `<account>/<pluginId>/<version>.zip`, written
    // only when absent — so re-installing at the same version (the ordinary way to
    // iterate on a plugin) stored the new digest, the new grants and the new indexer
    // specs against the OLD bytes, and every device that synced the package got the old
    // code forever. Worse for a server indexer, whose entry modules are loaded from the
    // ref while the record advertises the new manifest's. Bumping the version instead
    // just leaked the previous blob.
    const prev = await this.installs.get(account, pkg.pluginId);
    const digestPart = String(pkg.digest).replace(/^sha256:/, '').slice(0, 32);
    const ref = `${encodeURIComponent(account)}/${encodeURIComponent(pkg.pluginId)}/${digestPart}.zip`;
    if (!(await this.packages.has(ref))) await this.packages.put(ref, bytes);

    const record = {
      account, pluginId: pkg.pluginId, version,
      scope: 'account', grants: granted, indexers: pkg.indexers, // full specs (id/match/entry/dir)
      config: {}, secrets: {},
      installedBy: principal.id, adminApprovedBy: this.requiresAdmin(pkg) ? principal.id : null,
      // Whether the SHARED domain store was actually approved. Computed at install
      // (it is what makes the package admin-only) and never written down, so the
      // runtime check in /api/plugins/:id/sql had nothing to consult: a plugin that
      // declared plain `storage: true`, needing no admin at all, could then open
      // `scope: "domain"` and reach its vendor's shared database.
      sharedStorage: !!pkg.sharedStorage,
      packageRef: ref, digest: pkg.digest, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.installs.put(record);
    // The bytes the previous install pointed at are now unreferenced — unless another
    // account installed the identical package, which is what countByDigest answers.
    if (prev?.packageRef && prev.packageRef !== ref && !(await this.#refIsShared(prev.packageRef, account))) {
      await this.packages.delete(prev.packageRef).catch(() => {});
    }
    // Register + backfill any server indexers this package ships — unless the probe
    // just said this deployment cannot run them, in which case registering would only
    // queue up a failure per file.
    if (this.indexers && pkg.indexers.length && probe.ok) {
      // REGISTER ONLY. The backfill used to run here, inline and awaited inside the
      // install request, which is the same mistake `completeUpload` made at a larger
      // scale: re-reading every matching file in a drive is not work a request can
      // finish, and on Workers the isolate goes before it gets far. The caller schedules
      // it instead — `beginBackfill`, which lands in the same Durable Object that owns
      // scans and reindexes, and reports through the same task record.
      try { await this.indexers.activate(record, { backfill: false }); }
      catch (err) { console.error(`activating indexers for ${record.pluginId} failed:`, err.message); }
    } else if (!probe.ok) {
      console.warn(`server indexers for ${record.pluginId} are not running: ${probe.reason}`);
    }
    return this.#annotate(this.#publicRecord(record));
  }

  /**
   * Why this record's indexers are not running, or null when they are.
   *
   * DERIVED, not stored. The reason is a property of the DEPLOYMENT, not of the install:
   * a drive that gains a Worker Loader binding should stop reporting "skipped" the moment
   * it restarts, without anyone rewriting rows — and a drive that loses one should start.
   * Storing it at install would freeze an answer that is only true until the next deploy.
   *
   * The probe caches its own result, so this costs nothing after the first call.
   */
  async #annotate(record) {
    if (!record?.indexers?.length) return record;
    const probe = await this.indexers?.probe?.() ?? { ok: true };
    return probe.ok ? record : { ...record, indexersSkipped: probe.reason };
  }

  /** An account's installed plugins (secrets stripped). */
  async list(principal) {
    const rows = (await this.installs.list(accountOf(principal))).map((r) => this.#publicRecord(r));
    return Promise.all(rows.map((r) => this.#annotate(r)));
  }
  async get(principal, pluginId) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    return r ? this.#annotate(this.#publicRecord(r)) : null;
  }

  /** Download the package blob (for a device to sync + enable). */
  async getPackage(principal, pluginId) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    if (!r) throw TroveError.notFound('Plugin');
    return this.packages.get(r.packageRef);
  }

  /** Remove: drop the record, then the blob if no other install shares its digest. */
  async remove(principal, pluginId) {
    const account = accountOf(principal);
    const r = await this.installs.get(account, pluginId);
    if (!r) return { ok: true, removed: null };
    // Unregister + purge server indexers before dropping the record/blob they load from.
    if (this.indexers && r.indexers?.length) {
      try { await this.indexers.deactivate(r); }
      catch (err) { console.error(`deactivating indexers for ${pluginId} failed:`, err.message); }
    }
    await this.installs.delete(account, pluginId);
    // Refs embed the ACCOUNT, so two accounts holding the same digest hold two distinct
    // blobs — a global digest count said "someone still has it" and left this one behind
    // with nothing that would ever reference it again. Ask about the blob we actually
    // hold, not about its contents.
    if (r.packageRef && !(await this.#refIsShared(r.packageRef, account))) {
      await this.packages.delete(r.packageRef).catch(() => {});
    }
    return { ok: true, removed: pluginId, indexers: (r.indexers || []).map((i) => i.id || i) };
  }

  /**
   * Authoritative capability check for a plugin API call. If the plugin is
   * server-installed, its granted caps are enforced. Transitional: with no server
   * install record we allow (device-installed plugins predate this and haven't
   * migrated); once the client account-install flow lands this becomes deny-by-default.
   */
  /**
   * Is this plugin installed on this account at all?
   *
   * Deliberately separate from `assertCapability`, because the two questions are not
   * the same and only one of them is transitional. Whether a plugin holds a GRANT can
   * fall back to allow while device-installed plugins migrate. Whether a caller may act
   * AS a plugin cannot: writing under `trove+contrib:vendor.com/plugin/…`, or opening a
   * vendor's shared domain store, is a claim on somebody else's identity, and index
   * contributions carry into search results and tag mirrors that other people in the
   * collection see. No record, no identity — in strict mode and out of it.
   */
  async assertInstalled(principal, pluginId) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    if (!r) throw TroveError.forbidden(`Plugin "${pluginId}" is not installed on this account`);
    return r;
  }

  /**
   * May this plugin open its vendor's SHARED domain store?
   *
   * Only if it declared that scope, which is what made the package admin-gated in the
   * first place. Declaring plain `storage: true` installs without an admin — and used
   * to reach the domain scope anyway, because nothing recorded which of the two had
   * been approved.
   */
  async assertSharedStorage(principal, pluginId) {
    const r = await this.assertInstalled(principal, pluginId);
    if (!r.sharedStorage) {
      throw TroveError.forbidden(
        `Plugin "${pluginId}" did not declare shared (domain) storage, so it cannot open it`,
      );
    }
    return r;
  }

  async assertCapability(principal, pluginId, cap) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    if (!r) {
      if (this.strict) throw TroveError.forbidden(`Plugin "${pluginId}" is not installed on this account`);
      return; // transitional allow
    }
    // `|| []` denies rather than throws on a record with no grants field. A record that
    // cannot say what it was granted was granted nothing.
    if (!(r.grants || []).includes(cap)) {
      throw TroveError.forbidden(`Plugin "${pluginId}" was not granted the "${cap}" capability`);
    }
  }

  /** Does any remaining install still point at this exact blob? */
  async #refIsShared(packageRef, exceptAccount) {
    if (!this.installs.all) return false;
    const all = await this.installs.all();
    return all.some((r) => r.packageRef === packageRef && r.account !== exceptAccount);
  }

  #publicRecord(r) {
    const { secrets, ...rest } = r; // never expose secrets over the API
    return rest;
  }
}

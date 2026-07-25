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
export { parsePluginPackage, capabilityList, ALL_CAPABILITIES } from './package.js';
export { IndexerRuntime, InProcessIndexerRuntime, clampContribution, DEFAULT_CAPS } from './runtime.js';
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

    const version = pkg.manifest.version || '0';
    const ref = `${encodeURIComponent(account)}/${encodeURIComponent(pkg.manifest.id)}/${encodeURIComponent(version)}.zip`;
    if (!(await this.packages.has(ref))) await this.packages.put(ref, bytes);

    const record = {
      account, pluginId: pkg.manifest.id, version,
      scope: 'account', grants: granted, indexers: pkg.indexers, // full specs (id/match/entry/dir)
      config: {}, secrets: {},
      installedBy: principal.id, adminApprovedBy: this.requiresAdmin(pkg) ? principal.id : null,
      packageRef: ref, digest: pkg.digest, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.installs.put(record);
    // Register + backfill any server indexers this package ships.
    if (this.indexers && pkg.indexers.length) {
      try { await this.indexers.activate(record); }
      catch (err) { console.error(`activating indexers for ${record.pluginId} failed:`, err.message); }
    }
    return this.#publicRecord(record);
  }

  /** An account's installed plugins (secrets stripped). */
  async list(principal) {
    return (await this.installs.list(accountOf(principal))).map((r) => this.#publicRecord(r));
  }
  async get(principal, pluginId) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    return r ? this.#publicRecord(r) : null;
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
    if (r.digest && (await this.installs.countByDigest(r.digest)) === 0) await this.packages.delete(r.packageRef);
    return { ok: true, removed: pluginId, indexers: (r.indexers || []).map((i) => i.id || i) };
  }

  /**
   * Authoritative capability check for a plugin API call. If the plugin is
   * server-installed, its granted caps are enforced. Transitional: with no server
   * install record we allow (device-installed plugins predate this and haven't
   * migrated); once the client account-install flow lands this becomes deny-by-default.
   */
  async assertCapability(principal, pluginId, cap) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    if (!r) {
      if (this.strict) throw TroveError.forbidden(`Plugin "${pluginId}" is not installed on this account`);
      return; // transitional allow
    }
    if (!r.grants.includes(cap)) {
      throw TroveError.forbidden(`Plugin "${pluginId}" was not granted the "${cap}" capability`);
    }
  }

  #publicRecord(r) {
    const { secrets, ...rest } = r; // never expose secrets over the API
    return rest;
  }
}

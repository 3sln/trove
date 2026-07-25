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
export { parsePluginPackage, capabilityList } from './package.js';

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
   */
  constructor({ packages, installs, isAdmin, maxPackageBytes = 32 * 1024 * 1024 } = {}) {
    this.packages = packages;
    this.installs = installs;
    this._isAdmin = isAdmin || (() => false);
    this.maxPackageBytes = maxPackageBytes;
  }
  async init() { await this.installs?.init?.(); }

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

    const version = pkg.manifest.version || '0';
    const ref = `${encodeURIComponent(account)}/${encodeURIComponent(pkg.manifest.id)}/${encodeURIComponent(version)}.zip`;
    if (!(await this.packages.has(ref))) await this.packages.put(ref, bytes);

    const record = {
      account, pluginId: pkg.manifest.id, version,
      scope: 'account', grants: granted, indexers: pkg.indexers.map((i) => i.id),
      config: {}, secrets: {},
      installedBy: principal.id, adminApprovedBy: this.requiresAdmin(pkg) ? principal.id : null,
      packageRef: ref, digest: pkg.digest, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await this.installs.put(record);
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
    await this.installs.delete(account, pluginId);
    if (r.digest && (await this.installs.countByDigest(r.digest)) === 0) await this.packages.delete(r.packageRef);
    return { ok: true, removed: pluginId, indexers: r.indexers || [] };
  }

  /**
   * Authoritative capability check for a plugin API call. If the plugin is
   * server-installed, its granted caps are enforced. Transitional: with no server
   * install record we allow (device-installed plugins predate this and haven't
   * migrated); once the client account-install flow lands this becomes deny-by-default.
   */
  async assertCapability(principal, pluginId, cap) {
    const r = await this.installs.get(accountOf(principal), pluginId);
    if (!r) return; // transitional allow
    if (!r.grants.includes(cap)) {
      throw TroveError.forbidden(`Plugin "${pluginId}" was not granted the "${cap}" capability`);
    }
  }

  #publicRecord(r) {
    const { secrets, ...rest } = r; // never expose secrets over the API
    return rest;
  }
}

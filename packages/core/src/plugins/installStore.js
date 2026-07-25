// PluginInstallStore — the bookkeeping half of server plugin installs: which
// packages an account has installed, at what version, with which capabilities
// granted, plus config/secrets and the PackageStore ref. Small and queryable, so it
// lives in the shared SQLite provider (a `plugin_installs` table) rather than the
// bulk blob store. A memory impl backs tests / provider-less use.

import { TroveError } from '../errors.js';

const COLS = ['account', 'pluginId', 'version', 'scope', 'grants', 'indexers', 'config', 'secrets', 'installedBy', 'adminApprovedBy', 'packageRef', 'digest', 'createdAt', 'updatedAt'];

export class PluginInstallStore {
  async init() {}
  /** Upsert a record by (account, pluginId). */
  async put(record) { throw TroveError.unsupported('PluginInstallStore.put'); }
  /** @returns {Promise<object|null>} */
  async get(account, pluginId) { throw TroveError.unsupported('PluginInstallStore.get'); }
  /** @returns {Promise<object[]>} an account's installs. */
  async list(account) { throw TroveError.unsupported('PluginInstallStore.list'); }
  async delete(account, pluginId) { throw TroveError.unsupported('PluginInstallStore.delete'); }
  /** How many installs reference a blob digest (for dedupe on blob delete). */
  async countByDigest(digest) { throw TroveError.unsupported('PluginInstallStore.countByDigest'); }
}

// --- SQLite (shared provider) ------------------------------------------------

const JSON_FIELDS = new Set(['grants', 'indexers', 'config', 'secrets']);

export class SqlitePluginInstallStore extends PluginInstallStore {
  constructor({ provider, key = 'plugins' } = {}) {
    super();
    this._opts = { provider, key };
    this.db = null;
  }
  async init() {
    if (this.db) return;
    if (!this._opts.provider) throw TroveError.invalid('SqlitePluginInstallStore needs a provider');
    this.db = await this._opts.provider.obtain({ key: this._opts.key });
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_installs (
        account TEXT NOT NULL,
        pluginId TEXT NOT NULL,
        version TEXT,
        scope TEXT,
        grants TEXT NOT NULL DEFAULT '[]',
        indexers TEXT NOT NULL DEFAULT '[]',
        config TEXT NOT NULL DEFAULT '{}',
        secrets TEXT NOT NULL DEFAULT '{}',
        installedBy TEXT,
        adminApprovedBy TEXT,
        packageRef TEXT,
        digest TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (account, pluginId)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_installs_digest ON plugin_installs(digest);
    `);
  }
  async put(record) {
    const r = normalize(record);
    await this.db.run(
      `INSERT INTO plugin_installs (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})
       ON CONFLICT(account, pluginId) DO UPDATE SET
         version=excluded.version, scope=excluded.scope, grants=excluded.grants, indexers=excluded.indexers,
         config=excluded.config, secrets=excluded.secrets, installedBy=excluded.installedBy,
         adminApprovedBy=excluded.adminApprovedBy, packageRef=excluded.packageRef, digest=excluded.digest,
         updatedAt=excluded.updatedAt`,
      ...COLS.map((c) => (JSON_FIELDS.has(c) ? JSON.stringify(r[c] ?? (c === 'config' || c === 'secrets' ? {} : [])) : r[c] ?? null)),
    );
    return r;
  }
  async get(account, pluginId) {
    return hydrate(await this.db.get('SELECT * FROM plugin_installs WHERE account=? AND pluginId=?', account, pluginId));
  }
  async list(account) {
    const rows = await this.db.all('SELECT * FROM plugin_installs WHERE account=? ORDER BY updatedAt DESC', account);
    return rows.map(hydrate);
  }
  async delete(account, pluginId) {
    await this.db.run('DELETE FROM plugin_installs WHERE account=? AND pluginId=?', account, pluginId);
  }
  async countByDigest(digest) {
    const r = await this.db.get('SELECT COUNT(*) AS n FROM plugin_installs WHERE digest=?', digest);
    return r?.n ?? 0;
  }
}

// --- Memory ------------------------------------------------------------------

export class MemoryPluginInstallStore extends PluginInstallStore {
  constructor() { super(); this.map = new Map(); }
  #key(a, p) { return `${a}\0${p}`; }
  async put(record) { const r = normalize(record); this.map.set(this.#key(r.account, r.pluginId), r); return r; }
  async get(account, pluginId) { const r = this.map.get(this.#key(account, pluginId)); return r ? { ...r } : null; }
  async list(account) { return [...this.map.values()].filter((r) => r.account === account).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => ({ ...r })); }
  async delete(account, pluginId) { this.map.delete(this.#key(account, pluginId)); }
  async countByDigest(digest) { return [...this.map.values()].filter((r) => r.digest === digest).length; }
}

function normalize(record) {
  const now = record.updatedAt ?? Date.now();
  return {
    account: record.account, pluginId: record.pluginId, version: record.version ?? null,
    scope: record.scope ?? 'account', grants: record.grants ?? [], indexers: record.indexers ?? [],
    config: record.config ?? {}, secrets: record.secrets ?? {}, installedBy: record.installedBy ?? null,
    adminApprovedBy: record.adminApprovedBy ?? null, packageRef: record.packageRef ?? null, digest: record.digest ?? null,
    createdAt: record.createdAt ?? now, updatedAt: now,
  };
}
function hydrate(row) {
  if (!row) return null;
  const out = { ...row };
  for (const f of JSON_FIELDS) out[f] = row[f] ? JSON.parse(row[f]) : (f === 'config' || f === 'secrets' ? {} : []);
  return out;
}

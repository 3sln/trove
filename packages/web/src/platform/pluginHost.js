// PluginHost — the plugin lifecycle orchestrator. It owns the set of installed
// plugins and their runtime records, and composes four focused collaborators:
//
//   FrameManager     (pluginFrames.js) — sandboxed iframe spawn/handshake/destroy
//   PluginRpcRouter  (pluginRpc.js)    — the trusted boundary: capability-gated RPC
//   FrameDock        (pluginDock.js)   — where a frame is shown; the floating dock
//   MediaController  (pluginMedia.js)  — navigator.mediaSession bridging
//
// What stays here is the lifecycle proper: install/restore/reconcile/uninstall, the
// availability heartbeat, and mounting a plugin into a panel or viewer.
//
// A plugin's code runs inside a sandboxed iframe on an OPAQUE origin: it can't touch
// the host DOM, read cookies/storage, or fetch its own package files. Everything it
// can do flows over one transferred MessagePort, gated by the capabilities the user
// granted at install time. Plugins are persisted (PluginRegistry, IndexedDB) so they
// survive reloads, and re-announce a live capability manifest so the workbench knows
// what works right now (incl. offline). See pluginPackage.js / pluginSigning.js for
// install-time validation and the domain-verified trust signal.

import { zipSync } from 'fflate';
import { PluginRegistry } from './pluginStore.js';
import { ClientSqlProvider } from './pluginClientDb.js';
import { assessTrust } from './pluginSigning.js';
import { ADMIN_ONLY_CAPS, capabilityList, networkEndpoints, grantedStorageScopes, parsePackage } from './pluginPackage.js';
import { declaredOpeners } from '@trove/core/plugins/package.js';
import { endpointSummary } from './pluginNet.js';
import { MediaController } from './pluginMedia.js';
import { FrameDock } from './pluginDock.js';
import { FrameManager } from './pluginFrames.js';
import { PluginRpcRouter } from './pluginRpc.js';
// The canonical capability list lives in core (the server's authority); import it so
// client and server can't drift when a capability is added.
import { ALL_CAPABILITIES } from '@trove/core/plugins/package.js';

export class PluginHost {
  constructor(platform, { heartbeatMs = 20000 } = {}) {
    this.platform = platform;
    this.plugins = new Map(); // id -> runtime record
    this.registry = new PluginRegistry();
    this.clientDb = new ClientSqlProvider(); // on-device per-scope SQLite (wasm)
    this.online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.heartbeatMs = heartbeatMs;
    this._heartbeat = null;
    this._probing = false;
    this.subject = platform.reactive.ObservableSubject ? new platform.reactive.ObservableSubject([]) : null;

    // Collaborators. The dock destroys frames through the frame manager (assigned
    // just below — the callback is lazy), and both are consulted on frame teardown.
    this.media = new MediaController();
    this.dock = new FrameDock({
      destroyFrame: (frame) => this.frames.destroy(frame),
      openFile: (node, openerId) => this.platform.workbench.openFile(node, openerId),
      onChange: () => this.#emit(),
    });
    this.frames = new FrameManager({ media: this.media, dock: this.dock });
    this.rpc = new PluginRpcRouter({
      platform, clientDb: this.clientDb, media: this.media, dock: this.dock,
      onChange: () => this.#emit(),
    });
  }

  observe() {
    return this.subject;
  }
  #emit() {
    this.subject?.next(this.list());
  }

  /**
   * Spawn one sandboxed frame for `record`, wired to this host's RPC router.
   * `entry` boots a different module of the plugin's tree (that's what an opener is).
   */
  #spawnFrame(record, role, entry) {
    return this.frames.spawn(record, role, {
      onCall: (rec, m, p, f) => this.rpc.hostCall(rec, m, p, f),
      onEvent: (rec, m, p, f) => this.rpc.hostEvent(rec, m, p, f),
      online: this.online,
      entry,
    });
  }

  /**
   * Register everything the MANIFEST declares. The manifest is authoritative — this
   * runs before the plugin boots, so: the user's install-time review matches exactly
   * what gets registered, openers/indexers exist without activating the plugin, and
   * they survive a plugin whose primary frame is broken or unresponsive.
   */
  #registerContributions(runtime) {
    const pid = runtime.manifest.id;
    const c = runtime.manifest.contributes || {};
    const keep = (dispose) => runtime.disposers.push(dispose);

    // Openers: each names the entry module that renders it, in its own frame.
    for (const o of declaredOpeners(runtime.manifest)) {
      if (!runtime.grants.includes('opener')) break; // user declined "provides viewers"
      keep(this.platform.contributions.openers.register({
        id: o.id, title: o.title, selector: o.selector, priority: o.priority,
        offline: o.offline, dock: o.dock, entry: o.entry, pluginId: pid,
      }));
    }
    // NOTE: declared indexers are deliberately NOT registered here. They run on the
    // server (PluginIndexers registers them into the Vfs registry from the install
    // record), because indexing must happen once per upload for the drive — not in
    // whichever browser tab happens to be open.
    //
    // Commands: declared here, implemented by the plugin's primary frame (by id).
    for (const cmd of c.commands || []) {
      if (!cmd?.id) continue;
      keep(this.platform.commands.register({
        id: cmd.id, title: cmd.title || `${runtime.manifest.name}: ${cmd.id}`,
        category: cmd.category || runtime.manifest.name, icon: cmd.icon,
        when: cmd.when, offline: !!cmd.offline, pluginId: pid,
        handler: (...args) => runtime.channel?.call('command:execute', { id: cmd.id, args }),
      }));
    }
    // Pure data — no plugin code involved at all.
    for (const s of c.statusItems || []) if (s?.id) keep(this.platform.contributions.statusItems.register({ ...s, pluginId: pid }));
    for (const k of c.keybindings || []) if (k?.key) keep(this.platform.contributions.keybindings.register(k));
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version, status: p.status,
      capabilities: p.grants, error: p.error || null, hasUi: p.hasUi, badge: p.badge || null,
      trust: p.trust || null, settingsSchema: p.manifest.settings || [],
      endpoints: endpointSummary(networkEndpoints(p.manifest)),
      responsive: !!p.responsive, manifest: p.live || null, features: this.#featureList(p),
    }));
  }

  /**
   * What this plugin contributes — read from the MANIFEST, so the list is known
   * without the plugin running (and stays accurate if it stops responding). `live`
   * is only used for liveness/availability, not for what exists.
   */
  #featureList(record) {
    const c = record.manifest?.contributes || {};
    const rows = [];
    const push = (kind, items) => { for (const it of items || []) if (it?.id) rows.push({ kind, id: it.id, title: it.title || it.id, offline: !!it.offline, available: this.#availableSpec(record, it) }); };
    push('command', c.commands);
    push('opener', c.openers);
    push('indexer', c.indexers);
    push('statusItem', c.statusItems);
    return rows;
  }
  #availableSpec(record, spec) {
    if (record.status !== 'active' || !record.responsive) return false;
    return this.online || !!spec.offline;
  }
  isAvailable(contrib) {
    if (!contrib?.pluginId) return true;
    const record = this.plugins.get(contrib.pluginId);
    if (!record) return false;
    return this.#availableSpec(record, contrib);
  }

  // --- install / restore -----------------------------------------------------

  /** Whether the current user may grant a capability (some need admin). */
  canGrant(cap, isAdmin) {
    return !ADMIN_ONLY_CAPS.has(cap) || !!isAdmin;
  }

  /**
   * Install a parsed package. `grants` is the subset of requested capabilities
   * the user approved (the review UI filters admin-only caps for non-admins).
   */
  async install(pkg, { grants, trust } = {}) {
    const id = pkg.manifest.id;
    const requested = capabilityList(pkg.manifest);
    const granted = (grants || requested).filter((c) => ALL_CAPABILITIES.includes(c) && requested.includes(c));
    // Account-scoped plugins (server storage or a server indexer) upload their full
    // package to the server: it re-validates, gates admin-only packages, and becomes
    // the canonical copy so the plugin syncs to the user's other devices and its
    // capabilities are enforced server-side. Throws if the server rejects (e.g. admin
    // required) — surfaced to the user by the install UI. Device-scoped plugins stay local.
    const scope = accountScoped(pkg.manifest, granted, pkg.files) ? 'account' : 'device';
    if (scope === 'account') {
      if (!pkg.raw) throw new Error('Package bytes unavailable for a server install');
      await this.platform.api.installPlugin(pkg.raw, granted);
    }
    const storage = granted.includes('storage')
      ? grantedStorageScopes(pkg.manifest, trust)
      : { plugin: false, domain: false };
    const record = {
      id, manifest: pkg.manifest,
      files: Object.fromEntries([...pkg.files.entries()]),
      grants: granted, storage, trust: trust || null, scope,
      settings: {}, secrets: {}, installedAt: Date.now(),
    };
    await this.registry.save(record);
    this.#registerSettings(record);
    await this.#run(record);
    return this.plugins.get(id);
  }

  /** Load all persisted plugins (call once at startup), then sync account plugins. */
  async restore() {
    let records = [];
    try {
      records = await this.registry.list();
    } catch { /* no IndexedDB */ }
    for (const rec of records) {
      // A single corrupt persisted record (missing manifest, etc.) must not abort the
      // restore of every other plugin — guard per record.
      try {
        this.#registerSettings(rec);
        this.#run(rec).catch((e) => console.error('restore plugin failed', rec.id, e));
      } catch (e) {
        console.error('skipping corrupt plugin record', rec?.id, e);
        this.platform.notifications.warn(`Couldn't restore plugin "${rec?.manifest?.name || rec?.id || 'unknown'}" — its saved data looks corrupt.`);
      }
    }
    // Reconcile with the server's account plugins (best-effort, offline-tolerant).
    this.#reconcile(records).catch(() => {});
  }

  // Two-way sync of account plugins with the server: push any local account plugin the
  // server is missing (migration for pre-existing local installs), and pull any server
  // account plugin not yet on this device (cross-device sync).
  async #reconcile(localRecords) {
    let serverList;
    try { serverList = (await this.platform.api.installedPlugins()).plugins || []; } catch { return; }
    const serverIds = new Set(serverList.map((p) => p.pluginId));
    const localIds = new Set(localRecords.map((r) => r.id));
    let pushFailures = 0;
    let pulled = 0;
    let pullFailures = 0;

    // Push: local account plugins the server doesn't have → re-upload (re-zipped).
    for (const rec of localRecords) {
      if (rec.scope !== 'account' || serverIds.has(rec.id)) continue;
      try {
        await this.platform.api.installPlugin(zipSync(toU8Files(rec.files)), rec.grants || []);
      } catch (e) { console.error('re-upload plugin failed', rec.id, e); pushFailures++; }
    }

    // Pull: server account plugins not on this device → download + enable.
    for (const rec of serverList) {
      if (localIds.has(rec.pluginId)) continue;
      try {
        const pkg = parsePackage(await this.platform.api.pluginPackage(rec.pluginId));
        const grants = rec.grants || [];
        const record = {
          id: rec.pluginId, manifest: pkg.manifest,
          files: Object.fromEntries([...pkg.files.entries()]),
          grants,
          // The server already gated storage scopes at install; expose what's declared.
          storage: grants.includes('storage')
            ? { plugin: true, domain: !!pkg.manifest.capabilities?.storage?.domain }
            : { plugin: false, domain: false },
          trust: null, scope: 'account',
          settings: {}, secrets: {}, installedAt: rec.createdAt || Date.now(),
        };
        await this.registry.save(record);
        this.#registerSettings(record);
        await this.#run(record);
        pulled++;
      } catch (e) { console.error('sync plugin failed', rec.pluginId, e); pullFailures++; }
    }

    if (pulled) this.platform.notifications.info(`Synced ${pulled} account plugin${pulled > 1 ? 's' : ''} from the server.`);
    if (pushFailures || pullFailures) {
      const parts = [];
      if (pullFailures) parts.push(`${pullFailures} couldn't be downloaded`);
      if (pushFailures) parts.push(`${pushFailures} couldn't be uploaded`);
      this.platform.notifications.warn(`Some account plugins didn't sync: ${parts.join(', ')}.`);
    }
  }

  #registerSettings(record) {
    const schema = (record.manifest.settings || []).filter((s) => !s.secret);
    if (schema.length) {
      record._settingsDispose = this.platform.settings.scopedFor(record.id).register(
        schema.map((s) => ({ ...s, category: record.manifest.name })),
      );
    }
  }

  // --- run (create the plugin's primary sandboxed iframe) --------------------

  async #run(record) {
    if (this.plugins.get(record.id)?.status === 'active') return;
    const runtime = {
      ...record, iframe: null, status: 'loading', error: null, disposers: [], channel: null,
      hasUi: false, responsive: false, frame: null, frames: new Set(),
      // Storage scopes (defaulted for records saved before this field existed).
      storage: record.storage || (record.grants?.includes('storage') ? grantedStorageScopes(record.manifest, record.trust) : { plugin: false, domain: false }),
      files: mapFromFiles(record.files),
    };
    this.plugins.set(record.id, runtime);
    // Register declared contributions BEFORE booting — they don't depend on the
    // plugin running, and this keeps them alive if its frame never comes up.
    try { this.#registerContributions(runtime); } catch (e) { console.error('registering contributions failed', record.id, e); }
    this.#emit();

    try {
      // The primary (background) frame: registers commands/indexers, does one-time
      // setup. Its channel is the record's channel used for probes and commands.
      const frame = await this.#spawnFrame(runtime, 'primary');
      // Uninstalled while the handshake was in flight? The record is no longer in the
      // map — tear this frame down instead of leaving a live, unreachable iframe.
      if (this.plugins.get(record.id) !== runtime) { this.frames.destroy(frame); return runtime; }
      runtime.frame = frame;
      runtime.iframe = frame.iframe;
      runtime.channel = frame.channel;
      runtime.status = 'active';
      runtime.responsive = true;
      this.#probe(runtime).then(() => this.#emit());
      this.#startHeartbeat();
    } catch (err) {
      runtime.status = 'error';
      runtime.error = err?.message || String(err);
      this.platform.notifications.error(`Plugin "${record.manifest.name}" failed to load: ${runtime.error}`);
    }
    this.#emit();
    return runtime;
  }

  // --- settings & secrets (host-side, for the UI) ----------------------------

  async setSecret(pluginId, key, value) {
    const rec = await this.registry.get(pluginId);
    if (!rec) return;
    rec.secrets = { ...rec.secrets, [key]: value };
    await this.registry.save(rec);
    const runtime = this.plugins.get(pluginId);
    if (runtime) runtime.secrets = rec.secrets;
    runtime?.channel?.emit('settings:changed', { key, value: '••••' });
  }
  async getSecret(pluginId, key) {
    const rec = await this.registry.get(pluginId);
    return rec?.secrets?.[key] ?? '';
  }

  // --- heartbeat / availability ----------------------------------------------

  #startHeartbeat() {
    if (this._heartbeat || !this.heartbeatMs) return;
    this._heartbeat = setInterval(() => this.#heartbeat(), this.heartbeatMs);
    if (this._heartbeat?.unref) this._heartbeat.unref();
  }
  #stopHeartbeat() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
  }
  async #heartbeat() {
    if (this._probing) return;
    this._probing = true;
    try {
      let changed = false;
      for (const r of this.plugins.values()) if (r.status === 'active') changed = (await this.#probe(r)) || changed;
      if (changed) this.#emit();
    } finally {
      this._probing = false;
    }
  }
  setHeartbeat(ms) {
    this.heartbeatMs = ms;
    this.#stopHeartbeat();
    if (ms && [...this.plugins.values()].some((r) => r.status === 'active')) this.#startHeartbeat();
  }
  async #probe(record) {
    if (record.status !== 'active' || !record.channel) return false;
    const before = { responsive: record.responsive, sig: signature(record.live) };
    try {
      record.live = await record.channel.call('manifest', {}, { timeout: 4000 });
      record.responsive = true;
      record.lastManifestAt = Date.now();
    } catch {
      record.responsive = false;
    }
    return before.responsive !== record.responsive || before.sig !== signature(record.live);
  }
  async setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    await Promise.all([...this.plugins.values()].filter((r) => r.status === 'active').map(async (r) => {
      try { r.channel?.emit('connectivity', { online }); } catch { /* ignore */ }
      for (const frame of r.frames || []) { try { frame.channel?.emit('connectivity', { online }); } catch { /* ignore */ } }
      await this.#probe(r);
    }));
    this.#emit();
  }
  async refresh(pluginId) {
    const record = this.plugins.get(pluginId);
    if (record) { await this.#probe(record); this.#emit(); }
  }

  // --- mounting (panel / viewer) ---------------------------------------------
  //
  // Where a frame is *shown* is FrameDock's job (position:fixed overlay tracking a
  // target element — we never re-parent an iframe, which would reload it). These
  // methods own the mount lifecycle: which frame, opened with what, and what happens
  // when it detaches.

  mountPanel(pluginId, container, { width = 380, height = 480 } = {}) {
    const record = this.plugins.get(pluginId);
    if (!record?.frame) return null;
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    this.dock.place(record.frame, container, 50);
    record.hasUi = true;
    return () => this.dock.hide(record.frame);
  }

  /**
   * Mount a plugin opener as the viewer for `node`. Each viewer runs in its OWN
   * sandboxed iframe (spawned with the plugin's capabilities), so viewers are
   * isolated from the background instance and from each other. Returns a detach fn:
   * if the viewer registered `dock`, its frame is kept alive as a floating dock,
   * otherwise it is destroyed.
   */
  mountViewer(pluginId, container, node, openerId, hooks = {}) {
    const record = this.plugins.get(pluginId);
    if (!record) { hooks.onError?.('Plugin is not available'); return null; }

    // Re-adopt the docked frame if it's the same file — preserves live playback
    // (the docked <video>/<audio> keeps running) instead of spawning a fresh viewer.
    const docked = this.dock.docked;
    if (docked && docked.record === record && docked.node?.id === node.id && docked.openerId === openerId) {
      this.dock.undock(docked);
      this.dock.place(docked, container, 3);
      hooks.onReady?.();
      return () => this.#detachViewer(docked);
    }

    // Boot the frame at the OPENER's entry module — not the plugin's main entry, so a
    // viewer loads only the code it needs and never re-runs the plugin's background setup.
    const opener = this.platform.contributions.openers.get(openerId);
    const mount = { cancelled: false, frame: null };
    this.#spawnFrame(record, 'viewer', opener?.entry).then(async (frame) => {
      if (mount.cancelled) { this.frames.destroy(frame); return; }
      mount.frame = frame;
      frame.node = node;
      frame.openerId = openerId;
      record.frames.add(frame);
      this.dock.place(frame, container, 3);
      try {
        await frame.channel?.call('opener:open', { openerId, file: node, context: {} });
        if (!mount.cancelled) hooks.onReady?.();
      } catch (err) {
        if (!mount.cancelled) hooks.onError?.(err?.message || 'Failed to open');
      }
    }).catch((e) => {
      console.error('viewer frame failed to load', e);
      if (!mount.cancelled) hooks.onError?.(e?.message || 'This viewer failed to load');
    });
    record.hasUi = true;

    return () => {
      mount.cancelled = true;
      if (mount.frame) this.#detachViewer(mount.frame);
    };
  }

  // A viewer went off-screen: dock it (if it opted in and isn't dismissed) or destroy it.
  #detachViewer(frame) {
    if (frame.dock?.enabled && !frame.dock.dismissed) this.dock.dock(frame);
    else this.frames.destroy(frame);
  }

  // --- uninstall --------------------------------------------------------------

  /** Uninstall: stop the plugin, forget it, and wipe everything it owns. */
  async uninstall(pluginId, { wipeData = true } = {}) {
    const record = this.plugins.get(pluginId);
    const name = record?.manifest?.name || pluginId;
    const isAccount = record?.scope === 'account'
      || (await this.registry.get(pluginId).catch(() => null))?.scope === 'account';

    // Account plugins: the server holds the canonical copy. Remove it there FIRST — if
    // that fails we must NOT tear down locally, or the plugin silently resurrects on the
    // next reload (server still lists it) with no sign anything went wrong.
    if (wipeData && isAccount) {
      try {
        await this.platform.api.uninstallPluginServer(pluginId);
      } catch (err) {
        this.platform.notifications.error(`Couldn't uninstall "${name}" from the server: ${err.message}. It's still installed.`);
        return;
      }
    }

    if (record) {
      try { record.channel?.emit('deactivate'); } catch { /* ignore */ }
      for (const d of record.disposers) { try { d(); } catch { /* ignore */ } }
      record._settingsDispose?.();
      for (const frame of [...(record.frames || [])]) this.frames.destroy(frame); // viewer/dock frames
      // The primary frame may have an open panel placement (observers + listeners).
      if (record.frame) { this.dock.stopPlace(record.frame); this.media.releaseActions(record.frame); }
      record.channel?.dispose();
      record.iframe?.remove();
      this.plugins.delete(pluginId);
    }
    // Best-effort cleanup of the plugin's private stores. A failure here doesn't block
    // uninstall, but the user is told so leftover data isn't silently orphaned.
    const wipeFailures = [];
    if (wipeData) {
      if (!isAccount) await this.platform.api.request('DELETE', `/api/plugins/${encodeURIComponent(pluginId)}/data`).catch(() => wipeFailures.push('server-side data'));
      await this.clientDb.drop(`plg:${pluginId}`).catch(() => wipeFailures.push('on-device data'));
    }
    await this.registry.remove(pluginId).catch(() => {});
    if (![...this.plugins.values()].some((r) => r.status === 'active')) this.#stopHeartbeat();
    this.#emit();
    if (wipeFailures.length) this.platform.notifications.warn(`Uninstalled "${name}", but couldn't clear its ${wipeFailures.join(' and ')}.`);
  }

  // --- trust ------------------------------------------------------------------

  /** Fetch a domain's assetlinks doc through the server (avoids CORS). */
  fetchAssetlinks = async (domain) => {
    const res = await this.platform.api.request('GET', '/api/plugins/assetlinks', { query: { domain } });
    return res?.assetlinks || null;
  };
  assessTrust(pkg) {
    return assessTrust(pkg, this.fetchAssetlinks);
  }
}

function mapFromFiles(files) {
  const m = new Map();
  for (const [k, v] of Object.entries(files)) m.set(k, v instanceof Uint8Array ? v : new Uint8Array(v));
  return m;
}

// Coerce a stored files object (path -> bytes, possibly ArrayBuffer after IndexedDB
// round-trip) into the { path: Uint8Array } shape fflate's zipSync expects.
function toU8Files(files) {
  const out = {};
  for (const [k, v] of Object.entries(files || {})) out[k] = v instanceof Uint8Array ? v : new Uint8Array(v);
  return out;
}

// A plugin is account-scoped (must install to the server) if it has a server
// footprint: server storage, or a server indexer (declared or embedded sub-package).
// Purely client-side plugins stay device-local.
function accountScoped(manifest, granted, files) {
  if (granted.includes('storage')) return true;
  if (Array.isArray(manifest.serverIndexers) && manifest.serverIndexers.length) return true;
  for (const path of files.keys()) if (/^indexers\/[^/]+\/manifest\.json$/.test(path)) return true;
  return false;
}

function signature(live) {
  if (!live) return '';
  const c = live.contributions || {};
  const flat = ['commands', 'openers', 'indexers', 'statusItems'].flatMap((k) => (c[k] || []).map((x) => `${k}:${x.id}:${x.offline ? 1 : 0}`));
  return `${live.online ? 1 : 0}|${flat.sort().join(',')}`;
}

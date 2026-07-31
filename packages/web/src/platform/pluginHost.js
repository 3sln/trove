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
import { ADMIN_ONLY_CAPS, capabilityList, networkEndpoints, grantedStorageScopes, parsePackage, displayName, canExecuteCommand } from './pluginPackage.js';
import { declaredContributions, parseKeymap, serverIndexers } from '@3sln/trove/core/plugins/contributions.js';
import { pluginId, contribUri } from '@3sln/trove/core/plugins/identity.js';
import { endpointSummary } from './pluginNet.js';
import { MediaController } from './pluginMedia.js';
import { FrameDock } from './pluginDock.js';
import { InvokePluginCommandAction } from '../bl/actions.js';
import { FrameManager } from './pluginFrames.js';
import { PluginRpcRouter } from './pluginRpc.js';
// The canonical capability list lives in core (the server's authority); import it so
// client and server can't drift when a capability is added.
import { ALL_CAPABILITIES } from '@3sln/trove/core/plugins/package.js';

export class PluginHost {
  constructor(platform, { heartbeatMs = 20000 } = {}) {
    this.platform = platform;
    this.plugins = new Map(); // id -> runtime record
    this.registry = new PluginRegistry();
    // On-device per-scope SQLite (wasm). A failed background persist is data a plugin
    // already believes it saved, so it surfaces rather than disappearing into a log.
    this.clientDb = new ClientSqlProvider({
      onError: (err, key) => this.platform.notifications.error(`A plugin's on-device data couldn't be saved (${key}): ${err.message}`),
    });
    this.online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.heartbeatMs = heartbeatMs;
    this._heartbeat = null;
    this._probing = false;
    this.cell = platform.reactive.cell([]);

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
    return this.cell;
  }
  #emit() {
    this.cell.setValue(this.list());
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
   * Register everything the MANIFEST declares, each at its own contribution URI. The
   * manifest is authoritative — this runs before the plugin boots, so: the user's
   * install-time review matches exactly what gets registered, openers/indexers exist
   * without activating the plugin, and they survive a plugin whose primary frame is
   * broken or unresponsive. Nothing a plugin does at runtime can add a contribution;
   * it can only drive the ones declared here (push status content, set a register).
   */
  #registerContributions(runtime) {
    const pid = runtime.id;
    const reg = this.platform.contributions;
    const keep = (dispose) => runtime.disposers.push(dispose);
    const label = displayName(runtime.manifest);

    for (const c of declaredContributions(runtime.manifest)) {
      const base = { ...c, pluginId: pid };
      switch (c.type) {
        // A viewer: `entry` names the module that renders it, in its own frame.
        // Skipped entirely if the user declined "provides viewers" at install.
        case 'opener':
          if (runtime.grants.includes('opener')) keep(reg.register(c.uri, base));
          break;

        // Declared, implemented by the plugin's primary frame. Addressed over RPC by the
        // contribution's short NAME — inside its own frame a plugin addresses its commands
        // by name, not by URI.
        case 'command':
          keep(this.platform.commands.register({
            id: c.uri, title: c.title || `${label}: ${c.name}`,
            category: c.category || label, icon: c.icon,
            when: c.when, offline: c.offline, palette: c.palette, pluginId: pid,
            // A description, like every other command. It used to be a closure over
            // `runtime` proxying straight to the channel, which left a plugin command
            // running invisible to the engine — the same hole ExecCommandAction closed for
            // the host's own commands, still open for everyone else's.
            actions: (...args) => new InvokePluginCommandAction(pid, c.name, args),
          }));
          break;

        // A slot in the status bar, empty and hidden until the plugin pushes content.
        // A CLICKABLE one is the plugin asking the host to run something — the same ask
        // a keyboard shortcut makes — so it goes through the same per-command grant.
        // Without this, a manifest holding only the `ui` capability could put an
        // inviting button in the status bar wired to `explorer.delete` or
        // `plugins.installFromUrl`, and the install review never mentioned the field.
        case 'statusItem': {
          const command = c.command
            ? this.#resolveCommand(runtime, c.command, label, `status item “${c.name}”`)
            : null;
          keep(reg.register(c.uri, { ...base, command, html: '', visible: false }));
          break;
        }

        // A context value slot. Seed the context with its declared default so
        // when-clauses referencing it evaluate sensibly before the plugin runs.
        case 'register':
          keep(reg.register(c.uri, base));
          this.platform.context.set(c.uri, c.default);
          keep(() => this.platform.context.remove(c.uri));
          break;

        // A keymap JSON file inside the package. Read + validated here, at register
        // time, so a malformed keymap is a visible install-time problem rather than a
        // shortcut that silently never fires.
        case 'keymap': {
          const bytes = runtime.files.get(c.path);
          if (!bytes) {
            this.platform.notifications.warn(`Plugin "${label}": keymap file "${c.path}" is not in the package.`);
            break;
          }
          try {
            const bindings = this.#resolveBindings(runtime, parseKeymap(new TextDecoder().decode(bytes)), label);
            keep(reg.register(c.uri, { ...base, bindings }));
          } catch (err) {
            this.platform.notifications.warn(`Plugin "${label}": ${err.message}`);
          }
          break;
        }

        // Indexers are deliberately NOT registered client-side. They run on the server
        // (PluginIndexers registers them from the install record), because indexing
        // must happen once per upload for the drive — not in whichever tab is open.
        case 'indexer':
          break;
      }
    }
  }

  /**
   * Resolve a keymap's bindings into real addresses, and refuse the ones the plugin
   * isn't allowed to trigger. A binding naming one of the plugin's own commands is
   * rewritten to that contribution's URI (inside its package a plugin knows only short
   * names); anything else is a foreign address and must be in the manifest's `commands`
   * allowlist — a shortcut is still the plugin asking the host to run something, so it
   * can't be a way around the per-command grant the user approved.
   */
  #resolveBindings(runtime, bindings, label) {
    const out = [];
    for (const b of bindings) {
      const command = this.#resolveCommand(runtime, b.command, label, `shortcut ${b.key}`);
      if (command) out.push({ ...b, command });
    }
    return out;
  }

  /**
   * One command address the plugin wants to be able to trigger, resolved and checked.
   *
   * A short name is one of the plugin's own commands and becomes its contribution URI.
   * Anything else is a FOREIGN address and must appear in the manifest's `commands`
   * allowlist. Returns null (with a warning naming `what`) when it isn't allowed, so
   * every route by which a plugin can ask the host to run something — keymaps, status
   * items — passes through the same grant the user actually approved.
   */
  #resolveCommand(runtime, wanted, label, what) {
    const uri = contribUri(runtime.manifest, wanted);
    const own = declaredContributions(runtime.manifest).some((c) => c.uri === uri && c.type === 'command');
    if (own) return uri;
    if (!canExecuteCommand(runtime.manifest, wanted)) {
      this.platform.notifications.warn(`Plugin "${label}": ${what} runs "${wanted}", which it isn't allowed to run — ignored.`);
      return null;
    }
    return wanted;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id, name: displayName(p.manifest), version: p.manifest.version, status: p.status,
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
    let declared;
    try { declared = declaredContributions(record.manifest); } catch { return []; }
    return declared.map((c) => ({
      kind: c.type, id: c.uri, name: c.name, title: c.title || c.name,
      offline: !!c.offline, available: this.#availableSpec(record, c),
    }));
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
    const id = pluginId(pkg.manifest);
    const requested = capabilityList(pkg.manifest);
    const granted = (grants || requested).filter((c) => ALL_CAPABILITIES.includes(c) && requested.includes(c));
    // Account-scoped plugins (server storage or a server indexer) upload their full
    // package to the server: it re-validates, gates admin-only packages, and becomes
    // the canonical copy so the plugin syncs to the user's other devices and its
    // capabilities are enforced server-side. Throws if the server rejects (e.g. admin
    // required) — surfaced to the user by the install UI. Device-scoped plugins stay local.
    const scope = accountScoped(pkg.manifest, granted) ? 'account' : 'device';
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
        this.platform.notifications.warn(`Couldn't restore plugin "${rec?.manifest ? displayName(rec.manifest) : rec?.id || 'unknown'}" — its saved data looks corrupt.`);
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
          // The SHARED domain scope comes from the server's install record, not from
          // the package's own manifest. The install path gates it on verified domain
          // ownership (`grantedStorageScopes` requires trust.status === 'verified') and
          // the review UI shows it as blocked; this sync path set `trust: null` and read
          // the self-declared manifest — so a package refused the shared store on the
          // device it was installed on got it on the next device that synced.
          storage: grants.includes('storage')
            ? { plugin: true, domain: !!rec.sharedStorage }
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
        schema.map((s) => ({ ...s, category: displayName(record.manifest) })),
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
      this.platform.notifications.error(`Plugin "${displayName(record.manifest)}" failed to load: ${runtime.error}`);
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
  /**
   * Run one of a plugin's own commands, in its frame.
   *
   * Public because `InvokePluginCommandAction` is what reaches it now, rather than a closure
   * captured at registration. Addressed by short NAME: the URI is the host's way of keeping
   * two plugins' `status` commands apart and means nothing on the other side.
   *
   * A plugin that is not running answers undefined rather than throwing. Its commands are
   * already filtered out of the palette by `isAvailable`, so getting here at all means a
   * stale reference, which is not worth an error.
   */
  invokeCommand(pluginId, name, args = []) {
    return this.plugins.get(pluginId)?.channel?.call('command:execute', { id: name, args });
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
    const opener = this.platform.contributions.get(openerId);
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
    const name = record?.manifest ? displayName(record.manifest) : pluginId;
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
    // The persisted record is what restore() reads: if this fails and we say nothing,
    // the plugin silently reappears on the next reload looking like a bug in uninstall.
    let resurrects = false;
    try {
      await this.registry.remove(pluginId);
    } catch (err) {
      resurrects = true;
      console.error('removing the persisted plugin record failed', pluginId, err);
    }
    if (![...this.plugins.values()].some((r) => r.status === 'active')) this.#stopHeartbeat();
    this.#emit();
    if (resurrects) {
      this.platform.notifications.error(`Removed "${name}", but its saved record couldn't be deleted — it may come back when you reload.`);
    } else if (wipeFailures.length) {
      this.platform.notifications.warn(`Uninstalled "${name}", but couldn't clear its ${wipeFailures.join(' and ')}.`);
    }
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
// footprint: server storage, or an indexer (which the SERVER runs). Purely
// client-side plugins stay device-local.
function accountScoped(manifest, granted) {
  if (granted.includes('storage')) return true;
  return serverIndexers(manifest).length > 0;
}

// A cheap fingerprint of a plugin's live self-report, used to tell whether a heartbeat
// changed anything worth re-rendering for.
function signature(live) {
  if (!live) return '';
  return `${live.online ? 1 : 0}|${[...(live.handlers || [])].sort().join(',')}`;
}

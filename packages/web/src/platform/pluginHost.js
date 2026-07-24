// PluginHost — installs and runs client-side plugin *packages* (zips). A plugin's
// code runs inside a sandboxed iframe on an OPAQUE origin (sandbox allow-scripts,
// no allow-same-origin): it can't touch the host DOM, can't read cookies/storage,
// and can't even fetch its own package files. The host injects our browser SDK +
// the plugin's entry script into the frame's srcdoc; everything else — package
// resources (as opaque byte handles), file access, settings, storage — flows over
// a single transferred MessagePort, capability-gated by what the user granted at
// install time.
//
// Plugins are persisted (PluginRegistry, IndexedDB) so they survive reloads, and
// re-announce a live capability manifest so the workbench knows what works right
// now (incl. offline). See pluginPackage.js / pluginSigning.js for install-time
// validation and the domain-verified trust signal.

import { RpcChannel } from '@trove/plugin-sdk/rpc.js';
import SDK_SOURCE from '@trove/plugin-sdk/browser.js' with { type: 'text' };
import { PluginRegistry } from './pluginStore.js';
import { ClientSqlProvider } from './pluginClientDb.js';
import { assessTrust } from './pluginSigning.js';
import { ADMIN_ONLY_CAPS, capabilityList, networkEndpoints, grantedStorageScopes } from './pluginPackage.js';
import { isAllowedUrl, endpointSummary } from './pluginNet.js';
import { buildModuleGraph, isModuleEntry, isSourceModule } from './pluginModules.js';

const ALL_CAPABILITIES = ['files', 'storage', 'ui', 'commands', 'indexer', 'opener', 'network', 'media', 'dock'];

// Response bodies larger than this are refused, so a plugin can't exhaust host
// memory through the brokered fetch.
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

export class PluginHost {
  constructor(platform, { heartbeatMs = 20000 } = {}) {
    this.platform = platform;
    this.plugins = new Map(); // id -> record
    this.registry = new PluginRegistry();
    this.clientDb = new ClientSqlProvider(); // on-device per-scope SQLite (wasm)
    this.online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.heartbeatMs = heartbeatMs;
    this._heartbeat = null;
    this._probing = false;
    this.subject = platform.reactive.ObservableSubject ? new platform.reactive.ObservableSubject([]) : null;
  }

  observe() {
    return this.subject;
  }
  #emit() {
    this.subject?.next(this.list());
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

  #featureList(record) {
    const live = record.live;
    if (!live) return [];
    const rows = [];
    const push = (kind, items) => { for (const it of items || []) rows.push({ kind, id: it.id, title: it.title || it.id, offline: !!it.offline, available: this.#availableSpec(record, it) }); };
    push('command', live.contributions?.commands);
    push('opener', live.contributions?.openers);
    push('indexer', live.contributions?.indexers);
    push('statusItem', live.contributions?.statusItems);
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
    // Storage scopes actually available: plugin if declared+granted; domain only if
    // declared, granted, AND the package is domain-verified.
    const storage = granted.includes('storage')
      ? grantedStorageScopes(pkg.manifest, trust)
      : { plugin: false, domain: false };
    const record = {
      id, manifest: pkg.manifest,
      files: Object.fromEntries([...pkg.files.entries()]),
      grants: granted, storage, trust: trust || null,
      settings: {}, secrets: {}, installedAt: Date.now(),
    };
    await this.registry.save(record);
    this.#registerSettings(record);
    await this.#run(record);
    return this.plugins.get(id);
  }

  /** Load all persisted plugins (call once at startup). */
  async restore() {
    let records = [];
    try {
      records = await this.registry.list();
    } catch { /* no IndexedDB */ }
    for (const rec of records) {
      this.#registerSettings(rec);
      this.#run(rec).catch((e) => console.error('restore plugin failed', rec.id, e));
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
    this.#emit();

    try {
      // The primary (background) frame: registers commands/indexers, does one-time
      // setup. Its channel is the record's channel used for probes and commands.
      const frame = await this.#spawnFrame(runtime, 'primary');
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

  /**
   * Create ONE sandboxed iframe wired with `record`'s granted capabilities, run the
   * handshake, and resolve to a live frame `{ role, iframe, channel, record }`. The
   * primary frame is the plugin's background instance; each viewer/panel gets its
   * own frame from this same helper (all share the record's caps + brokered APIs).
   */
  async #spawnFrame(record, role) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;';
    // Opaque-origin sandbox: scripts only, no same-origin, no top navigation.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    record._srcdoc ||= await buildSrcdoc(record.manifest, record.files);
    iframe.srcdoc = record._srcdoc;
    const frame = { role, iframe, channel: null, record, place: null, dock: null, docked: false, mediaOwner: false };
    document.body.appendChild(iframe);
    await this.#handshake(record, frame);
    return frame;
  }

  #handshake(record, frame) {
    return new Promise((resolve, reject) => {
      const { iframe } = frame;
      const manifest = record.manifest;
      const timer = setTimeout(() => reject(new Error('Plugin handshake timed out')), 15000);
      const onReady = (e) => {
        if (e.source !== iframe.contentWindow) return;
        if (e.data?.__trove === 'boot-error') {
          window.removeEventListener('message', onReady);
          clearTimeout(timer);
          return reject(new Error(e.data.error || 'Plugin failed to load its modules'));
        }
        if (e.data?.__trove !== 'ready') return;
        window.removeEventListener('message', onReady);
        const channel = new MessageChannel();
        frame.channel = new RpcChannel(channel.port1, {
          onCall: (m, p) => this.#hostCall(record, m, p, frame),
          onEvent: (m, p) => this.#hostEvent(record, m, p, frame),
        });
        frame.resolveActivated = resolve;
        frame.rejectActivated = reject;
        frame._timer = timer;
        // Opaque origin → target '*'; the transferred port is the real capability.
        iframe.contentWindow.postMessage(
          { __trove: 'init', manifest, capabilities: record.grants, storage: record.storage, online: this.online, role: frame.role },
          '*',
          [channel.port2],
        );
      };
      window.addEventListener('message', onReady);
      iframe.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Failed to load plugin iframe')); });
    });
  }

  // --- plugin → host RPC -----------------------------------------------------

  async #hostCall(record, method, params, frame) {
    const cap = (c) => { if (!record.grants.includes(c)) throw new Error(`Capability "${c}" not granted`); };
    const pid = record.manifest.id;
    // Contributions are owned by the primary (background) frame. A viewer frame
    // re-runs the plugin's activate() too, but its contribution calls are no-ops on
    // the host — the primary already registered them (and its handlers route to it).
    const primary = !frame || frame.role === 'primary';
    switch (method) {
      case 'activated': {
        const f = frame || record.frame;
        clearTimeout(f?._timer);
        if (params.ok) f?.resolveActivated?.(f);
        else f?.rejectActivated?.(new Error(params.error || 'activate() failed'));
        return { ok: true };
      }

      case 'contribute:command': {
        if (!primary) return { ok: true };
        const dispose = this.platform.commands.register({
          id: params.id, title: params.title || `${record.manifest.name}: ${params.id}`,
          category: params.category || record.manifest.name, icon: params.icon,
          offline: !!params.offline, pluginId: pid,
          handler: (...args) => record.channel.call('command:execute', { id: params.id, args }),
        });
        record.disposers.push(dispose);
        return { ok: true };
      }
      case 'contribute:opener': {
        cap('opener');
        if (!primary) return { ok: true };
        const dispose = this.platform.contributions.openers.register({
          ...params, pluginId: pid,
          open: (file, context) => record.channel.call('opener:open', { openerId: params.id, file, context }),
        });
        record.disposers.push(dispose);
        return { ok: true };
      }
      case 'contribute:indexer': {
        cap('indexer');
        if (!primary) return { ok: true };
        record.disposers.push(this.platform.contributions.indexers.register({ ...params, pluginId: pid }));
        return { ok: true };
      }
      case 'contribute:statusItem':
        if (!primary) return { ok: true };
        record.disposers.push(this.platform.contributions.statusItems.register({ ...params, pluginId: pid }));
        return { ok: true };
      case 'contribute:keybinding':
        if (!primary) return { ok: true };
        record.disposers.push(this.platform.contributions.keybindings.register(params));
        return { ok: true };

      // Package resources — opaque byte handles (transferred, no host URLs). Code
      // under src/ and the manifest are not resources (src/ is loaded as modules).
      case 'resources:list':
        return [...record.files.keys()].filter(isResourcePath);
      case 'resources:read': {
        if (!isResourcePath(params.path)) throw new Error(`No such resource ${params.path}`);
        const bytes = record.files.get(params.path);
        if (!bytes) throw new Error(`No such resource ${params.path}`);
        return { bytes: bytes.slice().buffer }; // copied into the iframe by structured clone
      }

      // Files — inherit the host's authenticated API client.
      case 'files:read': return cap('files'), { text: await this.platform.api.readText(params.id) };
      case 'files:list': return cap('files'), this.platform.api.list(params.pathOrId, params);
      case 'files:stat': return cap('files'), this.platform.api.stat(params.id);
      case 'files:downloadUrl': return cap('files'), { url: this.platform.api.downloadUrl(params.id) };
      case 'files:index': {
        cap('indexer');
        const ns = params.indexerId?.startsWith(pid) ? params.indexerId : `${pid}.${params.indexerId || 'default'}`;
        return this.platform.api.pushIndex(ns, params.nodeId, params.documents, params.facet);
      }

      // Network — brokered by the host and confined to declared endpoints. The
      // sandboxed frame has no direct network at all (connect-src 'none').
      case 'net:fetch': cap('network'); return this.#brokerFetch(record, params);

      // Persistent storage — an isolated SQLite database per scope (plugin/domain),
      // on the server or (client, Stage 3) on-device. SQL runs only against the
      // plugin's own scoped db.
      case 'storage:sql': cap('storage'); return this.#pluginSql(record, params);

      // Plugin settings + secrets.
      case 'settings:get': return this.platform.settings.get(`${pid}.${params.key}`);
      case 'settings:getSecret': return record.secrets?.[params.key] ?? null;
      case 'settings:set':
        this.platform.settings.set(`${pid}.${params.key}`, params.value);
        return { ok: true };

      case 'ui:showPanel':
        record.hasUi = true;
        this.platform.openPluginPanel?.(pid);
        this.#emit();
        return { ok: true };

      // Media session — the host owns navigator.mediaSession; the calling frame
      // (a viewer) surfaces its playback so the OS shows transport controls. Actions
      // fire back over that same frame's RPC channel.
      case 'media:metadata': cap('media'); return this.#media(frame, 'metadata', params);
      case 'media:playbackState': cap('media'); return this.#media(frame, 'playbackState', params);
      case 'media:position': cap('media'); return this.#media(frame, 'position', params);
      case 'media:action': cap('media'); return this.#media(frame, 'action', params);
      case 'media:clear': return this.#media(frame, 'clear', params);

      // Dock — the calling frame registers/unregisters itself for the floating dock.
      case 'dock:enable': cap('dock'); if (frame) frame.dock = { enabled: true, minSize: params.minSize, maxSize: params.maxSize, dismissed: false }; return { ok: true };
      case 'dock:disable': cap('dock'); if (frame?.dock) frame.dock.enabled = false; if (frame && this._dockedFrame === frame) this.#closeDock(frame); return { ok: true };
      case 'dock:close': if (frame) this.#closeDock(frame); return { ok: true };

      default:
        throw new Error(`Unknown host method ${method}`);
    }
  }

  // Bridge a frame's playback to navigator.mediaSession. The last frame to touch it
  // becomes the media owner; OS actions fire back over that frame's own channel.
  #media(frame, kind, params) {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;
    if (!ms) return { ok: false };
    if (frame && kind !== 'clear') { this._mediaOwner = frame; frame.mediaOwner = true; }
    try {
      if (kind === 'metadata') {
        ms.metadata = typeof MediaMetadata !== 'undefined'
          ? new MediaMetadata({ title: params.title || '', artist: params.artist || '', album: params.album || '', artwork: params.artwork || [] })
          : ms.metadata;
      } else if (kind === 'playbackState') {
        ms.playbackState = params.state || 'none';
      } else if (kind === 'position' && ms.setPositionState) {
        ms.setPositionState({ duration: params.duration || 0, position: params.position || 0, playbackRate: params.playbackRate || 1 });
      } else if (kind === 'action') {
        ms.setActionHandler?.(params.action, params.on ? () => frame?.channel?.emit('media:action', { action: params.action }) : null);
      } else if (kind === 'clear') {
        if (frame && this._mediaOwner && this._mediaOwner !== frame) return { ok: true }; // don't clear someone else's session
        ms.metadata = null;
        ms.playbackState = 'none';
        this._mediaOwner = null;
      }
    } catch { /* unsupported action/state */ }
    return { ok: true };
  }

  // Plugin storage: run a SQL op against one scoped, isolated database. `scope` is
  // 'plugin' or 'domain' (each granted separately); `side` is 'server' or 'client'.
  async #pluginSql(record, { scope = 'plugin', side = 'server', op, sql, params = [], statements }) {
    if (!record.storage?.[scope]) {
      throw new Error(`Storage scope "${scope}" not granted${scope === 'domain' ? ' (needs a verified domain)' : ''}`);
    }
    if (side === 'client') {
      // On-device: an isolated wasm SQLite db per scope, held by the host. Domain
      // scope keys by the verified domain so a vendor's plugins share it.
      const key = scope === 'domain' ? `dom:${record.manifest.domain}` : `plg:${record.manifest.id}`;
      const db = await this.clientDb.obtain(key);
      return runSqlOp(db, op, sql, params, statements);
    }
    // Server: the host proxies to the scoped db over the authenticated API; the
    // domain (for the shared scope) comes from the verified install record, never
    // the plugin.
    const body = { scope, op, sql, params, statements, domain: scope === 'domain' ? record.manifest.domain : undefined };
    const res = await this.platform.api.request('POST', `/api/plugins/${encodeURIComponent(record.manifest.id)}/sql`, { body });
    return res.result;
  }

  /**
   * Perform a network request on a plugin's behalf, but only to a URL it declared
   * in its manifest `network` allowlist. The request runs from the host with
   * credentials omitted (no ambient cookies/auth), and any redirect that lands
   * off the allowlist is rejected. Returns { ok, status, statusText, url, headers,
   * bytes } — the SDK wraps it in a Response-like object.
   */
  async #brokerFetch(record, { url, method = 'GET', headers, body }) {
    const allow = networkEndpoints(record.manifest);
    if (!isAllowedUrl(allow, url)) {
      throw new Error(`Blocked: "${url}" is not one of this plugin's declared network endpoints`);
    }
    const init = { method, credentials: 'omit', redirect: 'follow', headers: sanitizeHeaders(headers) };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      init.body = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    }
    const res = await fetch(url, init);
    // A redirect chain must not escape the declared endpoints.
    if (res.url && res.url !== url && !isAllowedUrl(allow, res.url)) {
      throw new Error(`Blocked: request redirected off this plugin's declared endpoints (${res.url})`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_BYTES) throw new Error('Response too large');
    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, headers: outHeaders, bytes: buf };
  }

  #hostEvent(record, method, params, frame) {
    const pid = record.manifest.id;
    switch (method) {
      case 'manifest':
        // Only the primary frame's manifest defines the plugin's live feature list;
        // a viewer frame re-announces its own (opener-only) manifest — ignore it.
        if (frame && frame.role !== 'primary') break;
        record.live = params; record.responsive = true; record.lastManifestAt = Date.now();
        this.#emit();
        break;
      case 'ui:toast':
        this.platform.notifications[params.level || 'info'](`${record.manifest.name}: ${params.text}`);
        break;
      case 'ui:badge':
        record.badge = params.text; this.#emit();
        break;
      case 'context:set':
        this.platform.context.scopedFor(pid).set(params.key, params.value);
        break;
    }
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

  // --- heartbeat / availability (unchanged behaviour) ------------------------

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

  // --- panel / viewer / dock -------------------------------------------------
  //
  // A frame's iframe is created once (#spawnFrame) and stays a child of <body> for
  // its life — we NEVER re-parent it, because moving an <iframe> in the DOM reloads
  // its document (per the HTML spec) and would kill the running plugin + MessagePort.
  // To show a frame "inside" a panel/viewer/dock we float it as a position:fixed
  // overlay whose inset tracks the target element's box (see #place).

  mountPanel(pluginId, container, { width = 380, height = 480 } = {}) {
    const record = this.plugins.get(pluginId);
    if (!record?.frame) return null;
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    this.#place(record.frame, container, 50);
    record.hasUi = true;
    return () => this.#hide(record.frame);
  }

  /**
   * Mount a plugin opener as the viewer for `node`. Each viewer runs in its OWN
   * sandboxed iframe (spawned with the plugin's capabilities), so viewers are
   * isolated from the background instance and from each other. Returns a detach fn:
   * if the viewer registered `dock`, its frame is kept alive as a floating dock,
   * otherwise it is destroyed.
   */
  mountViewer(pluginId, container, node, openerId) {
    const record = this.plugins.get(pluginId);
    if (!record) return null;

    // Re-adopt the docked frame if it's the same file — preserves live playback
    // (the docked <video>/<audio> keeps running) instead of spawning a fresh viewer.
    const docked = this._dockedFrame;
    if (docked && docked.record === record && docked.node?.id === node.id && docked.openerId === openerId) {
      this.#undock(docked);
      this.#place(docked, container, 3);
      return () => this.#detachViewer(docked);
    }

    const mount = { cancelled: false, frame: null };
    this.#spawnFrame(record, 'viewer').then((frame) => {
      if (mount.cancelled) { this.#destroyFrame(frame); return; }
      mount.frame = frame;
      frame.node = node;
      frame.openerId = openerId;
      record.frames.add(frame);
      this.#place(frame, container, 3);
      frame.channel?.call('opener:open', { openerId, file: node, context: {} }).catch(() => {});
    }).catch((e) => console.error('viewer frame failed to load', e));
    record.hasUi = true;

    return () => {
      mount.cancelled = true;
      if (mount.frame) this.#detachViewer(mount.frame);
    };
  }

  // A viewer went off-screen: dock it (if it opted in and isn't dismissed) or destroy it.
  #detachViewer(frame) {
    if (frame.dock?.enabled && !frame.dock.dismissed) this.#dock(frame);
    else this.#destroyFrame(frame);
  }

  // Float `frame`'s iframe over `targetEl` and keep its inset aligned. We recompute
  // on intersection/resize/scroll rather than every animation frame — the app's
  // viewer area only moves on layout changes, so this stays idle when nothing shifts.
  #place(frame, targetEl, z) {
    this.#stopPlace(frame);
    const f = frame.iframe;
    f.style.cssText = `position:fixed;border:0;visibility:visible;display:block;background:transparent;z-index:${z};margin:0;padding:0;`;
    const sync = () => {
      const r = targetEl.getBoundingClientRect();
      const shown = r.width > 0 && r.height > 0 && document.contains(targetEl);
      f.style.left = `${r.left}px`;
      f.style.top = `${r.top}px`;
      f.style.width = `${r.width}px`;
      f.style.height = `${r.height}px`;
      f.style.visibility = shown ? 'visible' : 'hidden';
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(targetEl);
    if (document.body) ro?.observe(document.body);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(sync, { threshold: [0, 1] }) : null;
    io?.observe(targetEl);
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    frame.place = {
      target: targetEl,
      stop: () => {
        ro?.disconnect();
        io?.disconnect();
        window.removeEventListener('scroll', sync, true);
        window.removeEventListener('resize', sync);
      },
    };
  }
  #stopPlace(frame) {
    if (frame.place) { frame.place.stop(); frame.place = null; }
  }
  #hide(frame) {
    this.#stopPlace(frame);
    frame.iframe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;';
  }

  // Tear a frame down for good: stop tracking it, drop the media session if it owned
  // it, close its RPC channel, and remove the iframe from the DOM.
  #destroyFrame(frame) {
    if (!frame) return;
    this.#stopPlace(frame);
    if (this._dockedFrame === frame) { this._dockedFrame = null; if (this._dockEl_) this._dockEl_.style.display = 'none'; }
    if (this._mediaOwner === frame) this.#media(frame, 'clear', {});
    try { frame.channel?.emit('deactivate'); } catch { /* ignore */ }
    try { frame.channel?.dispose(); } catch { /* ignore */ }
    frame.iframe.remove();
    frame.record?.frames?.delete(frame);
  }

  // Float a viewer frame as the single floating dock (transparent), sized by the
  // viewer's declared min constraints. Click the header to reopen; × to dismiss.
  #dock(frame) {
    if (this._dockedFrame && this._dockedFrame !== frame) this.#closeDock(this._dockedFrame);
    const min = frame.dock?.minSize || { width: 300, height: 90 };
    const el = this.#dockEl();
    el.style.width = `${clampDim(min.width, 200, 480)}px`;
    el.style.height = `${clampDim(min.height, 56, 360) + 26}px`; // + header
    el.querySelector('.vd-title').textContent = frame.node?.name || frame.record.manifest.name;
    el.style.display = 'flex';
    this.#place(frame, el.querySelector('.vd-body'), 61);
    this._dockedFrame = frame;
    frame.docked = true;
    frame.channel?.emit('dock:state', { docked: true });
    this.#emit();
  }

  // Un-dock without destroying — used when a docked frame is re-adopted into a viewer.
  #undock(frame) {
    if (this._dockEl_) this._dockEl_.style.display = 'none';
    if (this._dockedFrame === frame) this._dockedFrame = null;
    frame.docked = false;
    frame.channel?.emit('dock:state', { docked: false });
  }

  // Dismiss the dock: the user closed it, or the viewer disabled docking. The frame
  // is done, so tear it down.
  #closeDock(frame) {
    if (this._dockEl_) this._dockEl_.style.display = 'none';
    if (this._dockedFrame === frame) this._dockedFrame = null;
    frame.docked = false;
    frame.channel?.emit('dock:state', { docked: false, closed: true });
    this.#destroyFrame(frame);
    this.#emit();
  }

  #dockEl() {
    if (this._dockEl_) return this._dockEl_;
    const el = document.createElement('div');
    el.className = 'viewer-dock';
    el.innerHTML = '<div class="vd-bar"><span class="vd-title"></span><button class="vd-expand" title="Reopen">↗</button><button class="vd-close" title="Close">✕</button></div><div class="vd-body"></div>';
    el.querySelector('.vd-expand').addEventListener('click', () => {
      const frame = this._dockedFrame;
      if (frame?.node) this.platform.workbench.openFile(frame.node, frame.openerId);
    });
    el.querySelector('.vd-close').addEventListener('click', () => {
      if (this._dockedFrame) this.#closeDock(this._dockedFrame);
    });
    document.body.appendChild(el);
    this._dockEl_ = el;
    return el;
  }

  /** Uninstall: stop the plugin, forget it, and wipe everything it owns. */
  async uninstall(pluginId, { wipeData = true } = {}) {
    const record = this.plugins.get(pluginId);
    if (record) {
      try { record.channel?.emit('deactivate'); } catch { /* ignore */ }
      for (const d of record.disposers) { try { d(); } catch { /* ignore */ } }
      record._settingsDispose?.();
      for (const frame of [...(record.frames || [])]) this.#destroyFrame(frame); // viewer/dock frames
      record.channel?.dispose();
      record.iframe?.remove();
      this.plugins.delete(pluginId);
    }
    if (wipeData) {
      // Wipe the plugin's private stores (server + on-device). Its domain scope, if
      // any, is shared with the vendor's other plugins and left intact.
      await this.platform.api.request('DELETE', `/api/plugins/${encodeURIComponent(pluginId)}/data`).catch(() => {});
      await this.clientDb.drop(`plg:${pluginId}`).catch(() => {});
    }
    await this.registry.remove(pluginId);
    if (![...this.plugins.values()].some((r) => r.status === 'active')) this.#stopHeartbeat();
    this.#emit();
  }

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

/** True for files a plugin can read as opaque resources (not code, not manifest). */
function isResourcePath(path) {
  return path !== 'manifest.json' && !isSourceModule(path);
}

// The frame's CSP. `connect-src 'none'` means it cannot make ANY direct network
// request (fetch/XHR/WebSocket/beacon) — all web access is brokered by the host and
// confined to the plugin's declared endpoints. img/media/font are limited to
// in-frame blob:/data: so remote loads can't be an exfiltration side-channel.
// `blob:` in script-src is only for the plugin's own package modules (below), which
// are same-origin blobs — no external code can load.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob: data:',
  "font-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>`;

/** Build the iframe document — classic single-file, or ESM module mode (src/). */
async function buildSrcdoc(manifest, files) {
  if (isModuleEntry(manifest)) return moduleBootstrapHtml(await buildModuleGraph({ manifest, files }));
  const entryJs = new TextDecoder().decode(files.get(manifest.entry) ?? new Uint8Array());
  return `${HEAD}
<script>${SDK_SOURCE}<\/script>
<script>${entryJs}<\/script>
</body></html>`;
}

// Escape a value for safe inlining inside <script> (so `</script>` and JS line
// separators in package code can't break out of the tag).
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ESM module mode: ship every src/ module as a blob: URL and wire them with an
// import map keyed by canonical `trove:/<path>` specifiers (the specifiers in the
// code were rewritten to match). `trove` resolves to a shim over the injected SDK.
function moduleBootstrapHtml(graph) {
  const entryKey = safeJson('trove:/' + graph.entry);
  return `${HEAD}
<script>${SDK_SOURCE}<\/script>
<script id="__trove_src" type="application/json">${safeJson(graph.modules)}<\/script>
<script>
(function () {
  var src = JSON.parse(document.getElementById('__trove_src').textContent);
  var imports = {};
  for (var p in src) imports['trove:/' + p] = URL.createObjectURL(new Blob([src[p] + '\\n//# sourceURL=trove:/' + p], { type: 'text/javascript' }));
  imports['trove'] = URL.createObjectURL(new Blob(['export const activate = globalThis.trove.activate;\\nexport default globalThis.trove;'], { type: 'text/javascript' }));
  var im = document.createElement('script');
  im.type = 'importmap';
  im.textContent = JSON.stringify({ imports: imports });
  document.head.appendChild(im);
  import(${entryKey}).catch(function (e) {
    try { parent.postMessage({ __trove: 'boot-error', error: String((e && e.message) || e) }, '*'); } catch (_) {}
  });
})();
<\/script>
</body></html>`;
}

// Drop headers the plugin isn't allowed to set (the browser forbids most of these
// anyway; we strip explicitly so intent is clear and cookies never ride along).
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'cookie2', 'set-cookie', 'origin', 'referer', 'content-length', 'connection']);
function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!FORBIDDEN_HEADERS.has(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

// Dispatch one SQL op onto a SqliteDatabase-shaped handle (the client store; the
// server mirrors this in routes.js).
function runSqlOp(db, op, sql, params = [], statements) {
  switch (op) {
    case 'exec': return db.exec(sql);
    case 'run': return db.run(sql, ...params);
    case 'get': return db.get(sql, ...params);
    case 'all': return db.all(sql, ...params);
    case 'batch': return db.batch(statements);
    default: throw new Error(`Unknown storage op "${op}"`);
  }
}

// Clamp a viewer-declared dock dimension into a sane host range (defaulting to the
// low bound when the viewer gives nothing).
function clampDim(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v || lo));
}

function signature(live) {
  if (!live) return '';
  const c = live.contributions || {};
  const flat = ['commands', 'openers', 'indexers', 'statusItems'].flatMap((k) => (c[k] || []).map((x) => `${k}:${x.id}:${x.offline ? 1 : 0}`));
  return `${live.online ? 1 : 0}|${flat.sort().join(',')}`;
}

export { ALL_CAPABILITIES };

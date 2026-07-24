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
import SDK_SOURCE from '@trove/plugin-sdk/browser.js?raw';
import { PluginRegistry, PluginDataStore } from './pluginStore.js';
import { assessTrust } from './pluginSigning.js';
import { ADMIN_ONLY_CAPS } from './pluginPackage.js';
import { isAllowedUrl } from './pluginNet.js';
import { buildModuleGraph, isModuleEntry, isSourceModule } from './pluginModules.js';

const ALL_CAPABILITIES = ['files', 'storage', 'serverStorage', 'ui', 'commands', 'indexer', 'opener', 'network'];

// Response bodies larger than this are refused, so a plugin can't exhaust host
// memory through the brokered fetch.
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

export class PluginHost {
  constructor(platform, { heartbeatMs = 20000 } = {}) {
    this.platform = platform;
    this.plugins = new Map(); // id -> record
    this.registry = new PluginRegistry();
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
      endpoints: p.manifest.network || [],
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
    const requested = pkg.manifest.capabilities || [];
    const granted = (grants || requested).filter((c) => ALL_CAPABILITIES.includes(c) && requested.includes(c));
    const record = {
      id, manifest: pkg.manifest,
      files: Object.fromEntries([...pkg.files.entries()]),
      grants: granted, trust: trust || null,
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

  // --- run (create the sandboxed iframe) -------------------------------------

  async #run(record) {
    if (this.plugins.get(record.id)?.status === 'active') return;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
    // Opaque-origin sandbox: scripts only, no same-origin, no top navigation.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.srcdoc = await buildSrcdoc(record.manifest, mapFromFiles(record.files));

    const runtime = {
      ...record, iframe, status: 'loading', error: null, disposers: [], channel: null,
      hasUi: false, responsive: false, data: new PluginDataStore(record.id),
      files: mapFromFiles(record.files),
    };
    this.plugins.set(record.id, runtime);
    this.#emit();
    document.body.appendChild(iframe);

    try {
      await this.#handshake(runtime);
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

  #handshake(record) {
    return new Promise((resolve, reject) => {
      const { iframe, manifest } = record;
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
        record.channel = new RpcChannel(channel.port1, {
          onCall: (m, p) => this.#hostCall(record, m, p),
          onEvent: (m, p) => this.#hostEvent(record, m, p),
        });
        record.resolveActivated = resolve;
        record.rejectActivated = reject;
        record._timer = timer;
        // Opaque origin → target '*'; the transferred port is the real capability.
        iframe.contentWindow.postMessage(
          { __trove: 'init', manifest, capabilities: record.grants, online: this.online },
          '*',
          [channel.port2],
        );
      };
      window.addEventListener('message', onReady);
      iframe.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Failed to load plugin iframe')); });
    });
  }

  // --- plugin → host RPC -----------------------------------------------------

  async #hostCall(record, method, params) {
    const cap = (c) => { if (!record.grants.includes(c)) throw new Error(`Capability "${c}" not granted`); };
    const pid = record.manifest.id;
    switch (method) {
      case 'activated':
        clearTimeout(record._timer);
        if (params.ok) record.resolveActivated?.(record);
        else record.rejectActivated?.(new Error(params.error || 'activate() failed'));
        return { ok: true };

      case 'contribute:command': {
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
        const dispose = this.platform.contributions.openers.register({
          ...params, pluginId: pid,
          open: (file, context) => record.channel.call('opener:open', { openerId: params.id, file, context }),
        });
        record.disposers.push(dispose);
        return { ok: true };
      }
      case 'contribute:indexer': {
        cap('indexer');
        record.disposers.push(this.platform.contributions.indexers.register({ ...params, pluginId: pid }));
        return { ok: true };
      }
      case 'contribute:statusItem':
        record.disposers.push(this.platform.contributions.statusItems.register({ ...params, pluginId: pid }));
        return { ok: true };
      case 'contribute:keybinding':
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

      // Persistent storage — local (default) or server (needs serverStorage).
      case 'db:get': cap('storage'); return this.#data(record, params.scope).get(params.key);
      case 'db:set': cap('storage'); return this.#data(record, params.scope).set(params.key, params.value);
      case 'db:delete': cap('storage'); return this.#data(record, params.scope).delete(params.key);
      case 'db:query': cap('storage'); return this.#data(record, params.scope).query(params.prefix);

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
      default:
        throw new Error(`Unknown host method ${method}`);
    }
  }

  #data(record, scope) {
    if (scope === 'server') {
      if (!record.grants.includes('serverStorage')) throw new Error('serverStorage not granted');
      return serverData(this.platform.api, record.manifest.id);
    }
    return record.data;
  }

  /**
   * Perform a network request on a plugin's behalf, but only to a URL it declared
   * in its manifest `network` allowlist. The request runs from the host with
   * credentials omitted (no ambient cookies/auth), and any redirect that lands
   * off the allowlist is rejected. Returns { ok, status, statusText, url, headers,
   * bytes } — the SDK wraps it in a Response-like object.
   */
  async #brokerFetch(record, { url, method = 'GET', headers, body }) {
    const allow = record.manifest.network || [];
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

  #hostEvent(record, method, params) {
    const pid = record.manifest.id;
    switch (method) {
      case 'manifest':
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
      await this.#probe(r);
    }));
    this.#emit();
  }
  async refresh(pluginId) {
    const record = this.plugins.get(pluginId);
    if (record) { await this.#probe(record); this.#emit(); }
  }

  // --- panel / uninstall -----------------------------------------------------

  mountPanel(pluginId, container, { width = 380, height = 480 } = {}) {
    const record = this.plugins.get(pluginId);
    if (!record) return null;
    const f = record.iframe;
    f.style.cssText = `width:${width}px;height:${height}px;border:0;visibility:visible;display:block;`;
    container.appendChild(f);
    record.hasUi = true;
    return () => {
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
      document.body.appendChild(f);
    };
  }

  /** Uninstall: stop the plugin, forget it, and wipe everything it owns. */
  async uninstall(pluginId, { wipeData = true } = {}) {
    const record = this.plugins.get(pluginId);
    if (record) {
      try { record.channel?.emit('deactivate'); } catch { /* ignore */ }
      for (const d of record.disposers) { try { d(); } catch { /* ignore */ } }
      record._settingsDispose?.();
      record.channel?.dispose();
      record.iframe.remove();
      if (wipeData) await record.data?.destroy().catch(() => {});
      this.plugins.delete(pluginId);
    }
    if (wipeData) {
      // Server-side plugin data (ownership tracked by plugin id).
      await this.platform.api.request('DELETE', `/api/plugins/${encodeURIComponent(pluginId)}/data`).catch(() => {});
      await new PluginDataStore(pluginId).destroy().catch(() => {});
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

// Server-backed per-plugin storage (mirrors the local PluginDataStore shape).
function serverData(api, pluginId) {
  const base = `/api/plugins/${encodeURIComponent(pluginId)}/data`;
  return {
    get: (key) => api.request('GET', base + '/' + encodeURIComponent(key)).then((r) => r?.value ?? null),
    set: (key, value) => api.request('PUT', base + '/' + encodeURIComponent(key), { body: { value } }),
    delete: (key) => api.request('DELETE', base + '/' + encodeURIComponent(key)),
    query: (prefix) => api.request('GET', base, { query: { prefix: prefix || '' } }).then((r) => r?.items || []),
  };
}

function signature(live) {
  if (!live) return '';
  const c = live.contributions || {};
  const flat = ['commands', 'openers', 'indexers', 'statusItems'].flatMap((k) => (c[k] || []).map((x) => `${k}:${x.id}:${x.offline ? 1 : 0}`));
  return `${live.online ? 1 : 0}|${flat.sort().join(',')}`;
}

export { ALL_CAPABILITIES };

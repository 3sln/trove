// PluginRpcRouter — the trusted boundary: every call a sandboxed plugin makes into
// the host lands here, is capability-gated against what the user granted at install
// time, and is then serviced against host APIs the plugin can never reach directly.
//
// The frame has NO ambient authority: no host DOM, no cookies, no network
// (connect-src 'none'), no access to its own package bytes. Everything it can do is
// one of the methods below, and each one that touches something sensitive calls
// `cap(...)` first. Extracted from PluginHost so the allow/deny logic is one focused
// unit rather than sharing a class with iframe lifecycle and DOM placement.

import { networkEndpoints, canExecuteCommand } from './pluginPackage.js';
import { isAllowedUrl } from './pluginNet.js';
import { isSourceModule } from './pluginModules.js';

// Response bodies larger than this are refused, so a plugin can't exhaust host
// memory through the brokered fetch.
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

export class PluginRpcRouter {
  /**
   * @param {object} deps
   * @param {object} deps.platform  host services (api, commands, contributions, settings, …)
   * @param {object} deps.clientDb  on-device scoped SQLite provider
   * @param {import('./pluginMedia.js').MediaController} deps.media
   * @param {import('./pluginDock.js').FrameDock} deps.dock
   * @param {()=>void} deps.onChange  notify listeners that plugin state changed
   */
  constructor({ platform, clientDb, media, dock, onChange } = {}) {
    this.platform = platform;
    this.clientDb = clientDb;
    this.media = media;
    this.dock = dock;
    this.onChange = onChange || (() => {});
  }

  // --- plugin → host RPC (calls: awaited, may return a value) -----------------

  async hostCall(record, method, params, frame) {
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

      // Run a host command by id (the SDK's ctx.commands.execute). Gated per COMMAND,
      // not per capability: the plugin's manifest lists exactly which command ids it
      // may run (plus its own, implicitly). A blanket "commands" grant would let a
      // plugin that wanted `workbench.view.home` also call `explorer.delete`.
      case 'command:execute': {
        const owner = this.platform.contributions.commands.get(params.id)?.pluginId;
        if (!canExecuteCommand(record.manifest, params.id, owner)) {
          throw new Error(`Command "${params.id}" is not in this plugin's declared commands`);
        }
        const result = await this.platform.commands.execute(params.id, ...(params.args || []));
        return { ok: true, result: result ?? null };
      }
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
        return this.platform.api.pushIndex(ns, params.nodeId, {
          semanticTexts: params.semanticTexts, tags: params.tags, metadata: params.metadata,
          documents: params.documents, facet: params.facet, // legacy
        });
      }

      // Network — brokered by the host and confined to declared endpoints. The
      // sandboxed frame has no direct network at all (connect-src 'none').
      case 'net:fetch': cap('network'); return this.#brokerFetch(record, params);

      // Persistent storage — an isolated SQLite database per scope (plugin/domain),
      // on the server or on-device. SQL runs only against the plugin's own scoped db.
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
        this.onChange();
        return { ok: true };

      // Media session — the host owns navigator.mediaSession; the calling frame
      // (a viewer) surfaces its playback so the OS shows transport controls. Actions
      // fire back over that same frame's RPC channel.
      case 'media:metadata': cap('media'); return this.media.apply(frame, 'metadata', params);
      case 'media:playbackState': cap('media'); return this.media.apply(frame, 'playbackState', params);
      case 'media:position': cap('media'); return this.media.apply(frame, 'position', params);
      case 'media:action': cap('media'); return this.media.apply(frame, 'action', params);
      case 'media:clear': return this.media.apply(frame, 'clear', params);

      // Dock — the calling frame registers/unregisters itself for the floating dock.
      case 'dock:enable': cap('dock'); if (frame) frame.dock = { enabled: true, minSize: params.minSize, maxSize: params.maxSize, dismissed: false }; return { ok: true };
      case 'dock:disable': cap('dock'); if (frame?.dock) frame.dock.enabled = false; if (frame && this.dock.docked === frame) this.dock.closeDock(frame); return { ok: true };
      case 'dock:close': if (frame) this.dock.closeDock(frame); return { ok: true };

      default:
        throw new Error(`Unknown host method ${method}`);
    }
  }

  // --- plugin → host events (fire-and-forget) --------------------------------

  hostEvent(record, method, params, frame) {
    const pid = record.manifest.id;
    switch (method) {
      case 'manifest':
        // Only the primary frame's manifest defines the plugin's live feature list;
        // a viewer frame re-announces its own (opener-only) manifest — ignore it.
        if (frame && frame.role !== 'primary') break;
        record.live = params; record.responsive = true; record.lastManifestAt = Date.now();
        this.onChange();
        break;
      case 'ui:toast':
        this.platform.notifications[params.level || 'info'](`${record.manifest.name}: ${params.text}`);
        break;
      case 'ui:badge':
        record.badge = params.text; this.onChange();
        break;
      case 'context:set':
        this.platform.context.scopedFor(pid).set(params.key, params.value);
        break;
    }
  }

  // --- brokered capabilities -------------------------------------------------

  /**
   * Perform a network request on a plugin's behalf, but only to a URL it declared
   * in its manifest `network` allowlist. The request runs from the host with
   * credentials omitted (no ambient cookies/auth), and any redirect that lands
   * off the allowlist is rejected.
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

  /**
   * Plugin storage: run a SQL op against one scoped, isolated database. `scope` is
   * 'plugin' or 'domain' (each granted separately); `side` is 'server' or 'client'.
   */
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
}

/** True for files a plugin can read as opaque resources (not code, not manifest). */
function isResourcePath(path) {
  return path !== 'manifest.json' && !isSourceModule(path);
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

// PluginRpcRouter — the trusted boundary: every call a sandboxed plugin makes into
// the host lands here, is capability-gated against what the user granted at install
// time, and is then serviced against host APIs the plugin can never reach directly.
//
// The frame has NO ambient authority: no host DOM, no cookies, no network
// (connect-src 'none'), no access to its own package bytes. Everything it can do is
// one of the methods below, and each one that touches something sensitive calls
// `cap(...)` first. Extracted from PluginHost so the allow/deny logic is one focused
// unit rather than sharing a class with iframe lifecycle and DOM placement.

import { networkEndpoints, canExecuteCommand, displayName } from './pluginPackage.js';
import { isAllowedUrl } from './pluginNet.js';
import { isSourceModule } from './pluginModules.js';
import { contribUri, parseContribUri } from '@trove/core/plugins/identity.js';
import { assertSafePluginSql } from '@trove/core/plugins/sql.js';

// Response bodies larger than this are refused, so a plugin can't exhaust host
// memory through the brokered fetch.
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

/**
 * Read a response body, aborting the moment it exceeds `max`.
 *
 * `await res.arrayBuffer()` then checking `.byteLength` does not achieve the thing the
 * cap exists for: by the time the check runs the whole body is already resident, so a
 * declared endpoint returning a multi-GB stream OOMs the tab before we ever refuse it.
 * Check the declared length first, then enforce while streaming in case it lied.
 */
async function readCappedBody(res, max) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > max) throw new Error('Response too large');
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > max) throw new Error('Response too large');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new Error('Response too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

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
    const pid = record.id;
    switch (method) {
      case 'activated': {
        const f = frame || record.frame;
        clearTimeout(f?._timer);
        if (params.ok) f?.resolveActivated?.(f);
        else f?.rejectActivated?.(new Error(params.error || 'activate() failed'));
        return { ok: true };
      }

      // Run a command (the SDK's ctx.commands.execute). Gated per COMMAND, not per
      // capability: the plugin's manifest lists exactly which commands it may run
      // (plus its own, implicitly). A blanket "commands" grant would let a plugin that
      // wanted `workbench.view.home` also call `explorer.delete`.
      case 'command:execute': {
        const target = this.#resolveCommand(record, params.id);
        if (!canExecuteCommand(record.manifest, target)) {
          throw new Error(`Command "${params.id}" is not in this plugin's declared commands`);
        }
        const result = await this.platform.commands.execute(target, ...(params.args || []));
        return { ok: true, result: result ?? null };
      }

      // Drive a DECLARED status slot: push sanitized HTML into it, or show/hide it.
      // The slot itself is a manifest contribution — this only fills one in, so a
      // plugin can never grow its footprint in the shell past what was approved.
      case 'ui:status': {
        cap('ui');
        const slot = this.#ownContribution(record, params.name, 'statusItem');
        this.platform.contributions.update(slot.uri, {
          ...(params.html !== undefined ? { html: String(params.html ?? '') } : {}),
          ...(params.tooltip !== undefined ? { tooltip: String(params.tooltip ?? '') } : {}),
          ...(params.visible !== undefined ? { visible: !!params.visible } : { visible: true }),
        });
        return { ok: true };
      }

      // Set a DECLARED register — a context value slot other contributions' when-clauses
      // can read, addressed by its contribution URI.
      case 'context:setRegister': {
        const slot = this.#ownContribution(record, params.name, 'register');
        this.platform.context.set(slot.uri, params.value);
        return { ok: true };
      }
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
        const ns = parseContribUri(params.indexerId) ? params.indexerId : contribUri(record.manifest, params.indexerId || 'default');
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
      // Artwork is a URL the BROWSER fetches on the plugin's behalf, so it is egress
      // and belongs under the same allowlist the broker enforces. Left open, `media`
      // alone bought an outbound GET to any URL the plugin chose — the exfiltration
      // channel `connect-src 'none'` and the broker exist to close.
      case 'media:metadata': {
        cap('media');
        const artwork = (params.artwork || []).filter((a) => this.#artworkAllowed(record, a?.src));
        return this.media.apply(frame, 'metadata', { ...params, artwork });
      }
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
    switch (method) {
      case 'manifest':
        // Only the primary frame's manifest defines the plugin's live feature list;
        // a viewer frame re-announces its own (opener-only) manifest — ignore it.
        if (frame && frame.role !== 'primary') break;
        record.live = params; record.responsive = true;
        this.onChange();
        break;
      case 'ui:toast':
        this.platform.notifications[params.level || 'info'](`${displayName(record.manifest)}: ${params.text}`);
        break;
      case 'ui:badge':
        record.badge = params.text; this.onChange();
        break;
    }
  }

  // --- addressing ------------------------------------------------------------

  /**
   * Resolve a command reference from inside a plugin frame. A plugin names its OWN
   * commands by their short contribution name (that's the only name it knows); anything
   * else must be a full address — a built-in like `explorer.download`, or another
   * plugin's contribution URI.
   */
  #resolveCommand(record, id) {
    if (!id || parseContribUri(id)) return id;
    const own = this.platform.contributions.get(contribUri(record.manifest, id));
    return own?.type === 'command' ? own.uri : id;
  }

  /**
   * The plugin's own contribution called `name`, of the expected type. Anything else —
   * a name it never declared, or one of the wrong type — is refused: a plugin drives
   * only slots the user saw and approved at install.
   */
  #ownContribution(record, name, type) {
    const c = name ? this.platform.contributions.get(contribUri(record.manifest, name)) : null;
    if (!c || c.pluginId !== record.id || c.type !== type) {
      throw new Error(`"${name}" is not a ${type} declared by this plugin`);
    }
    return c;
  }

  // --- brokered capabilities -------------------------------------------------

  /**
   * Perform a network request on a plugin's behalf, but only to a URL it declared
   * in its manifest `network` allowlist. The request runs from the host with
   * credentials omitted (no ambient cookies/auth), and any redirect that lands
   * off the allowlist is rejected.
   */
  /** blob:/data: carry their own bytes; anything else must be a declared endpoint. */
  #artworkAllowed(record, src) {
    if (!src) return false;
    if (/^(blob:|data:image\/)/i.test(src)) return true;
    return isAllowedUrl(networkEndpoints(record.manifest), src);
  }

  async #brokerFetch(record, { url, method = 'GET', headers, body }) {
    const allow = networkEndpoints(record.manifest);
    // The drive itself is never a "network endpoint".
    //
    // The broker runs in the HOST page, which is same-origin with the API. A manifest
    // declaring `network: ["https://*.com/"]` matches essentially any drive host, so a
    // plugin approved only for "connect to the internet" could call /api/items,
    // /api/items/delete, and other plugins' /api/plugins/:id/sql directly — collecting
    // the whole `files` capability, the per-command grant system, and every other
    // plugin's server-side store in one hop, none of which the user approved. Those
    // routes have a legitimate caller: the host, through the capability-gated methods
    // above.
    if (sameOrigin(url, this.platform.api?.baseUrl)) {
      throw new Error('Blocked: a plugin may not call the drive\'s own API through the network broker');
    }
    if (!isAllowedUrl(allow, url)) {
      throw new Error(`Blocked: "${url}" is not one of this plugin's declared network endpoints`);
    }
    const init = { method, credentials: 'omit', redirect: 'follow', headers: sanitizeHeaders(headers) };
    if (body != null && method !== 'GET' && method !== 'HEAD') {
      init.body = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    }
    const res = await fetch(url, init);
    // A redirect chain must not escape the declared endpoints — nor land back on the
    // drive, which a declared endpoint is free to redirect to.
    if (res.url && res.url !== url) {
      if (sameOrigin(res.url, this.platform.api?.baseUrl)) {
        throw new Error('Blocked: request redirected onto the drive\'s own API');
      }
      if (!isAllowedUrl(allow, res.url)) {
        throw new Error(`Blocked: request redirected off this plugin's declared endpoints (${res.url})`);
      }
    }
    const buf = await readCappedBody(res, MAX_FETCH_BYTES);
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
      //
      // Same guard as the server path. The client dbs share ONE emscripten module
      // across every scope, so ATTACH / VACUUM INTO / PRAGMA are an isolation escape
      // here for the same reason they are on disk — the blast radius is the browser's
      // in-memory filesystem rather than the host's, which makes it smaller, not fine.
      if (op === 'batch') for (const s of (Array.isArray(statements) ? statements : [])) assertSafePluginSql(s?.sql);
      else assertSafePluginSql(sql);
      const key = scope === 'domain' ? `dom:${record.manifest.domain}` : `plg:${record.id}`;
      const db = await this.clientDb.obtain(key);
      return runSqlOp(db, op, sql, params, statements);
    }
    // Server: the host proxies to the scoped db over the authenticated API; the
    // domain (for the shared scope) comes from the verified install record, never
    // the plugin.
    const body = { scope, op, sql, params, statements, domain: scope === 'domain' ? record.manifest.domain : undefined };
    const res = await this.platform.api.request('POST', `/api/plugins/${encodeURIComponent(record.id)}/sql`, { body });
    return res.result;
  }
}

/**
 * Is `url` on the drive's own origin?
 *
 * `baseUrl` is '' in the shipped app (the API is served from the same origin as the
 * page), so the comparison is against `location.origin`; a library caller pointing the
 * client at another host gets that one. A redirect is checked separately, on the way
 * back, since a declared endpoint could redirect here.
 */
function sameOrigin(url, baseUrl) {
  try {
    const here = new URL(baseUrl || '', globalThis.location?.href || 'http://localhost/');
    return new URL(url, here).origin === here.origin;
  } catch {
    return false;
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

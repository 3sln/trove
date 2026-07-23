// PluginHost — loads plugins into hidden, sandboxed iframes and bridges them to
// the workbench over a MessagePort. This is the security boundary: a plugin's
// code runs in an iframe on the *plugin's own domain* (declared in its manifest),
// never touching the host DOM or globals. The only channel is RPC.
//
// A manifest:
//   {
//     id: 'com.example.audiobooks',
//     name: 'Audiobooks',
//     entry: 'https://plugin.example.com/trove-plugin.html',  // its own origin
//     capabilities: ['storage', 'files'],   // gates what the host exposes
//     contributes: { ... }                  // optional declarative contributions
//   }
//
// Grant flow: the host only wires the capabilities the manifest asks for and the
// user approved. Plugin contributions (commands/openers/indexers) are registered
// into the shared ContributionRegistry, tagged with the plugin id, and revoked on
// unload. Plugin-rendered UI is surfaced by resizing/showing its iframe as a
// popup panel (Chrome-extension style) on request.

import { RpcChannel } from '@trove/plugin-sdk/rpc.js';
import { PluginDataStore } from './pluginData.js';

const ALL_CAPABILITIES = ['files', 'storage', 'ui', 'commands', 'indexer', 'opener'];

export class PluginHost {
  /**
   * @param {object} platform the assembled platform (contributions, commands, api, …)
   */
  constructor(platform) {
    this.platform = platform;
    this.plugins = new Map(); // id -> record
    this.subject = platform.reactive.ObservableSubject
      ? new platform.reactive.ObservableSubject([])
      : null;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.manifest.id, name: p.manifest.name, status: p.status,
      capabilities: p.granted, error: p.error || null, hasUi: p.hasUi,
    }));
  }
  observe() {
    return this.subject;
  }
  #emit() {
    this.subject?.next(this.list());
  }

  domainOf(manifest) {
    try {
      return new URL(manifest.entry).hostname || manifest.id;
    } catch {
      return manifest.id;
    }
  }

  /**
   * Load and activate a plugin. `grant` limits capabilities (defaults to the
   * intersection of requested and allowed). Returns when the plugin's
   * activate() resolves (or rejects).
   */
  async load(manifest, { grant } = {}) {
    if (this.plugins.has(manifest.id)) return this.plugins.get(manifest.id);
    const requested = manifest.capabilities || [];
    const granted = (grant || requested).filter((c) => ALL_CAPABILITIES.includes(c) && requested.includes(c));

    const iframe = document.createElement('iframe');
    // Hidden by default; surfaced only when the plugin/user opens its panel.
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
    // Sandbox: scripts run, but same-origin is NOT granted to the host — the
    // frame is on the plugin's own origin, isolated from ours.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.src = manifest.entry;

    const record = {
      manifest, granted, iframe, status: 'loading', error: null,
      disposers: [], channel: null, hasUi: false, origin: new URL(manifest.entry).origin,
      db: granted.includes('storage') ? new PluginDataStore(this.domainOf(manifest)) : null,
    };
    this.plugins.set(manifest.id, record);
    this.#emit();
    document.body.appendChild(iframe);

    try {
      await this.#handshake(record);
      record.status = 'active';
    } catch (err) {
      record.status = 'error';
      record.error = err?.message || String(err);
      this.platform.notifications.error(`Plugin "${manifest.name}" failed to load: ${record.error}`);
    }
    this.#emit();
    return record;
  }

  #handshake(record) {
    return new Promise((resolve, reject) => {
      const { iframe, manifest } = record;
      const timer = setTimeout(() => reject(new Error('Plugin handshake timed out')), 15000);

      const onReady = (e) => {
        if (e.source !== iframe.contentWindow || e.data?.__trove !== 'ready') return;
        window.removeEventListener('message', onReady);

        const channel = new MessageChannel();
        record.channel = new RpcChannel(channel.port1, {
          onCall: (m, p) => this.#hostCall(record, m, p),
          onEvent: (m, p) => this.#hostEvent(record, m, p),
        });
        record.resolveActivated = resolve;
        record.rejectActivated = reject;
        record._timer = timer;

        iframe.contentWindow.postMessage(
          { __trove: 'init', manifest, capabilities: record.granted },
          record.origin,
          [channel.port2],
        );
      };
      window.addEventListener('message', onReady);
      iframe.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Failed to load plugin iframe'));
      });
    });
  }

  // Plugin → host RPC. Every branch is capability-checked.
  async #hostCall(record, method, params) {
    const cap = (c) => {
      if (!record.granted.includes(c)) throw new Error(`Capability "${c}" not granted`);
    };
    const pid = record.manifest.id;
    switch (method) {
      case 'activated': {
        clearTimeout(record._timer);
        if (params.ok) record.resolveActivated?.(record);
        else record.rejectActivated?.(new Error(params.error || 'activate() failed'));
        return { ok: true };
      }
      // Contributions — tagged with pluginId, registered into the shared registry.
      case 'contribute:command': {
        const dispose = this.platform.commands.registerHandler(params.id, (...args) =>
          record.channel.call('command:execute', { id: params.id, args }),
        );
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
        const dispose = this.platform.contributions.indexers.register({ ...params, pluginId: pid });
        record.disposers.push(dispose);
        return { ok: true };
      }
      case 'contribute:statusItem': {
        const dispose = this.platform.contributions.statusItems.register({ ...params, pluginId: pid });
        record.disposers.push(dispose);
        return { ok: true };
      }
      case 'contribute:keybinding': {
        const dispose = this.platform.contributions.keybindings.register(params);
        record.disposers.push(dispose);
        return { ok: true };
      }
      // Files — inherit the host's authenticated API client.
      case 'files:read': {
        cap('files');
        return { text: await this.platform.api.readText(params.id) };
      }
      case 'files:list': {
        cap('files');
        return this.platform.api.list(params.pathOrId, params);
      }
      case 'files:stat': {
        cap('files');
        return this.platform.api.stat(params.id);
      }
      case 'files:downloadUrl': {
        cap('files');
        return { url: this.platform.api.downloadUrl(params.id) };
      }
      case 'files:index': {
        cap('indexer');
        // Namespace under the plugin id so it can only write its own facet.
        const ns = params.indexerId?.startsWith(pid) ? params.indexerId : `${pid}.${params.indexerId || 'default'}`;
        return this.platform.api.pushIndex(ns, params.nodeId, params.documents, params.facet);
      }
      // Per-domain persistent DB.
      case 'db:get': return cap('storage'), record.db.get(params.key);
      case 'db:set': return cap('storage'), record.db.set(params.key, params.value);
      case 'db:delete': return cap('storage'), record.db.delete(params.key);
      case 'db:query': return cap('storage'), record.db.query(params.prefix);
      // UI surface.
      case 'ui:showPanel': {
        record.hasUi = true;
        this.platform.openPluginPanel?.(pid);
        this.#emit();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown host method ${method}`);
    }
  }

  #hostEvent(record, method, params) {
    const pid = record.manifest.id;
    switch (method) {
      case 'ui:toast':
        this.platform.notifications[params.level || 'info'](params.text);
        break;
      case 'ui:badge':
        record.badge = params.text;
        this.#emit();
        break;
      case 'context:set':
        this.platform.context.scopedFor(pid).set(params.key, params.value);
        break;
    }
  }

  /** Show a plugin's iframe as a popup panel (Chrome-extension style). */
  mountPanel(pluginId, container, { width = 380, height = 480 } = {}) {
    const record = this.plugins.get(pluginId);
    if (!record) return null;
    const f = record.iframe;
    f.style.cssText = `width:${width}px;height:${height}px;border:0;visibility:visible;display:block;`;
    container.appendChild(f);
    record.hasUi = true;
    return () => {
      // Return the iframe to its hidden parking spot so the plugin stays alive.
      f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
      document.body.appendChild(f);
    };
  }

  async unload(pluginId) {
    const record = this.plugins.get(pluginId);
    if (!record) return;
    try {
      record.channel?.emit('deactivate');
    } catch { /* ignore */ }
    for (const d of record.disposers) {
      try {
        d();
      } catch { /* ignore */ }
    }
    record.channel?.dispose();
    record.iframe.remove();
    this.plugins.delete(pluginId);
    this.#emit();
  }
}

export { ALL_CAPABILITIES };

// Injectable browser build of the Trove plugin SDK — a single self-contained IIFE
// with NO imports, so the host can inline it into a sandboxed iframe's srcdoc
// alongside the plugin's entry script. The iframe runs on an opaque origin
// (sandbox="allow-scripts", no allow-same-origin), so it can't fetch its own
// package files; instead it reaches everything — resources, files, settings,
// storage — through the host over a transferred MessagePort. Package resources
// are handed back as raw bytes (or iframe-local blob: URLs), never host URLs, so
// the plugin only ever holds opaque handles.
//
// Plugins use it as:  trove.activate(async (ctx) => { ... })
(function () {
  'use strict';
  // Wire-protocol version this SDK speaks. MUST equal PROTOCOL_VERSION in
  // protocol.js — this file is injected as text and cannot import it, so
  // protocol.test.js asserts the two stay in step.
  const SDK_PROTOCOL_VERSION = '1.0';
  let port = null, manifest = null, capabilities = [], storageScopes = {}, online = true, seq = 0, role = 'primary';
  const pending = new Map();
  const commandHandlers = new Map();
  const openerHandlers = new Map();
  const indexerHandlers = new Map();
  const contributions = { commands: new Map(), openers: new Map(), indexers: new Map(), statusItems: new Map() };
  let onConnectivity = null, onDeactivate = null, onSettingsChange = null, onDock = null;
  const mediaHandlers = {}; // action -> handler, for OS media-session controls

  const now = () => { try { return Date.now(); } catch { return 0; } };

  function call(method, params, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port.postMessage({ __trove: 'req', id, method, params }, transfer || []);
    });
  }
  const emit = (method, params) => port.postMessage({ __trove: 'event', method, params });

  function buildManifest() {
    return {
      id: manifest && manifest.id, name: manifest && manifest.name, online, ts: now(),
      contributions: {
        commands: [...contributions.commands.values()],
        openers: [...contributions.openers.values()],
        indexers: [...contributions.indexers.values()],
        statusItems: [...contributions.statusItems.values()],
      },
    };
  }
  const announce = () => port && emit('manifest', buildManifest());

  function onPort(e) {
    const m = e.data;
    if (!m || m.__trove == null) return;
    if (m.__trove === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result);
    } else if (m.__trove === 'req') {
      Promise.resolve().then(() => dispatch(m.method, m.params))
        .then((result) => port.postMessage({ __trove: 'res', id: m.id, result }))
        .catch((err) => port.postMessage({ __trove: 'res', id: m.id, error: { message: err.message } }));
    } else if (m.__trove === 'event') {
      dispatchEvent(m.method, m.params);
    }
  }

  function dispatch(method, params) {
    if (method === 'command:execute') return commandHandlers.get(params.id) && commandHandlers.get(params.id)(...(params.args || []));
    if (method === 'opener:open') { const f = openerHandlers.get(params.openerId); if (!f) throw new Error('no opener ' + params.openerId); return f(params.file, params.context); }
    if (method === 'indexer:run') { const f = indexerHandlers.get(params.indexerId); if (!f) throw new Error('no indexer ' + params.indexerId); return f(params.file); }
    if (method === 'manifest') return buildManifest();
    throw new Error('Unknown host call ' + method);
  }
  async function dispatchEvent(method, params) {
    if (method === 'deactivate') return onDeactivate && onDeactivate();
    if (method === 'connectivity') { online = !!params.online; try { onConnectivity && (await onConnectivity({ online })); } catch (e) { console.error(e); } announce(); }
    if (method === 'settings:changed') { try { onSettingsChange && onSettingsChange(params.key, params.value); } catch (e) { console.error(e); } }
    // The OS/host fired a media transport control (play/pause/next/seek…).
    if (method === 'media:action') { try { mediaHandlers[params.action] && mediaHandlers[params.action](params); } catch (e) { console.error(e); } }
    // The host docked or undocked this viewer (see ctx.dock).
    if (method === 'dock:state') { try { onDock && onDock(params); } catch (e) { console.error(e); } }
  }

  function requireCap(cap) { if (!capabilities.includes(cap)) throw new Error('Plugin lacks capability "' + cap + '"'); }

  // Storage: one async SQL handle (mirrors the host SqliteDatabase interface) per
  // scope+side, over RPC. Only granted scopes are exposed on ctx.storage.
  function sqlHandle(scope, side) {
    var send = function (op, extra) { return call('storage:sql', Object.assign({ scope: scope, side: side, op: op }, extra)); };
    return {
      exec: function (sql) { return send('exec', { sql: sql }); },
      run: function (sql) { return send('run', { sql: sql, params: [].slice.call(arguments, 1) }); },
      get: function (sql) { return send('get', { sql: sql, params: [].slice.call(arguments, 1) }); },
      all: function (sql) { return send('all', { sql: sql, params: [].slice.call(arguments, 1) }); },
      batch: function (statements) { return send('batch', { statements: statements }); },
    };
  }
  function scopeHandle(scope) {
    return { server: sqlHandle(scope, 'server'), client: sqlHandle(scope, 'client') };
  }
  function makeStorage() {
    var s = {};
    if (storageScopes.plugin) s.plugin = scopeHandle('plugin');
    if (storageScopes.domain) s.domain = scopeHandle('domain');
    return s;
  }

  function hasHeader(h, name) { name = name.toLowerCase(); for (var k in h) if (k.toLowerCase() === name) return true; return false; }
  // Wrap the host's brokered-fetch result in a minimal Response-like object.
  function makeResponse(r) {
    var bytes = new Uint8Array(r.bytes || new ArrayBuffer(0));
    var decode = function () { return new TextDecoder().decode(bytes); };
    return {
      ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers: r.headers || {},
      arrayBuffer: function () { return Promise.resolve(bytes.slice().buffer); },
      bytes: function () { return Promise.resolve(bytes); },
      text: function () { return Promise.resolve(decode()); },
      json: function () { return Promise.resolve(JSON.parse(decode())); },
    };
  }

  function makeContext() {
    return {
      manifest, capabilities,
      // Which instance this is: 'primary' is the plugin's single background frame
      // (register commands/indexers, do one-time setup here); 'viewer' is a
      // per-open frame hosting an opener for one file (drive media/dock from here).
      role,
      get online() { return online; },
      commands: {
        register(id, handler, opts) {
          opts = opts || {};
          commandHandlers.set(id, handler);
          const spec = { id, title: opts.title, category: opts.category, icon: opts.icon, offline: !!opts.offline };
          contributions.commands.set(id, spec);
          return call('contribute:command', spec);
        },
        execute(id) { const a = [].slice.call(arguments, 1); return call('command:execute', { id, args: a }); },
      },
      contributes: {
        opener(spec, handler) { openerHandlers.set(spec.id, handler); const e = Object.assign({}, spec, { offline: !!spec.offline }); contributions.openers.set(spec.id, e); return call('contribute:opener', e); },
        indexer(spec, handler) { indexerHandlers.set(spec.id, handler); const e = Object.assign({}, spec, { offline: !!spec.offline }); contributions.indexers.set(spec.id, e); return call('contribute:indexer', e); },
        statusItem(spec) { contributions.statusItems.set(spec.id, Object.assign({}, spec, { offline: !!spec.offline })); return call('contribute:statusItem', spec); },
        keybinding(spec) { return call('contribute:keybinding', spec); },
      },
      // Package resources — opaque handles. read() copies bytes into the iframe;
      // url() wraps them in an iframe-local blob: URL.
      resources: {
        list() { return call('resources:list', {}); },
        async read(path) { const r = await call('resources:read', { path }); return new Uint8Array(r.bytes); },
        async text(path) { return new TextDecoder().decode(await this.read(path)); },
        async url(path, type) {
          const bytes = await this.read(path);
          return URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
        },
      },
      ui: {
        toast: (text, opts) => emit('ui:toast', Object.assign({ text }, opts)),
        showPanel: () => call('ui:showPanel', {}),
        setBadge: (text) => emit('ui:badge', { text }),
        setContext: (key, value) => emit('context:set', { key, value }),
      },
      // Media session — surfaces this viewer's playback to the OS (lock-screen /
      // notification transport controls, so phones can play/pause/seek). The host
      // owns navigator.mediaSession; action handlers are called back over RPC.
      media: {
        setMetadata: (m) => (requireCap('media'), call('media:metadata', m || {})),
        setPlaybackState: (state) => (requireCap('media'), call('media:playbackState', { state })),
        setPositionState: (p) => (requireCap('media'), call('media:position', p || {})),
        setActionHandler: (action, handler) => { requireCap('media'); if (handler) mediaHandlers[action] = handler; else delete mediaHandlers[action]; return call('media:action', { action, on: !!handler }); },
        clear: () => call('media:clear', {}),
      },
      // Dock — register this viewer to persist as a small floating frame when the
      // user navigates away (a docked video = picture-in-picture; docked audio = a
      // mini transport). Enable while playing/active, disable otherwise. `minSize`/
      // `maxSize` are {width,height} constraints. onDock is notified on (un)dock.
      dock: {
        enable: (opts) => (requireCap('dock'), call('dock:enable', opts || {})),
        disable: () => (requireCap('dock'), call('dock:disable', {})),
        close: () => call('dock:close', {}),
        onChange: (fn) => { onDock = fn; },
      },
      // Network — there is no direct fetch in the sandbox; the host performs the
      // request, but ONLY to endpoints declared in the manifest's `network` list
      // (and only with the "network" capability). Returns a Response-like object.
      net: {
        fetch(url, opts) {
          requireCap('network');
          opts = opts || {};
          var body = opts.body;
          var headers = Object.assign({}, opts.headers);
          if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
            body = JSON.stringify(body);
            if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
          }
          if (body instanceof Uint8Array) body = body.buffer;
          return call('net:fetch', { url: String(url), method: opts.method || 'GET', headers: headers, body: body })
            .then(makeResponse);
        },
      },
      files: {
        read: (id, opts) => (requireCap('files'), call('files:read', Object.assign({ id }, opts))),
        list: (pathOrId, opts) => (requireCap('files'), call('files:list', Object.assign({ pathOrId }, opts))),
        stat: (id) => (requireCap('files'), call('files:stat', { id })),
        downloadUrl: (id) => (requireCap('files'), call('files:downloadUrl', { id })),
        // index(indexerId, nodeId, contribution) where contribution is
        // { semanticTexts?, tags?, metadata? }. Legacy (indexerId, nodeId, documents[], facet)
        // is still accepted when the 3rd arg is an array of documents.
        index: (indexerId, nodeId, contribution, facet) => {
          requireCap('indexer');
          var payload = Array.isArray(contribution) ? { documents: contribution, facet: facet } : (contribution || {});
          return call('files:index', Object.assign({ indexerId: indexerId, nodeId: nodeId }, payload));
        },
      },
      // Persistent storage: an isolated SQLite database per granted scope. `plugin`
      // is private to this plugin; `domain` (verified packages only) is shared with
      // the vendor's other plugins. Each scope exposes a `.server` handle (and, from
      // Stage 3, an on-device `.client` handle) with the same async SQL surface.
      storage: makeStorage(),
      // The plugin's own settings (declared in the manifest). getSecret reads a
      // secret-typed value the host stores separately.
      settings: {
        get: (key) => call('settings:get', { key }),
        getSecret: (key) => call('settings:getSecret', { key }),
        set: (key, value) => call('settings:set', { key, value }),
        onChange: (fn) => { onSettingsChange = fn; },
      },
      onConnectivity: (fn) => { onConnectivity = fn; },
      setAvailability: (id, opts) => { for (const k of Object.values(contributions)) if (k.has(id)) k.get(id).offline = !!(opts && opts.offline); announce(); },
      announce,
      onDeactivate: (fn) => { onDeactivate = fn; },
    };
  }

  async function activate(setup) {
    await new Promise((resolve) => {
      function onInit(e) {
        if (!e.data || e.data.__trove !== 'init') return;
        window.removeEventListener('message', onInit);
        manifest = e.data.manifest; capabilities = e.data.capabilities || []; storageScopes = e.data.storage || {}; online = e.data.online != null ? e.data.online : true; role = e.data.role || 'primary';
        port = e.ports[0];
        port.onmessage = onPort;
        resolve();
      }
      window.addEventListener('message', onInit);
      parent.postMessage({ __trove: 'ready', protocolVersion: SDK_PROTOCOL_VERSION }, '*');
    });
    const ctx = makeContext();
    try {
      await setup(ctx);
      await call('activated', { ok: true });
      announce();
    } catch (err) {
      await call('activated', { ok: false, error: err && err.message });
      throw err;
    }
    return ctx;
  }

  globalThis.trove = { activate };
})();

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
  let onConnectivity = null, onDeactivate = null, onSettingsChange = null, onDock = null;
  const mediaHandlers = {}; // action -> handler, for OS media-session controls

  const now = () => { try { return Date.now(); } catch { return 0; } };

  // The HOST times its own calls out; this side did not, and `pending` was never
  // rejected — not on a dropped reply, not on port close. A plugin awaiting one hung
  // forever with no way to find out, and the entry leaked with it.
  const CALL_TIMEOUT_MS = 30_000;

  function call(method, params, transfer) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for the host to answer "${method}"`));
      }, CALL_TIMEOUT_MS);
      if (timer && timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ __trove: 'req', id, method, params }, transfer || []);
    });
  }
  const emit = (method, params) => port.postMessage({ __trove: 'event', method, params });

  /**
   * A file's bytes, addressable without holding them.
   *
   * `Blob` is already the browser's interface for exactly that — `slice()` is free,
   * `stream()` is a reader, and everything that eats bytes eats a Blob — so a range reader
   * wears the interface that exists rather than inventing a parallel vocabulary.
   *
   * THE SHARP EDGE, and it is sharp: a Blob SUBCLASS only overrides what JavaScript calls.
   * Anything reading the blob's internal bytes — `URL.createObjectURL`, `new
   * Response(blob)`, `fetch(url, {body})`, and structured clone through `postMessage` —
   * bypasses every override here and sees the empty blob passed to `super()`. Two
   * consequences the design is built around:
   *
   *   1. A RemoteBlob cannot be posted INTO this frame from the host; it would arrive as a
   *      plain, empty Blob. It is constructed here, in the frame that uses it.
   *   2. `local()` is the escape hatch for all of them. A realized Blob really does hold
   *      its bytes, so it works with `createObjectURL` — which is the download-then-play
   *      path for anything that cannot be streamed.
   */
  class RemoteBlob extends Blob {
    constructor(id, { size = 0, type = '', etag = null, start = 0, end = null } = {}) {
      super();
      this.id = id;
      // `_type`, and a getter below. `Blob.prototype.type` is an accessor with no setter,
      // so `this.type = …` THROWS in strict mode — which every module is. That one line
      // meant `ctx.files.blob()` rejected on construction for every plugin that ever
      // called it: no cover art, no container parsing, no streaming, and an error message
      // ("Cannot set property type of #<Blob> which has only a getter") that never left
      // the sandboxed frame it was thrown in.
      this._type = type;
      this.etag = etag;
      // A window on the source. `size` is this window's length, which is what makes
      // `slice()` of a slice behave the way a caller expects.
      this._start = start;
      this._end = end == null ? size : end;
    }

    get size() { return Math.max(0, this._end - this._start); }
    get type() { return this._type; }

    /**
     * A window on the same source. No bytes move and none need to exist yet.
     *
     * Negative indices count from the end, as `Blob.slice` does — which is what makes
     * "the last 64 KiB" expressible, and reading the tail of a file is half of what a
     * container parser does.
     */
    slice(begin = 0, finish = this.size, type = this.type) {
      const len = this.size;
      const from = begin < 0 ? Math.max(0, len + begin) : Math.min(begin, len);
      const to = finish < 0 ? Math.max(0, len + finish) : Math.min(finish, len);
      const win = new RemoteBlob(this.id, {
        type, etag: this.etag,
        start: this._start + from,
        end: this._start + Math.max(from, to),
      });
      return win;
    }

    /**
     * The bytes of this window.
     *
     * A `signal` is checked BEFORE the call and not during it: an in-flight request over
     * the port cannot be recalled, so the honest granularity is per read. `chunks()` is
     * where cancelling actually bites, because there the reads are small and there are
     * many of them.
     */
    async bytes({ signal } = {}) {
      if (signal && signal.aborted) throw new Error('Aborted');
      const r = await call('files:bytes', { id: this.id, start: this._start, end: this._end });
      // Every read refreshes the etag, because a file overwritten in place keeps its id
      // and anything cached off these bytes has to notice.
      if (r.etag) this.etag = r.etag;
      return new Uint8Array(r.bytes);
    }
    async arrayBuffer() { return (await this.bytes()).buffer; }
    async text() { return new TextDecoder().decode(await this.bytes()); }

    /** One window at a time, so a caller can walk a large file without holding it. */
    async *chunks({ size = 4 * 1024 * 1024, signal } = {}) {
      for (let at = 0; at < this.size; at += size) {
        yield this.slice(at, Math.min(at + size, this.size)).bytes({ signal });
      }
    }

    stream() {
      const iter = this.chunks();
      return new ReadableStream({
        async pull(controller) {
          const { value, done } = await iter.next();
          if (done) controller.close();
          else controller.enqueue(value);
        },
      });
    }

    /**
     * REALIZE the bytes into an ordinary Blob.
     *
     * The escape hatch named above, and the download half of "this book cannot be
     * streamed, here is a Download button". `onProgress` fires once with `loaded: 0`
     * BEFORE the first chunk, so a bar appears at 0% instead of jumping in partway.
     */
    async local({ onProgress, signal, chunkSize = 4 * 1024 * 1024 } = {}) {
      const total = this.size;
      const parts = [];
      let loaded = 0;
      if (onProgress) onProgress({ loaded: 0, total, ratio: 0 });
      for await (const chunk of this.chunks({ size: chunkSize, signal })) {
        parts.push(chunk);
        loaded += chunk.length;
        if (onProgress) onProgress({ loaded, total, ratio: total ? loaded / total : 0 });
      }
      return new Blob(parts, { type: this.type });
    }
  }

  // What this frame reports about itself on every heartbeat. Contributions are the
  // host's own manifest reading — all the plugin can usefully say is which of its
  // declared contributions it actually bound a handler to, plus whether it thinks
  // it's online.
  function buildManifest() {
    return {
      domain: manifest && manifest.domain, name: manifest && manifest.name,
      online, role, ts: now(),
      handlers: [...commandHandlers.keys()],
    };
  }
  const announce = () => port && emit('manifest', buildManifest());

  function onPort(e) {
    const m = e.data;
    if (!m || m.__trove == null) return;
    if (m.__trove === 'res') {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
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
    if (method === 'command:execute') {
      const h = commandHandlers.get(params.id);
      // Throw, like `opener:open` two lines down. Resolving `undefined` for an id with
      // no handler told the host the command had RUN when nothing had.
      if (!h) throw new Error(`No handler registered for command "${params.id}"`);
      return h(...(params.args || []));
    }
    if (method === 'opener:open') {
      // An opener frame boots at that opener's entry module and runs exactly one
      // opener, so an unkeyed onOpen(fn) handler is the normal case.
      const f = openerHandlers.get(params.openerId) || openerHandlers.get('*');
      if (!f) throw new Error('no opener ' + params.openerId);
      return f(params.file, params.context);
    }
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
      // Contributions are DECLARED IN THE MANIFEST (openers, indexers, commands,
      // statusItems, keybindings). The host registers them before this code runs, so
      // a plugin never registers anything at runtime — it only supplies the behaviour
      // for what it declared, addressed by id.
      commands: {
        /** Implement a command this plugin's manifest declares, by its short name. */
        handle(name, handler) { commandHandlers.set(name, handler); return this; },
        /**
         * Run a command. Its OWN commands by short name; anyone else's by full address
         * (a built-in like 'explorer.download', or a `trove+contrib:` URI) — and only
         * if the manifest's `commands` capability lists it.
         */
        execute(id) { const a = [].slice.call(arguments, 1); return call('command:execute', { id, args: a }); },
      },
      /** Implement the opener this frame was booted for (its entry module). The id is
       *  optional — an opener frame runs exactly one opener. */
      onOpen(idOrHandler, maybeHandler) {
        const [id, handler] = typeof idOrHandler === 'function' ? ['*', idOrHandler] : [idOrHandler, maybeHandler];
        openerHandlers.set(id, handler);
        return this;
      },
      // NOTE: there is no onIndex(). Indexers run on the SERVER (in its isolate
      // runtime), not in this sandbox — indexing has to happen once per upload for the
      // drive, not in whichever tab is open. An indexer's entry module is plain ESM
      // exporting `index(node, ctx)`; it doesn't use this SDK at all. What a plugin can
      // do from here is PUSH contributions for a node via ctx.files.index (the
      // `indexer` capability).
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
        /**
         * Drive a status-bar slot this plugin's manifest declares. `html` is sanitized
         * by the host down to a small inline-formatting allowlist before it renders.
         *   ctx.ui.status('sync').set('<b>3</b> queued')
         *   ctx.ui.status('sync').hide()
         */
        status(name) {
          return {
            set: (html, opts) => call('ui:status', Object.assign({ name, html, visible: true }, opts || {})),
            show: () => call('ui:status', { name, visible: true }),
            hide: () => call('ui:status', { name, visible: false }),
          };
        },
      },
      /**
       * Registers — context value slots this plugin's manifest declares, which
       * when-clauses (its own keymap's, its commands') read by contribution URI.
       *   ctx.registers.set('busy', true)
       */
      registers: {
        set: (name, value) => call('context:setRegister', { name, value }),
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
          // `.buffer` ignores byteOffset/byteLength, so any view produced by `subarray` or
    // `slice` — or a view into a pooled buffer — sent the WHOLE backing store: the wrong
    // payload, and an out-of-band leak of whatever else was in it.
    if (ArrayBuffer.isView(body)) {
      body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
          return call('net:fetch', { url: String(url), method: opts.method || 'GET', headers: headers, body: body })
            .then(makeResponse);
        },
      },
      files: {
        read: (id, opts) => (requireCap('files'), call('files:read', Object.assign({ id }, opts))),
        list: (pathOrId, opts) => (requireCap('files'), call('files:list', Object.assign({ pathOrId }, opts))),
        stat: (id) => (requireCap('files'), call('files:stat', { id })),
        downloadUrl: (id) => (requireCap('files'), call('files:downloadUrl', { id })),

        /**
         * A file's bytes as a Blob you can slice, stream and realize — see RemoteBlob.
         *
         * `stat` first, because a Blob has to know its own size before `slice` means
         * anything. One round trip, and every later read is a range.
         */
        async blob(id) {
          requireCap('files');
          const { node } = await call('files:stat', { id });
          return new RemoteBlob(id, { size: node.size || 0, type: node.contentType || '', etag: node.etag || null });
        },

        /**
         * A URL a media element can load by itself, for streaming.
         *
         * It is MINTED — it carries its own grant and expires — which is the one place a
         * host URL deliberately reaches a plugin. `<audio src>` is the only way to play a
         * progressive MP4 without a fragmenter: MSE refuses one, and a Blob has to be
         * whole before it can become an object URL. Use `blob(id)` for the parsing (a
         * container's chapters are a few kilobytes out of a few hundred megabytes) and
         * this for the playing.
         */
        mediaUrl: (id, opts) => (requireCap('files'), call('files:mediaUrl', Object.assign({ id }, opts))),

        /**
         * Is the whole file already in this browser?
         *
         * Cheap — it reads bookkeeping, not bytes — so ask it before deciding what to
         * draw. `{ local, loaded, total, ratio, filling }`: enough to show a progress
         * bar for a download already under way instead of offering to start it again.
         */
        hasLocal: (id) => (requireCap('files'), call('files:hasLocal', { id })),

        /**
         * The whole file as a Blob, or null when it is not stored locally.
         *
         * THE WAY MEDIA WORKS IN HERE. This frame's CSP is `connect-src 'none'` and
         * `media-src blob: data:` — deliberately, so a plugin cannot reach the network
         * and cannot be an exfiltration side-channel. An `<audio src="https://…">` is
         * therefore blocked outright, and no amount of URL minting changes that. A Blob
         * is allowed, so a downloaded file plays by being handed over.
         *
         * Null when the file is incomplete rather than a partial Blob: half an MP4 is
         * not a shorter MP4, and a caller handed one would fail like a decoder bug
         * instead of like a missing download. Pair it with `offline.start` and
         * `hasLocal` to get from "not here" to "here".
         */
        localBlob: async (id) => {
          requireCap('files');
          const { blob } = await call('files:localBlob', { id });
          return blob || null;
        },

        /**
         * Keeping a file, which is a DIFFERENT act from reading one.
         *
         * Ranging over a file stores nothing. `start(id)` is someone asking to have it
         * offline, and from then on every chunk a read fetches is kept and the background
         * filler skips it — so a book listened straight through downloads itself exactly
         * once, and a book skipped around in fills its gaps.
         */
        offline: {
          start: (id) => (requireCap('files'), call('files:offline:start', { id })),
          status: (id) => (requireCap('files'), call('files:offline:status', { id })),
          cancel: (id) => (requireCap('files'), call('files:offline:cancel', { id })),
          remove: (id) => (requireCap('files'), call('files:offline:remove', { id })),
        },
        // index(indexerId, nodeId, contribution) where contribution is
        // { semanticTexts?, tags?, metadata? }. Legacy (indexerId, nodeId, documents[], facet)
        // is still accepted when the 3rd arg is an array of documents.
        //
        // "Contribution" here is per-node ENRICHMENT — what an indexer says ABOUT a file,
        // addressed by contributorId. It is a different noun from the `contributes` map in
        // your manifest, which declares extension points addressed by URI. A plugin
        // declares an `indexer` contribution (that sense) and it produces contributions
        // (this sense).
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

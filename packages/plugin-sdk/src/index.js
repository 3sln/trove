// @trove/plugin-sdk — the API a Trove plugin uses from inside its sandboxed
// iframe. A plugin ships a small module that calls `activate(register => {...})`;
// the SDK handshakes with the host (adopting the transferred MessagePort),
// exposes the host's services behind `ctx`, and routes contribution callbacks
// (command handlers, openers, indexers) back over RPC.
//
// The plugin never has DOM access to the host. To show UI it either renders into
// its own iframe body (surfaced by the host as a popup/panel) or contributes
// declarative items (commands, status entries). Capabilities it didn't declare
// in its manifest are simply absent from `ctx`.
//
//   import { activate } from '@trove/plugin-sdk';
//   activate(async (ctx) => {
//     ctx.commands.register('hello.world', () => ctx.ui.toast('Hi from a plugin!'));
//     ctx.contributes.opener({ id: 'my.viewer', selector: { ext: ['.xyz'] } }, openXyz);
//   });

import { RpcChannel } from './rpc.js';

let channel = null;
let manifest = null;
let capabilities = [];
const commandHandlers = new Map();
const openerHandlers = new Map();
const indexerHandlers = new Map();
let onDeactivate = null;

/** Wait for the host's init message (carrying our MessagePort + manifest). */
function handshake() {
  return new Promise((resolve) => {
    function onInit(e) {
      if (e.data?.__trove !== 'init') return;
      window.removeEventListener('message', onInit);
      manifest = e.data.manifest;
      capabilities = e.data.capabilities || [];
      const port = e.ports[0];
      channel = new RpcChannel(port, { onCall: dispatch, onEvent: dispatchEvent });
      resolve();
    }
    window.addEventListener('message', onInit);
    // Announce readiness so the host knows the frame's SDK has loaded.
    parent.postMessage({ __trove: 'ready' }, '*');
  });
}

// Host → plugin calls (openers, command execution, indexing).
async function dispatch(method, params) {
  switch (method) {
    case 'command:execute': {
      const fn = commandHandlers.get(params.id);
      if (!fn) throw new Error(`No such command ${params.id}`);
      return fn(...(params.args || []));
    }
    case 'opener:open': {
      const fn = openerHandlers.get(params.openerId);
      if (!fn) throw new Error(`No such opener ${params.openerId}`);
      return fn(params.file, params.context);
    }
    case 'indexer:run': {
      const fn = indexerHandlers.get(params.indexerId);
      if (!fn) throw new Error(`No such indexer ${params.indexerId}`);
      return fn(params.file);
    }
    default:
      throw new Error(`Unknown host call ${method}`);
  }
}

function dispatchEvent(method, params) {
  if (method === 'deactivate') onDeactivate?.();
}

function requireCap(cap) {
  if (!capabilities.includes(cap)) {
    throw new Error(`Plugin lacks capability "${cap}" (declare it in the manifest)`);
  }
}

/** The context object handed to a plugin's activate() callback. */
function makeContext() {
  const ctx = {
    manifest,
    capabilities,

    // Contribution points ----------------------------------------------------
    commands: {
      register(id, handler) {
        commandHandlers.set(id, handler);
        return channel.call('contribute:command', { id });
      },
      execute(id, ...args) {
        return channel.call('command:execute', { id, args });
      },
    },
    contributes: {
      opener(spec, handler) {
        openerHandlers.set(spec.id, handler);
        return channel.call('contribute:opener', spec);
      },
      indexer(spec, handler) {
        indexerHandlers.set(spec.id, handler);
        return channel.call('contribute:indexer', spec);
      },
      statusItem(spec) {
        return channel.call('contribute:statusItem', spec);
      },
      keybinding(spec) {
        return channel.call('contribute:keybinding', spec);
      },
    },

    // Host services -----------------------------------------------------------
    ui: {
      toast: (text, opts) => channel.emit('ui:toast', { text, ...opts }),
      showPanel: () => channel.call('ui:showPanel', {}),
      setBadge: (text) => channel.emit('ui:badge', { text }),
      setContext: (key, value) => channel.emit('context:set', { key, value }),
    },
    // Files: read/list/search go through the host so the plugin inherits auth.
    files: {
      read: (id, opts) => channel.call('files:read', { id, ...opts }),
      list: (pathOrId, opts) => channel.call('files:list', { pathOrId, ...opts }),
      stat: (id) => channel.call('files:stat', { id }),
      downloadUrl: (id) => channel.call('files:downloadUrl', { id }),
      // Push search documents under THIS plugin's indexer namespace.
      index: (indexerId, nodeId, documents, facet) =>
        channel.call('files:index', { indexerId, nodeId, documents, facet }),
    },
    // Per-domain persistent DB (declare "storage").
    db: {
      get: (key) => (requireCap('storage'), channel.call('db:get', { key })),
      set: (key, value) => (requireCap('storage'), channel.call('db:set', { key, value })),
      delete: (key) => (requireCap('storage'), channel.call('db:delete', { key })),
      query: (prefix) => (requireCap('storage'), channel.call('db:query', { prefix })),
    },
    // Register a service other plugins/host can call (VS Code-style).
    services: {
      expose(name, methods) {
        for (const [m, fn] of Object.entries(methods)) commandHandlers.set(`service:${name}.${m}`, fn);
        return channel.call('contribute:service', { name, methods: Object.keys(methods) });
      },
      call: (name, method, ...args) => channel.call('service:call', { name, method, args }),
    },
    onDeactivate(fn) {
      onDeactivate = fn;
    },
  };
  return ctx;
}

/**
 * Entry point. Call once at the top of your plugin module.
 * @param {(ctx: object) => (void|Promise<void>)} setup
 */
export async function activate(setup) {
  await handshake();
  const ctx = makeContext();
  try {
    await setup(ctx);
    await channel.call('activated', { ok: true });
  } catch (err) {
    await channel.call('activated', { ok: false, error: err?.message });
    throw err;
  }
  return ctx;
}

export { RpcChannel };

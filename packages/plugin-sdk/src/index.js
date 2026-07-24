// @trove/plugin-sdk — the ESM entry a plugin author imports when building or
// bundling a plugin outside the sandbox:
//
//   import { activate } from '@trove/plugin-sdk';
//   activate(async (ctx) => {
//     ctx.commands.register('hello.world', () => ctx.ui.toast('Hi from a plugin!'));
//   });
//
// Inside a running Trove sandbox the host injects the SAME implementation directly
// (see ./browser.js) and exposes it as the global `trove`. To keep exactly one
// source of truth — so what an author imports can never drift from what actually
// runs — this module loads that implementation for its side effect and re-exports
// its surface. Importing is side-effect-safe: it only DEFINES the SDK (and sets
// `globalThis.trove`); nothing talks to the host until you call `activate()`.

import './browser.js';

const trove = globalThis.trove;

/**
 * Entry point — call once at the top of your plugin. The host hands your callback
 * a capability-scoped `ctx` (commands, resources, files, db, settings, net, ui).
 * @param {(ctx: object) => (void | Promise<void>)} setup
 * @returns {Promise<object>} the activated context
 */
export const activate = trove.activate;

export default trove;

// The host-side RPC channel — used by the workbench that hosts plugins, not by
// plugins themselves. Re-exported here for convenience/parity with the subpath.
export { RpcChannel } from './rpc.js';

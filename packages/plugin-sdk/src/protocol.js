// The host ↔ plugin wire protocol, in one place.
//
// Envelope (over the transferred MessagePort):
//   { __trove: 'req',   id, method, params }   plugin → host, expects a 'res'
//   { __trove: 'res',   id, result | error }   host → plugin
//   { __trove: 'event', method, params }       either direction, fire-and-forget
// Bootstrap (over postMessage, before the port exists):
//   { __trove: 'ready',      protocolVersion } plugin → host
//   { __trove: 'init',       manifest, capabilities, storage, online, role, protocolVersion }
//   { __trove: 'boot-error', error }           plugin → host (module load failed)
//
// NOTE: browser.js is injected into the sandboxed frame as a TEXT blob (it must be a
// self-contained IIFE with no imports), so it cannot import this module. It declares
// its own `SDK_PROTOCOL_VERSION` constant instead, and protocol.test.js asserts the
// two stay equal — a drift guard in place of an import.

/** Bumped MAJOR when a change breaks older plugins; MINOR for additive changes. */
export const PROTOCOL_VERSION = '1.0';

export function majorOf(version) {
  return String(version || '').split('.')[0] || '0';
}

/** Whether a plugin built against `version` can talk to this host. */
export function isCompatible(version) {
  // An SDK older than versioning itself reports nothing — accept it (it predates the
  // field and the protocol hasn't broken yet); a differing MAJOR is a hard mismatch.
  if (!version) return true;
  return majorOf(version) === majorOf(PROTOCOL_VERSION);
}

/** Canonical host methods a plugin may call. Grouped by namespace. */
export const METHODS = {
  activated: 'activated',
  contribute: {
    command: 'contribute:command',
    opener: 'contribute:opener',
    indexer: 'contribute:indexer',
    statusItem: 'contribute:statusItem',
    keybinding: 'contribute:keybinding',
  },
  // Note: 'command:execute' travels BOTH ways on the same channel — the host calls it
  // to run a plugin-contributed command, and a plugin calls it (needs the `commands`
  // capability) to run a host command. The direction disambiguates.
  command: { execute: 'command:execute' },
  resources: { list: 'resources:list', read: 'resources:read' },
  files: { read: 'files:read', list: 'files:list', stat: 'files:stat', downloadUrl: 'files:downloadUrl', index: 'files:index' },
  net: { fetch: 'net:fetch' },
  storage: { sql: 'storage:sql' },
  settings: { get: 'settings:get', set: 'settings:set', getSecret: 'settings:getSecret' },
  ui: { showPanel: 'ui:showPanel' },
  media: { metadata: 'media:metadata', playbackState: 'media:playbackState', position: 'media:position', action: 'media:action', clear: 'media:clear' },
  dock: { enable: 'dock:enable', disable: 'dock:disable', close: 'dock:close' },
};

/** Events a plugin may emit to the host. */
export const EVENTS = {
  manifest: 'manifest',
  uiToast: 'ui:toast',
  uiBadge: 'ui:badge',
  contextSet: 'context:set',
};

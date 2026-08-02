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

// There are no `contribute:*` methods: contributions are DECLARED IN THE MANIFEST and
// registered by the host before the plugin boots. A plugin can only ever drive what it
// declared (`ui:status`, `context:setRegister`), never add to it.

/** Canonical host methods a plugin may call. Grouped by namespace. */
export const METHODS = {
  activated: 'activated',
  // Note: 'command:execute' travels BOTH ways on the same channel — the host calls it
  // to run a plugin-contributed command, and a plugin calls it (needs that command in
  // its `commands` allowlist) to run someone else's. The direction disambiguates.
  command: { execute: 'command:execute' },
  resources: { list: 'resources:list', read: 'resources:read' },
  files: {
    read: 'files:read', list: 'files:list', stat: 'files:stat', downloadUrl: 'files:downloadUrl',
    index: 'files:index',
    // Bytes by range — the only way a viewer gets binary content at all, since `read`
    // answers text and a sandboxed frame cannot authenticate a bare download URL.
    bytes: 'files:bytes',
    // A minted URL for a media element. See pluginRpc.js for why this one host URL crosses.
    mediaUrl: 'files:mediaUrl',
    // Is the whole file here, and can I have it? The pair a viewer needs because the
    // frame's CSP forbids loading media from a URL — see pluginFrames.js.
    hasLocal: 'files:hasLocal',
    localBlob: 'files:localBlob',
    offline: {
      start: 'files:offline:start', status: 'files:offline:status',
      cancel: 'files:offline:cancel', remove: 'files:offline:remove',
    },
  },
  net: { fetch: 'net:fetch' },
  storage: { sql: 'storage:sql' },
  settings: { get: 'settings:get', set: 'settings:set', getSecret: 'settings:getSecret' },
  ui: { showPanel: 'ui:showPanel', status: 'ui:status' },
  context: { setRegister: 'context:setRegister' },
  media: { metadata: 'media:metadata', playbackState: 'media:playbackState', position: 'media:position', action: 'media:action', clear: 'media:clear' },
  dock: { enable: 'dock:enable', disable: 'dock:disable', close: 'dock:close' },
};

/** Events a plugin may emit to the host (fire-and-forget, no reply). */
export const EVENTS = {
  manifest: 'manifest',
  uiToast: 'ui:toast',
  uiBadge: 'ui:badge',
};

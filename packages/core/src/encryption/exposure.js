// What encryption does not protect you from, said plainly and per collection.
//
// Encryption here defends the BUCKET. Anything that indexes a file sees it in the clear,
// because indexing is by definition reading the contents — the server decrypts before
// handing bytes to an indexer, and that is the whole reason full search still works on an
// encrypted collection. So a badge saying "encrypted" is true and, on its own, misleading.
//
// The disclosure that matters is therefore not about encryption at all. It is: which things
// read your files, which of them are third-party code, and where that code is allowed to
// send what it reads. A built-in indexer runs in this drive and talks to nobody. A plugin
// indexer might be pointed at an external API, and the manifest already says which one.
//
// Read off the manifest rather than written as prose. A sentence in a settings page drifts
// from what a plugin is actually permitted the moment either changes; a list derived from
// the declaration it is enforced against cannot. If it says a plugin may reach one host,
// that is because the plugin may reach exactly that host.

/**
 * @typedef {object} IndexerExposure
 * @property {string} id
 * @property {string} name
 * @property {'built-in'|'plugin'} source
 * @property {string|null} pluginId
 * @property {string[]} endpoints  where this one may send what it reads; empty means nowhere
 */

/**
 * Who reads the files in this collection, and where it can send them.
 *
 * @param {object} deps
 * @param {Array<{id: string, displayName?: string}>} deps.indexers  what will run
 * @param {Array<object>} [deps.plugins]  installed plugin records, with manifests
 * @param {(manifest: object) => string[]} [deps.endpointsOf]  how to read declared egress
 * @param {object|null} [deps.encryption]  the collection's encryption config
 */
export function describeExposure({ indexers = [], plugins = [], endpointsOf = null, encryption = null } = {}) {
  // Defaulting this to `() => []` would have every plugin report "reaches nowhere" whenever
  // a caller forgot to wire it — an affirmative safety claim made with no evidence, which
  // is the same mistake as calling an unresolved plugin built-in. No reader means unknown.
  const readEndpoints = typeof endpointsOf === 'function' ? endpointsOf : null;
  // A plugin indexer's id is a contribution URI — `trove+contrib:<domain>/<name>/<what>` —
  // so the plugin it belongs to is derivable from the id rather than tracked separately.
  const byId = new Map();
  for (const p of plugins) {
    const id = p.id || p.manifest?.name;
    if (id) byId.set(id, p);
  }

  const rows = indexers.map((i) => {
    // Whether something is a plugin is decided by its ID, not by whether we managed to find
    // its install record. An indexer whose plugin we cannot resolve is still third-party
    // code, and calling it built-in would be the most dangerous mislabel available here.
    const contributed = String(i.id || '').startsWith('trove+contrib:');
    const owner = contributed ? pluginOf(i.id, byId) : null;
    return {
      id: i.id,
      name: i.displayName || i.id,
      source: contributed ? 'plugin' : 'built-in',
      pluginId: owner ? (owner.id || owner.manifest?.name || null) : null,
      // `[]` is an affirmative claim that this reaches nowhere. Without a manifest we
      // cannot make it, so an unresolved plugin gets `null` — unknown — and is counted
      // among the things that might send data out rather than among the things that cannot.
      endpoints: owner && readEndpoints ? [...new Set(readEndpoints(owner.manifest) || [])] : (contributed ? null : []),
    };
  });

  const reachOut = rows.filter((r) => r.endpoints === null || r.endpoints.length);
  const unknown = rows.filter((r) => r.endpoints === null);
  return {
    encrypted: !!encryption?.enabled,
    // Said explicitly, because "encrypted" without a scope is the thing people
    // over-read. This is what the encryption is and is not.
    protects: encryption?.enabled
      ? 'Files are encrypted before they reach the storage provider, so the bucket holds ciphertext. '
        + 'It is not end-to-end: this drive holds the key, and anything that indexes a file reads it in the clear.'
      : null,
    indexers: rows,
    // The single fact someone should be able to see without reading a list.
    anyEgress: reachOut.length > 0,
    egressSummary: reachOut.length
      ? `${reachOut.length} of ${rows.length} indexers may send file contents outside this drive.`
        + (unknown.length
          ? ` ${unknown.length} could not be checked, because the plugin that provides it is not installed here.`
          : '')
      : rows.length
        ? 'No indexer on this collection may send file contents anywhere.'
        : 'Nothing indexes this collection.',
  };
}

/** Which installed plugin an indexer id belongs to, if any. */
function pluginOf(indexerId, byId) {
  const id = String(indexerId || '');
  if (!id.startsWith('trove+contrib:')) return null;
  // `trove+contrib:<domain>/<name>/<contribution>` — the plugin is domain/name.
  const path = id.slice('trove+contrib:'.length);
  const parts = path.split('/');
  if (parts.length < 2) return null;
  const owner = `${parts[0]}/${parts[1]}`;
  return byId.get(owner) || byId.get(parts[1]) || null;
}

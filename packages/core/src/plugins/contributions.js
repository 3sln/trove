// What a package contributes — declared in its manifest as ONE map of
// `name -> contribution`, where each contribution states its own `type` and that
// type's options:
//
//   "contributes": {
//     "player":  { "type": "opener",     "title": "Demo Player",
//                  "match": { "ext": [".demo"] }, "entry": "src/openers/player.js" },
//     "pdf":     { "type": "indexer",    "match": { "ext": [".pdf"] }, "entry": "src/indexers/pdf.js" },
//     "tap":     { "type": "command",    "title": "Demo: Tap" },
//     "status":  { "type": "statusItem", "slot": "right" },
//     "busy":    { "type": "register",   "default": false },
//     "keys":    { "type": "keymap",     "path": "keymaps/default.json" }
//   }
//
// One map, not a collection per kind, because the kinds never needed separate
// namespaces — they needed a shared one. Here "status" is a single name under this
// plugin, so its status item, its register and its command can't shadow each other,
// and `trove+contrib:acme.com/docs/status` names exactly one thing in the world.
//
// Each contribution's `entry` (openers, indexers) points into the plugin's ONE module
// tree — they are not nested sub-packages, so everything in a plugin shares modules
// and code. What gets opened or indexed depends only on which entry module runs.

import { TroveError } from '../errors.js';
import { contribUri, isValidName, pluginId } from './identity.js';

/** Every contribution type a package may declare, with how its options are normalized. */
const TYPES = {
  // A command in the palette. Its handler lives in the plugin's primary frame.
  command: {
    normalize: (c) => ({
      title: c.title || null, category: c.category || null, icon: c.icon || null,
      when: c.when || null, palette: c.palette !== false, offline: !!c.offline,
    }),
  },
  // A viewer for matching files, rendered by `entry` in its own sandboxed frame.
  opener: {
    needsEntry: true,
    normalize: (c) => ({
      title: c.title || null, match: normalizeMatch(c.match), priority: c.priority ?? 50,
      when: c.when || null, offline: !!c.offline, dock: c.dock || null,
    }),
  },
  // Indexes matching files. ALWAYS runs on the server (see serverIndexers).
  indexer: {
    needsEntry: true,
    normalize: (c) => ({ title: c.title || null, match: normalizeMatch(c.match) }),
  },
  // A slot in the status bar. The plugin pushes content into it at runtime; for now
  // the only content type is sanitized HTML.
  statusItem: {
    normalize: (c) => {
      const slot = c.slot === 'left' ? 'left' : 'right';
      const render = c.render || 'html';
      if (render !== 'html') throw TroveError.invalid(`statusItem "render" must be "html" (got ${JSON.stringify(render)})`);
      return { slot, render, order: c.order ?? 0, when: c.when || null, offline: !!c.offline, command: c.command || null };
    },
  },
  // A context value slot the plugin drives at runtime, referenceable from when-clauses
  // in keymaps, commands and other contributions (the equivalent of a VS Code context key).
  register: {
    normalize: (c) => ({ default: c.default ?? null, description: c.description || null }),
  },
  // A keymap JSON file in the package: [{ key, command, when?, args? }, …].
  keymap: {
    normalize: (c) => {
      if (!c.path || typeof c.path !== 'string') throw TroveError.invalid('keymap contribution needs a "path" to a JSON file in the package');
      return { path: c.path };
    },
  },
};

export const CONTRIBUTION_TYPES = Object.keys(TYPES);

/**
 * Every contribution a manifest declares, normalized and addressed by URI.
 * Throws INVALID on a malformed declaration — a package that lies about what it
 * contributes must not install, because the install review is what the user approved.
 * @returns {Array<{name:string, uri:string, type:string, entry?:string}>}
 */
export function declaredContributions(manifest) {
  const map = manifest?.contributes;
  if (map == null) return [];
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw TroveError.invalid('manifest "contributes" must be a map of name -> contribution');
  }
  const out = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object') throw TroveError.invalid(`Contribution "${name}" must be an object`);
    if (!isValidName(name)) throw TroveError.invalid(`Invalid contribution name "${name}"`);
    const spec = TYPES[raw.type];
    if (!spec) {
      throw TroveError.invalid(`Contribution "${name}" has unknown type ${JSON.stringify(raw.type)} (expected one of ${CONTRIBUTION_TYPES.join(', ')})`);
    }
    const entry = raw.entry || manifest.entry;
    if (spec.needsEntry && !entry) throw TroveError.invalid(`Contribution "${name}" (${raw.type}) needs an "entry" module`);
    out.push({
      name,
      uri: contribUri(manifest, name),
      pluginId: pluginId(manifest),
      type: raw.type,
      ...spec.normalize(raw),
      ...(spec.needsEntry ? { entry } : {}),
    });
  }
  return out;
}

/** Just the declared contributions of one type. */
export function contributionsOfType(manifest, type) {
  return declaredContributions(manifest).filter((c) => c.type === type);
}

/**
 * The indexers the server will run. Indexing is a property of the DRIVE, not of
 * whoever happens to have a tab open: it must happen once per upload regardless of
 * which client did the uploading, so an indexer contribution is always server-side.
 * (Not to be confused with the `indexer` capability, which lets a plugin push its own
 * contributions for a node it's looking at — that one is a client action.)
 */
export function serverIndexers(manifest) {
  return contributionsOfType(manifest, 'indexer').map((i) => ({
    id: i.uri, name: i.name, title: i.title || i.name, match: i.match, entry: i.entry,
  }));
}

/** Openers a package declares, each pointing at the entry module that renders it. */
export function declaredOpeners(manifest) {
  return contributionsOfType(manifest, 'opener');
}

/**
 * Parse a keymap file's contents: a JSON array of `{ key, command, when?, args? }`
 * (an object with a `bindings` array is also accepted). Entries missing a key or a
 * command are dropped rather than failing the whole map — one bad line shouldn't cost
 * a plugin every other shortcut it ships.
 */
export function parseKeymap(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw TroveError.invalid('Keymap file is not valid JSON', { cause: err });
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.bindings) ? doc.bindings : null;
  if (!list) throw TroveError.invalid('Keymap file must be a JSON array of bindings');
  return list
    .filter((b) => b && typeof b.key === 'string' && typeof b.command === 'string')
    .map((b) => ({
      key: b.key, command: b.command,
      when: typeof b.when === 'string' ? b.when : null,
      args: Array.isArray(b.args) ? b.args : undefined,
    }));
}

/**
 * A file-match selector, coerced into the shape `selectorMatches` actually indexes.
 *
 * It was passed through verbatim, so `"match": { "ext": ".demo" }` — a string where an
 * array belongs, which no validation rejected — installed cleanly and then threw
 * `(selector.ext || []).some is not a function` at selection time. Server-side the
 * throw was swallowed, so the plugin backfilled nothing and indexed nothing with no
 * error anywhere; in the browser `openersFor` is unguarded, so ONE bad declaration
 * broke opener selection for every file in the drive.
 */
function normalizeMatch(match) {
  if (!match || typeof match !== 'object' || Array.isArray(match)) return {};
  const list = (v) => (v == null ? undefined : (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string'));
  const out = {};
  const ext = list(match.ext);
  const mime = list(match.mime ?? match.contentType);
  if (ext) out.ext = ext;
  if (mime) out.mime = mime;
  // A `match` function can only come from in-process code, never from a manifest.
  if (typeof match.match === 'function') out.match = match.match;
  return out;
}

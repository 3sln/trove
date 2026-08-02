// One place that knows how to classify a file by type — extension extraction and a
// single format table. Previously the ext/mime lists were re-derived (and drifted)
// across openers.extOf, contributions.matchesSelector, iconForNode, and offline.isTexty;
// now the icon shown, the "is this text?" decision, and the type label all agree.

/** The extension (".pdf") for a node, lowercased, or '' if none. */
export function extOf(node) {
  const name = (node?.name || '').toLowerCase();
  return name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
}

// Category → { mime: prefixes/exact it matches, ext: extensions }. Order matters:
// kindOf checks these top-down.
const CATEGORIES = [
  { kind: 'audio', icon: 'file-audio', mime: ['audio/'], ext: ['.mp3', '.flac', '.wav', '.opus', '.ogg', '.m4a', '.m4b'] },
  { kind: 'image', icon: 'file-image', mime: ['image/'], ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'] },
  { kind: 'video', icon: 'file-video', mime: ['video/'], ext: ['.mp4', '.webm', '.mkv', '.mov'] },
  {
    kind: 'text', icon: 'file-text', mime: ['text/', 'application/json'],
    ext: ['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.ts', '.jsx', '.tsx', '.css', '.html',
      '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.csv', '.py', '.rb', '.go', '.rs', '.sh', '.c', '.h', '.cpp', '.java'],
  },
];

function matchesCategory(cat, ext, ct) {
  if (cat.ext.includes(ext)) return true;
  // A mime entry ending in '/' is a prefix (audio/), otherwise an exact type.
  return cat.mime.some((m) => (m.endsWith('/') ? ct.startsWith(m) : ct === m));
}

/** Classify an item → 'audio'|'image'|'video'|'text'|'file'. */
export function kindOf(node) {
  const ext = extOf(node);
  const ct = node?.contentType || '';
  for (const cat of CATEGORIES) if (matchesCategory(cat, ext, ct)) return cat.kind;
  return 'file';
}

const ICONS = { ...Object.fromEntries(CATEGORIES.map((c) => [c.kind, c.icon])), file: 'file' };

/** The icon name for a node, derived from its kind. */
export function iconForKind(node) {
  return ICONS[kindOf(node)] || 'file';
}

/**
 * The key an indexer writes a tile picture under, and the ONE key the grid looks for.
 *
 * A preset name rather than a per-plugin registration, because a thumbnail is not a
 * contribution TYPE — it is a fact about a file that any indexer may happen to know. The
 * audiobook plugin extracts cover art from an m4b's `covr` atom and an LPF's manifest;
 * a PDF indexer could write its first page under the same key and the grid would draw it
 * with no change here.
 *
 * @see plugins/audiobook/src/coverIndexer.js
 */
export const THUMBNAIL_KEY = 'thumbnail';

/**
 * A picture to put on this node's tile, or null.
 *
 * Contributions are namespaced by contributor, and a view deliberately does not care WHICH
 * one supplied it: the first that did wins, and a drive with two thumbnail indexers for one
 * file type has a configuration problem rather than a rendering one.
 *
 * TWO SHAPES, because a thumbnail is either already somewhere or it is not:
 *
 *   { range: {start, end}, contentType }  the bytes live in the FILE — an m4b's cover art
 *                                         sits in its `covr` atom — so the contribution
 *                                         points at them. Eighty bytes on the wire instead
 *                                         of a base64 copy on every listing.
 *   { src }                               a self-contained URL, for the cases with nothing
 *                                         to point at. Small by construction; see the
 *                                         indexer's cap.
 *
 * @returns {{range?: {start: number, end: number}, src?: string, contentType?: string}|null}
 */
export function thumbnailOf(node) {
  // ALREADY RESOLVED, which is how a recents entry carries one. Recents are a snapshot in
  // localStorage rather than a reference — nothing re-reads the node — so the descriptor
  // is stored on the entry itself and this is where it comes back in. Same shape, so a
  // view cannot tell the two apart, which is the point.
  const stored = node?.thumbnail;
  if (typeof stored?.src === 'string' && stored.src) return stored;
  if (Number.isFinite(stored?.range?.start) && Number.isFinite(stored?.range?.end)) return stored;

  const contributions = node?.contributions;
  if (!contributions) return null;
  for (const contribution of Object.values(contributions)) {
    const thumb = contribution?.metadata?.[THUMBNAIL_KEY];
    if (typeof thumb?.src === 'string' && thumb.src) return thumb;
    if (Number.isFinite(thumb?.range?.start) && Number.isFinite(thumb?.range?.end)) return thumb;
  }
  return null;
}

/** Whether a node holds indexable text (drives offline text extraction). */
export function isTexty(node) {
  return kindOf(node) === 'text';
}

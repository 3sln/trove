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
// kindOf checks these top-down, so audiobook wins over the generic audio player for
// an .m4a (both match its audio/mp4 mime).
const CATEGORIES = [
  { kind: 'audiobook', icon: 'book', mime: ['audio/x-m4b'], ext: ['.m4b', '.m4a'] },
  { kind: 'audio', icon: 'file-audio', mime: ['audio/'], ext: ['.mp3', '.flac', '.wav', '.opus', '.ogg'] },
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

/** Classify an item → 'audiobook'|'audio'|'image'|'video'|'text'|'file'. */
export function kindOf(node) {
  const ext = extOf(node);
  const ct = node?.contentType || '';
  if (/audiobook/.test((node?.name || '').toLowerCase())) return 'audiobook';
  for (const cat of CATEGORIES) if (matchesCategory(cat, ext, ct)) return cat.kind;
  return 'file';
}

const ICONS = { ...Object.fromEntries(CATEGORIES.map((c) => [c.kind, c.icon])), file: 'file' };

/** The icon name for a node, derived from its kind. */
export function iconForKind(node) {
  return ICONS[kindOf(node)] || 'file';
}

/** Whether a node holds indexable text (drives offline text extraction). */
export function isTexty(node) {
  return kindOf(node) === 'text';
}

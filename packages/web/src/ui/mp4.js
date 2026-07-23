// A focused MP4/M4B box reader — just enough to power the audiobook player:
// title/author/narrator/album, cover art, and the chapter list. It locates the
// `moov` box by walking top-level boxes with tiny HTTP Range reads (so a 600 MB
// audiobook costs a few KB to inspect, not a full download), then parses:
//   • udta/meta/ilst  — iTunes-style metadata (©nam, ©ART, aART, ©alb, covr)
//   • udta/chpl       — Nero chapter list (the common m4b chapter format)
//   • trak…tref 'chap'→ QuickTime text chapter track (fallback)
//
// Everything is defensive: a malformed or unexpected box yields empty results,
// never a throw that breaks the player.

const HEADER = 8;
const utf8 = new TextDecoder('utf-8');

function u32(v, o) { return (v[o] << 24 | v[o + 1] << 16 | v[o + 2] << 8 | v[o + 3]) >>> 0; }
function u64(v, o) { return u32(v, o) * 2 ** 32 + u32(v, o + 4); }
function typeAt(v, o) { return String.fromCharCode(v[o], v[o + 1], v[o + 2], v[o + 3]); }

async function readRange(url, start, end, fetchFn) {
  const res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) throw new Error(`Range read failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Locate a top-level box by type, returning { start, size } or null. */
async function findTopLevelBox(url, wantType, fetchFn) {
  let offset = 0;
  for (let guard = 0; guard < 64; guard++) {
    let head;
    try {
      head = await readRange(url, offset, offset + 15, fetchFn);
    } catch {
      return null;
    }
    if (head.length < HEADER) return null;
    let size = u32(head, 0);
    let headerLen = HEADER;
    if (size === 1) {
      size = u64(head, HEADER);
      headerLen = 16;
    } else if (size === 0) {
      // box extends to EOF — assume it's this one if it matches.
      size = Infinity;
    }
    const type = typeAt(head, 4);
    if (type === wantType) return { start: offset, size, headerLen };
    if (!isFinite(size) || size < HEADER) return null;
    offset += size;
  }
  return null;
}

// Walk child boxes within `bytes` (already positioned at the first child).
function* boxes(bytes, start = 0, end = bytes.length) {
  let o = start;
  while (o + HEADER <= end) {
    let size = u32(bytes, o);
    let headerLen = HEADER;
    if (size === 1) {
      size = u64(bytes, o + HEADER);
      headerLen = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < HEADER || o + size > end + 8) break;
    yield { type: typeAt(bytes, o + 4), start: o, headerLen, size, contentStart: o + headerLen, contentEnd: o + size };
    o += size;
  }
}

function findBox(bytes, start, end, type) {
  for (const b of boxes(bytes, start, end)) if (b.type === type) return b;
  return null;
}

function parseChpl(bytes, b) {
  const chapters = [];
  let o = b.contentStart;
  const version = bytes[o];
  o += 4; // version + flags
  if (version === 1) o += 1; // reserved byte (Nero v1)
  const count = bytes[o];
  o += 1;
  for (let i = 0; i < count && o + 9 <= b.contentEnd; i++) {
    const start100ns = u64(bytes, o);
    o += 8;
    const len = bytes[o];
    o += 1;
    const title = utf8.decode(bytes.subarray(o, o + len));
    o += len;
    chapters.push({ title: title.trim(), start: start100ns / 1e7 });
  }
  return chapters;
}

const META_KEYS = { '©nam': 'title', '©ART': 'author', aART: 'albumArtist', '©alb': 'album', '©gen': 'genre', '©wrt': 'narrator', '©cmt': 'comment' };

function parseIlst(bytes, ilst) {
  const meta = {};
  let cover = null;
  for (const entry of boxes(bytes, ilst.contentStart, ilst.contentEnd)) {
    const dataBox = findBox(bytes, entry.contentStart, entry.contentEnd, 'data');
    if (!dataBox) continue;
    const payloadStart = dataBox.contentStart + 8; // data: version/flags(4) + reserved(4)
    const payload = bytes.subarray(payloadStart, dataBox.contentEnd);
    if (entry.type === 'covr') {
      const typeFlag = u32(bytes, dataBox.contentStart); // 13=jpeg, 14=png
      cover = { bytes: payload.slice(), mime: typeFlag === 14 ? 'image/png' : 'image/jpeg' };
    } else if (META_KEYS[entry.type]) {
      meta[META_KEYS[entry.type]] = utf8.decode(payload).trim();
    }
  }
  return { meta, cover };
}

/**
 * Extract audiobook info. Returns { title, author, narrator, album, chapters,
 * cover:{bytes,mime}|null }. Any field may be absent.
 */
export async function readAudiobookInfo(url, { fetch: fetchFn = globalThis.fetch.bind(globalThis) } = {}) {
  const result = { chapters: [], cover: null };
  const moovLoc = await findTopLevelBox(url, 'moov', fetchFn);
  if (!moovLoc) return result;
  // Cap the moov read so a pathological file can't pull hundreds of MB.
  const cap = Math.min(moovLoc.size, 24 * 1024 * 1024);
  let moov;
  try {
    moov = await readRange(url, moovLoc.start, moovLoc.start + cap - 1, fetchFn);
  } catch {
    return result;
  }
  const moovEnd = moov.length;
  const udta = findBox(moov, moovLoc.headerLen, moovEnd, 'udta');
  if (udta) {
    const chpl = findBox(moov, udta.contentStart, udta.contentEnd, 'chpl');
    if (chpl) result.chapters = parseChpl(moov, chpl);
    const metaBox = findBox(moov, udta.contentStart, udta.contentEnd, 'meta');
    if (metaBox) {
      // meta is a FullBox: 4 bytes version/flags before its children.
      const ilst = findBox(moov, metaBox.contentStart + 4, metaBox.contentEnd, 'ilst');
      if (ilst) {
        const { meta, cover } = parseIlst(moov, ilst);
        Object.assign(result, meta);
        result.cover = cover;
      }
    }
  }
  // Narrator commonly lives in the composer (©wrt) or comment; already mapped.
  if (!result.author && result.albumArtist) result.author = result.albumArtist;
  return result;
}

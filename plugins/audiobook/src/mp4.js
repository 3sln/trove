// Reading an MP4/M4B without decoding it.
//
// Pure and byte-oriented on purpose: everything here takes bytes and returns data, so it
// can be tested against real files with no browser, no drive and no plugin around it. What
// it does NOT do is decode audio — the browser does that; this only finds where things are.
//
// An MP4 is a tree of boxes. Each box is a 4-byte big-endian size, a 4-byte type, then its
// payload, and its size includes the header — so the next box's offset is known from the
// current one and the chain can be walked 8 or 16 bytes at a time without ever reading a
// payload. Two encodings complicate that and both appear in the wild:
//
//   size === 1  the real size is a 64-bit `largesize` in the next 8 bytes (a 16-byte
//               header). Any `mdat` over 4 GiB uses this, which is most long audiobooks.
//   size === 0  the box runs to the end of the file. Legal, and the last box only.
//
// The two things a player needs from this file are `moov` (where the sample tables live,
// which is what makes time → byte mapping possible) and the chapter list. Both are found by
// walking, never by scanning — except for one deliberate fallback, which validates what it
// finds precisely because a scan can otherwise return garbage that happens to spell 'moov'.

const HEADER = 8;
const LARGE_HEADER = 16;

const u32 = (b, at) => (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) >>> 0;
const type = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
// 64-bit sizes exceed Number.MAX_SAFE_INTEGER only above 8 EiB, so a Number is exact here
// and avoids making every caller deal in BigInt for a value they will use as an offset.
const u64 = (b, at) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

/**
 * The box header at `at`, or null if there are not enough bytes to read one.
 *
 * `size` is the WHOLE box including its header, which is what makes `at + size` the next
 * box. `toEnd` says the size was the to-EOF form and the caller has to supply the end.
 */
export function readHeader(bytes, at = 0) {
  if (at + HEADER > bytes.length) return null;
  const size = u32(bytes, at);
  const name = type(bytes, at + 4);
  if (size === 1) {
    if (at + LARGE_HEADER > bytes.length) return null;
    return { type: name, size: u64(bytes, at + 8), header: LARGE_HEADER, toEnd: false };
  }
  if (size === 0) return { type: name, size: 0, header: HEADER, toEnd: true };
  // A size smaller than its own header is not a box; treating it as one makes the walk
  // loop forever on a byte offset that never advances.
  if (size < HEADER) return null;
  return { type: name, size, header: HEADER, toEnd: false };
}

/** Whether `name` is four printable ASCII characters — the cheap sanity check on a box. */
export const plausibleType = (name) => /^[\x20-\x7e]{4}$/.test(name);

/**
 * Walk the top-level boxes of a whole buffer.
 *
 * For a buffer that IS the file, or a window known to start on a box boundary.
 * @returns {Array<{type: string, offset: number, size: number, header: number}>}
 */
export function topLevelBoxes(bytes, { base = 0, end = bytes.length } = {}) {
  const out = [];
  let at = 0;
  while (at + HEADER <= end) {
    const h = readHeader(bytes, at);
    if (!h || !plausibleType(h.type)) break;
    const size = h.toEnd ? end - at : h.size;
    out.push({ type: h.type, offset: base + at, size, header: h.header });
    if (size <= 0) break;
    at += size;
  }
  return out;
}

/**
 * Find `moov` in a file we can only read pieces of.
 *
 * The whole point of the exercise: whether `moov` can be located is what decides whether a
 * book can be played at all before it has been fully downloaded, so this runs first and its
 * answer drives the UI.
 *
 * Cheap by construction. Read a head window and a tail window, then walk the chain — each
 * box states its own size, so the next header's offset is known and can be fetched 16 bytes
 * at a time. Most files answer from the two windows alone, because `moov` is either at the
 * front (faststart, written that way for streaming) or at the very back (written by an
 * encoder that did not know the final size until it finished).
 *
 * `read(start, end)` is half-open and may return fewer bytes than asked for.
 *
 * @returns {Promise<{found: boolean, offset?: number, size?: number, faststart?: boolean, via?: string}>}
 */
export async function findMoov(read, total, { window = 64 * 1024 } = {}) {
  const head = await read(0, Math.min(window, total));
  // Not an MP4 at all: the first box of one is `ftyp` in every file anyone will meet, and
  // saying so here is better than walking a JPEG until the chain happens to break.
  const first = readHeader(head, 0);
  if (!first || !plausibleType(first.type)) return { found: false };

  let at = 0;
  let mdatSeen = false;
  // A cursor over the file, reading only headers. `guard` bounds it: a file whose chain is
  // subtly wrong should give up rather than issue a request per byte.
  for (let guard = 0; guard < 4096 && at + HEADER <= total; guard++) {
    const bytes = at < head.length - LARGE_HEADER
      ? head.subarray(at)
      : await read(at, Math.min(at + LARGE_HEADER, total));
    const h = readHeader(bytes, 0);
    if (!h || !plausibleType(h.type)) break;
    if (h.type === 'moov') {
      const size = h.toEnd ? total - at : h.size;
      return { found: true, offset: at, size, faststart: !mdatSeen, via: 'chain' };
    }
    if (h.type === 'mdat') mdatSeen = true;
    const size = h.toEnd ? total - at : h.size;
    if (size <= 0) break;
    at += size;
  }

  // The chain broke. Scan the TAIL, because a non-faststart file puts `moov` at the end and
  // that is the case worth rescuing — and validate every candidate, because four bytes
  // spelling 'moov' inside compressed audio is not rare over hundreds of megabytes.
  const tailStart = Math.max(0, total - window);
  const tail = await read(tailStart, total);
  for (let i = 0; i + HEADER <= tail.length; i++) {
    if (type(tail, i + 4) !== 'moov') continue;
    const h = readHeader(tail, i);
    if (!h) continue;
    const size = h.toEnd ? total - (tailStart + i) : h.size;
    // The validation that makes a scan trustworthy: a real box's size lands exactly on the
    // end of the file, or on another box header. Garbage does neither.
    const endsAt = tailStart + i + size;
    if (endsAt === total) return { found: true, offset: tailStart + i, size, faststart: false, via: 'tail-scan' };
    const nextAt = endsAt - tailStart;
    if (nextAt >= 0 && nextAt + HEADER <= tail.length && plausibleType(type(tail, nextAt + 4))) {
      return { found: true, offset: tailStart + i, size, faststart: false, via: 'tail-scan' };
    }
  }
  return { found: false };
}

/** Depth-first search for the first box of `path` (e.g. ['moov','udta','chpl']). */
export function findBox(bytes, path, { at = 0, end = bytes.length } = {}) {
  if (!path.length) return { offset: at, end };
  const [want, ...rest] = path;
  let cursor = at;
  while (cursor + HEADER <= end) {
    const h = readHeader(bytes, cursor);
    if (!h || !plausibleType(h.type)) return null;
    const size = h.toEnd ? end - cursor : h.size;
    if (h.type === want) {
      const inner = { at: cursor + h.header, end: cursor + size };
      return rest.length ? findBox(bytes, rest, inner) : { offset: inner.at, end: inner.end };
    }
    if (size <= 0) return null;
    cursor += size;
  }
  return null;
}

/**
 * The timescale from `moov/mvhd` — ticks per second, which every duration here is in.
 *
 * Without it a chapter list is a list of numbers with no unit. 600 and 1000 are both
 * common and they differ by a factor of 1.67, so guessing is not an option.
 */
export function movieTimescale(moov) {
  const mvhd = findBox(moov, ['mvhd']);
  if (!mvhd) return null;
  const version = moov[mvhd.offset];
  // v0 packs creation/modification/timescale/duration as 32-bit; v1 as 64/64/32/64. The
  // timescale sits after the two times either way.
  const at = mvhd.offset + 4 + (version === 1 ? 16 : 8);
  return at + 4 <= mvhd.end ? u32(moov, at) : null;
}

/**
 * Chapters from a Nero `chpl` box — the form almost every m4b in the wild uses.
 *
 * Layout: a version/flags word, a count, then per chapter a 64-bit start in 100-nanosecond
 * units (NOT the movie timescale — `chpl` predates being part of this file and carries its
 * own unit) and a length-prefixed UTF-8 title.
 *
 * @returns {Array<{time: number, title: string}>|null} times in SECONDS
 */
export function chaptersFromChpl(moov) {
  const chpl = findBox(moov, ['udta', 'chpl']);
  if (!chpl) return null;
  let at = chpl.offset + 4; // version + flags
  // Some writers emit a reserved byte before the count and some do not; the count is a
  // 32-bit value either way, and a sane one is small, so the shape is decidable.
  let count = u32(moov, at);
  if (count > 0xffff && at + 5 <= chpl.end) { at += 1; count = u32(moov, at); }
  at += 4;
  const out = [];
  for (let i = 0; i < count && at + 9 <= chpl.end; i++) {
    const ticks = u64(moov, at);
    at += 8;
    const len = moov[at];
    at += 1;
    if (at + len > chpl.end) break;
    out.push({ time: ticks / 10_000_000, title: new TextDecoder().decode(moov.subarray(at, at + len)) });
    at += len;
  }
  return out.length ? out : null;
}

/**
 * Chapters from a text TRACK — the QuickTime form, and the fallback when there is no
 * `chpl`.
 *
 * A chapter track is a `trak` whose handler is `text`; its `stts` gives each sample's
 * duration in the track's own timescale and its `stsz`/`stco` say where the titles are. We
 * read the TIMES here and the titles are read separately, because the titles live in `mdat`
 * — outside `moov` — and fetching them is a second range read the caller may not want.
 *
 * @returns {Array<{time: number, offset: number, length: number}>|null}
 */
export function chapterTrack(moov) {
  let cursor = 0;
  while (cursor + HEADER <= moov.length) {
    const h = readHeader(moov, cursor);
    if (!h || !plausibleType(h.type)) break;
    const size = h.toEnd ? moov.length - cursor : h.size;
    if (h.type === 'trak') {
      const track = { at: cursor + h.header, end: cursor + size };
      const hdlr = findBox(moov, ['mdia', 'hdlr'], track);
      // The handler type sits 8 bytes in: version/flags, then a 4-byte predefined field.
      if (hdlr && type(moov, hdlr.offset + 8) === 'text') {
        const times = sampleTimes(moov, track);
        if (times) return times;
      }
    }
    if (size <= 0) break;
    cursor += size;
  }
  return null;
}

/** `stts` + `stsz` + `stco` for one track, as `{time, offset, length}` per sample. */
function sampleTimes(moov, track) {
  const mdhd = findBox(moov, ['mdia', 'mdhd'], track);
  const stts = findBox(moov, ['mdia', 'minf', 'stbl', 'stts'], track);
  const stsz = findBox(moov, ['mdia', 'minf', 'stbl', 'stsz'], track);
  const stco = findBox(moov, ['mdia', 'minf', 'stbl', 'stco'], track);
  if (!mdhd || !stts || !stsz || !stco) return null;

  const version = moov[mdhd.offset];
  const timescale = u32(moov, mdhd.offset + 4 + (version === 1 ? 16 : 8));
  if (!timescale) return null;

  // stts is run-length encoded: (count, delta) pairs.
  const runs = u32(moov, stts.offset + 4);
  const starts = [];
  let t = 0;
  for (let i = 0; i < runs; i++) {
    const at = stts.offset + 8 + i * 8;
    if (at + 8 > stts.end) break;
    const n = u32(moov, at);
    const delta = u32(moov, at + 4);
    for (let k = 0; k < n; k++) { starts.push(t / timescale); t += delta; }
  }

  // A single `sampleSize` for every sample, or a per-sample table when it is zero.
  const fixed = u32(moov, stsz.offset + 4);
  const count = u32(moov, stsz.offset + 8);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    sizes.push(fixed || u32(moov, stsz.offset + 12 + i * 4));
  }
  // One chunk per sample is the shape every chapter track uses, which is what lets an
  // offset come straight from `stco` without walking `stsc`.
  const chunks = u32(moov, stco.offset + 4);
  const offsets = [];
  for (let i = 0; i < chunks; i++) offsets.push(u32(moov, stco.offset + 8 + i * 4));

  const n = Math.min(starts.length, sizes.length, offsets.length);
  if (!n) return null;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: starts[i], offset: offsets[i], length: sizes[i] });
  return out;
}

/**
 * A chapter-track sample's title.
 *
 * The payload is a 16-bit length followed by the text, optionally with encoding atoms
 * after it that are not ours to interpret.
 */
export function chapterTitle(bytes) {
  if (bytes.length < 2) return '';
  const len = Math.min((bytes[0] << 8) | bytes[1], bytes.length - 2);
  return new TextDecoder().decode(bytes.subarray(2, 2 + len));
}

/** The book's total duration in seconds, from `moov/mvhd`. */
export function movieDuration(moov) {
  const mvhd = findBox(moov, ['mvhd']);
  if (!mvhd) return null;
  const version = moov[mvhd.offset];
  const scale = movieTimescale(moov);
  if (!scale) return null;
  const at = mvhd.offset + 4 + (version === 1 ? 16 : 8) + 4;
  const ticks = version === 1 ? u64(moov, at) : u32(moov, at);
  return ticks / scale;
}

/**
 * `©nam`, `©ART`, `©alb` and friends from `moov/udta/meta/ilst`.
 *
 * Enough for a lock screen: a title, an author, a series. The four-character keys begin
 * with a copyright sign in the QuickTime convention, which is why they are matched by byte
 * rather than by an ASCII string.
 */
export function metadataFrom(moov) {
  const ilst = findBox(moov, ['udta', 'meta', 'ilst']);
  // `meta` is a full box — version/flags before its children — so a direct descent lands
  // four bytes early. Retry from there rather than giving up.
  const box = ilst || (() => {
    const meta = findBox(moov, ['udta', 'meta']);
    return meta ? findBox(moov, ['ilst'], { at: meta.offset + 4, end: meta.end }) : null;
  })();
  if (!box) return {};

  const WANT = { '\xa9nam': 'title', '\xa9ART': 'author', '\xa9alb': 'album', 'aART': 'author', '\xa9gen': 'genre' };
  const out = {};
  let at = box.offset;
  while (at + HEADER <= box.end) {
    const h = readHeader(moov, at);
    if (!h) break;
    const size = h.toEnd ? box.end - at : h.size;
    const field = WANT[h.type];
    if (field && !out[field]) {
      // Each item holds a `data` box: version/flags, then 4 reserved bytes, then the value.
      const data = findBox(moov, ['data'], { at: at + h.header, end: at + size });
      if (data) out[field] = new TextDecoder().decode(moov.subarray(data.offset + 8, data.end)).trim();
    }
    if (size <= 0) break;
    at += size;
  }
  return out;
}

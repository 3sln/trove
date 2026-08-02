// Everything the drive can know about a book, as an indexer contribution.
//
// Runs on the SERVER, once per upload, in the isolate runtime — not in a viewer's tab. That
// is the whole reason it is an indexer: a cover has to be found once for the drive, not
// recomputed in whichever browser happens to open the grid. It is plain ESM exporting
// `index(node, ctx)` and does not use the plugin SDK at all.
//
// It reads BY RANGE and never pulls the book through memory. An m4b keeps its metadata,
// cover and chapter list in structures at the END of the file — `moov` last, `udta` last
// inside it — and an LPF keeps them in a manifest named by a central directory that is also
// last. A few small reads out of hundreds of megabytes.
//
// WHY EVERYTHING RATHER THAN JUST THE COVER: the alternative is the viewer parsing the
// container every time somebody opens a book, which is the same work repeated per reader
// per session for an answer that cannot change while the bytes do not. Indexed once, the
// player opens a book with no reads at all — and the title, author, narrator and series
// become `tags`, which is what makes them filterable from the launcher.
//
// WHAT IT EMITS is one known key, `metadata.thumbnail`, which the grid recognises — and it
// POINTS at the cover rather than copying it. Contributions ride along on every list
// response, and a real Audible cover is ~57 KiB, which is ~78 KiB once base64'd: carried
// inline, a page of fifty audiobooks would put four megabytes of pictures on the wire
// whether or not anything drew them. The cover is already sitting contiguously in the file,
// so `{ range }` costs eighty bytes and the grid fetches the bytes for the tiles actually
// on screen.
//
// A data: URL is still emitted where there is nothing to point at — an LPF whose cover is
// deflated inside the zip, where the stored bytes are not the image — and only under a hard
// cap, because that is the case where the size genuinely rides along.

import { findMoov, findChildRanged, coverFrom, metadataFrom, chaptersRanged } from './mp4.js';
import { centralDirectory, readEntry, locateEntry, entryFor } from './zip.js';
import { parsePublication, chaptersFrom, manifestEntry, resolveHref } from './lpf.js';

/**
 * The cap on a cover that must be CARRIED rather than pointed at.
 *
 * Only the inline path pays this, so it is deliberately small: an image that has to ride
 * on every list response is worth a tile only while it is tiny. Nothing here can re-encode
 * a larger one — there is no decoder in an indexer isolate — so an oversized cover is
 * skipped rather than shrunk, which is the honest half of a resize we cannot do.
 */
const MAX_INLINE_BYTES = 24 * 1024;

/** A pointed-at cover is bounded too: past this it is a master, not a thumbnail. */
const MAX_COVER_BYTES = 4 * 1024 * 1024;

/** Past this a chapter list is not a table of contents, and the viewer can parse it. */
const MAX_CHAPTERS = 500;

/** How much of the head and tail to look at while hunting for structure. */
const WINDOW = 64 * 1024;

const isLpf = (node) => /\.lpf$/i.test(node.name || '') || (node.contentType || '').includes('lpf');

export async function index(node, ctx) {
  if (!node?.size || !ctx?.readRange) return {};
  try {
    const found = isLpf(node) ? await fromLpf(node, ctx) : await fromMp4(node, ctx);
    if (!found) return {};
    const { cover, book, chapters } = found;

    const metadata = {};
    if (cover) {
      // The key the grid knows. An object, not a bare string, because it carries one of two
      // shapes — a range to fetch or bytes to draw — and a reader that only understands one
      // of them should be able to tell which it has.
      metadata.thumbnail = cover.range
        ? { range: cover.range, contentType: cover.contentType }
        : { src: dataUrl(cover.bytes, cover.contentType), contentType: cover.contentType };
    }
    const cleaned = Object.fromEntries(Object.entries(book || {}).filter(([, v]) => v != null && v !== ''));
    if (Object.keys(cleaned).length) metadata.book = cleaned;
    // Chapters ride on list responses like everything else here, so a book with a chapter
    // per paragraph is left to the viewer to parse rather than carried for every listing.
    // Sixty-four chapters is about three kilobytes; two thousand is not a table of contents.
    if (chapters?.length && chapters.length <= MAX_CHAPTERS) metadata.chapters = chapters;

    // TAGS, not just metadata: tags are the queryable half, merged into the item's tag view,
    // so an author or a narrator becomes something the launcher can filter on. Metadata is
    // what the player reads; tags are what a person searches.
    const tags = {};
    for (const key of ['author', 'narrator', 'series', 'genre', 'publisher', 'year', 'language']) {
      if (cleaned[key]) tags[key] = String(cleaned[key]);
    }

    return Object.keys(metadata).length || Object.keys(tags).length
      ? { metadata, ...(Object.keys(tags).length ? { tags } : {}) }
      : {};
  } catch {
    // A book whose cover cannot be read is still a book. An indexer that threw would mark
    // the whole node as failed and raise a standing issue about a missing picture.
    return {};
  }
}

export default index;

/** `moov` → its trailing `udta` → metadata, cover and chapters, in a handful of reads. */
async function fromMp4(node, ctx) {
  const read = (start, end) => ctx.readRange(start, end);
  const probe = await findMoov(read, node.size, { window: WINDOW });
  if (!probe.found) return null;
  // The `udta` that carries iTunes metadata is a direct child of `moov`, and it is the last
  // one — walked by header rather than read whole, because everything before it is the
  // audio track's sample tables and those are megabytes.
  const udtaBounds = await findChildRanged(read, probe.offset + 8, probe.offset + probe.size, 'udta');
  if (!udtaBounds) return null;
  const udta = await read(udtaBounds.offset, udtaBounds.end);

  // The metadata reader walks from a `moov` payload down through `udta`, so it is handed a
  // buffer that begins with the `udta` box it already has rather than being made to find it
  // again in bytes nobody read.
  const book = metadataFrom(withHeader(udta, 'udta'));
  const raw = coverFrom(udta);
  let cover = null;
  if (raw && raw.bytes.length <= MAX_COVER_BYTES) {
    // `coverFrom` reports where the bytes are inside the buffer it was handed, so the file
    // offset is that plus where the buffer started. Nothing is copied.
    const start = udtaBounds.offset + raw.at;
    cover = { range: { start, end: start + raw.bytes.length }, contentType: raw.contentType };
  }
  const chapters = await chaptersRanged(read, probe).catch(() => null);
  return { cover, book: { ...book, series: seriesOf(book) }, chapters };
}

/**
 * Which series a book belongs to.
 *
 * TWO CONVENTIONS, and a library will contain both. A tagger that knows about series
 * writes a freeform `SERIES` atom, which is unambiguous and wins. Most do not, and put the
 * series in the ALBUM field instead — which is the common case in the wild.
 *
 * So album is the fallback, but not blindly: on the book this was built against the album
 * is the TITLE with "(Unabridged)" appended, and taking that as a series would file every
 * such book in a series of one named after itself. Compared with the suffix stripped, which
 * is the only part of the string a publisher adds mechanically.
 */
function seriesOf(book) {
  if (book.series) return book.series;
  const album = (book.album || '').trim();
  if (!album) return undefined;
  const bare = album.replace(/\s*\((?:un)?abridged\)\s*$/i, '').trim();
  const title = (book.title || '').trim();
  if (!bare || bare.toLowerCase() === title.toLowerCase()) return undefined;
  return bare;
}

/**
 * A payload, wrapped back up in the box header it was read out of.
 *
 * `metadataFrom` descends from `moov`, and the ranged path holds only `udta` — so rather
 * than a second parser that starts one level down, the header is put back and the one
 * parser is used. Eight bytes, and no second implementation of the same descent.
 */
function withHeader(payload, type) {
  const out = new Uint8Array(payload.length + 8);
  const size = out.length;
  out[0] = size >>> 24; out[1] = (size >>> 16) & 255; out[2] = (size >>> 8) & 255; out[3] = size & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 255;
  out.set(payload, 8);
  return out;
}

/** The zip's directory → `publication.json` → everything it names. */
async function fromLpf(node, ctx) {
  const read = (start, end) => ctx.readRange(start, end);
  const entries = await centralDirectory(read, node.size);
  if (!entries?.length) return null;

  const manifestPath = manifestEntry(Object.fromEntries(entries.map((e) => [e.name, 1])));
  if (!manifestPath) return null;
  const manifestBytes = await readEntry(read, entryFor(entries, manifestPath));
  if (!manifestBytes) return null;

  const pub = parsePublication(new TextDecoder().decode(manifestBytes));
  // An LPF's tracks ARE its chapters — see lpf.js. Laid onto one timeline here so a reader
  // of the contribution cannot tell which container it came from.
  const chapters = chaptersFrom(pub.tracks).map(({ time, title }) => ({ time, title }));
  // The SAME RECORD an m4b produces, so a reader of the contribution cannot tell which
  // container it came from. It was three fields against thirteen, which broke that promise
  // where it shows most: an LPF book had no narrator, so the player's byline had no
  // "read by" and none of `#series:`, `#genre:`, `#publisher:` or `#language:` found it.
  const book = {
    title: pub.title || undefined,
    author: pub.authors[0] || undefined,
    narrator: pub.narrator || undefined,
    series: pub.series || undefined,
    part: pub.part ?? undefined,
    genre: pub.genre || undefined,
    publisher: pub.publisher || undefined,
    year: pub.year || undefined,
    language: pub.language || undefined,
    description: pub.description || undefined,
    duration: pub.duration || undefined,
  };
  return { cover: await lpfCover(read, entries, manifestPath, pub), book, chapters };
}

/** The cover the manifest names, pointed at where the zip stored it plainly. */
async function lpfCover(read, entries, manifestPath, pub) {
  if (!pub.cover) return null;
  const entry = entryFor(entries, resolveHref(manifestPath, pub.cover));
  if (!entry || entry.size > MAX_COVER_BYTES) return null;
  const contentType = contentTypeOf(entry.name);

  // STORED means the entry's bytes in the zip ARE the image, so it can be pointed at like
  // an m4b's. Which is the common case: deflating an already-compressed JPEG buys nothing,
  // so most zip tools store it.
  if (entry.method === 0) {
    const dataAt = await locateEntry(read, entry);
    if (dataAt != null) return { range: { start: dataAt, end: dataAt + entry.size }, contentType };
  }
  // Deflated: the stored bytes are not the image, so there is nothing to point at and it
  // has to be carried — only if it is small enough to be worth carrying.
  if (entry.size > MAX_INLINE_BYTES) return null;
  const bytes = await readEntry(read, entry);
  if (!bytes?.length) return null;
  return { bytes, contentType };
}

const contentTypeOf = (name) => (/\.png$/i.test(name) ? 'image/png'
  : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg');

/**
 * Base64 without pulling in a dependency, and without `String.fromCharCode(...bytes)` —
 * spreading forty thousand arguments onto a call is a stack overflow, not a conversion.
 */
function dataUrl(bytes, contentType) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

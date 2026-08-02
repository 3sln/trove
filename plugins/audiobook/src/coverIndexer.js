// Cover art, as an indexer contribution.
//
// Runs on the SERVER, once per upload, in the isolate runtime — not in a viewer's tab. That
// is the whole reason it is an indexer: a cover has to be found once for the drive, not
// recomputed in whichever browser happens to open the grid. It is plain ESM exporting
// `index(node, ctx)` and does not use the plugin SDK at all.
//
// It reads BY RANGE and never pulls the book through memory. An m4b keeps its cover in a
// `udta` at the end of `moov`, which is itself at the end of the file; an LPF keeps it as a
// zip entry named by a manifest whose directory is also at the end. Both are three or four
// small reads out of hundreds of megabytes.
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

import { findMoov, findChildRanged, coverFrom } from './mp4.js';
import { centralDirectory, readEntry, locateEntry, entryFor } from './zip.js';
import { parsePublication, manifestEntry, resolveHref } from './lpf.js';

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

/** How much of the head and tail to look at while hunting for structure. */
const WINDOW = 64 * 1024;

const isLpf = (node) => /\.lpf$/i.test(node.name || '') || (node.contentType || '').includes('lpf');

export async function index(node, ctx) {
  if (!node?.size || !ctx?.readRange) return {};
  try {
    const cover = isLpf(node) ? await lpfCover(node, ctx) : await mp4Cover(node, ctx);
    if (!cover) return {};
    // The key the grid knows. An object, not a bare string, because it carries one of two
    // shapes — a range to fetch or bytes to draw — and a reader that only understands one
    // of them should be able to tell which it has.
    const thumbnail = cover.range
      ? { range: cover.range, contentType: cover.contentType }
      : { src: dataUrl(cover.bytes, cover.contentType), contentType: cover.contentType };
    return { metadata: { thumbnail } };
  } catch {
    // A book whose cover cannot be read is still a book. An indexer that threw would mark
    // the whole node as failed and raise a standing issue about a missing picture.
    return {};
  }
}

export default index;

/** `moov` → its trailing `udta` → `covr`, in four small reads. */
async function mp4Cover(node, ctx) {
  const read = (start, end) => ctx.readRange(start, end);
  const probe = await findMoov(read, node.size, { window: WINDOW });
  if (!probe.found) return null;
  // The `udta` that carries iTunes metadata is a direct child of `moov`, and it is the last
  // one — walked by header rather than read whole, because everything before it is the
  // audio track's sample tables and those are megabytes.
  const udtaBounds = await findChildRanged(read, probe.offset + 8, probe.offset + probe.size, 'udta');
  if (!udtaBounds) return null;
  const udta = await read(udtaBounds.offset, udtaBounds.end);
  const cover = coverFrom(udta);
  if (!cover || cover.bytes.length > MAX_COVER_BYTES) return null;
  // `coverFrom` reports where the bytes are inside the buffer it was handed, so the file
  // offset is that plus where the buffer started. Nothing is copied.
  const start = udtaBounds.offset + cover.at;
  return { range: { start, end: start + cover.bytes.length }, contentType: cover.contentType };
}

/** The zip's directory → `publication.json` → the cover it names. */
async function lpfCover(node, ctx) {
  const read = (start, end) => ctx.readRange(start, end);
  const entries = await centralDirectory(read, node.size);
  if (!entries?.length) return null;

  const manifestPath = manifestEntry(Object.fromEntries(entries.map((e) => [e.name, 1])));
  if (!manifestPath) return null;
  const manifestBytes = await readEntry(read, entryFor(entries, manifestPath));
  if (!manifestBytes) return null;

  const pub = parsePublication(new TextDecoder().decode(manifestBytes));
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

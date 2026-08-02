// Opening a book: whatever the container, the same shape comes out.
//
// Everything above this line — the player, the UI, the media session — deals in one
// duration, one position and one chapter list. The two formats reach that differently and
// the difference is worth stating, because it is also where the ranged reader earns its
// keep:
//
//   M4B   one file. Chapters live in `moov`, which is a few kilobytes somewhere inside a
//         few hundred megabytes — so this reads the head, walks the box chain, reads
//         `moov`, and has the whole chapter list before a byte of audio moves. Playback is
//         a minted URL the browser ranges over itself.
//
//   LPF   a zip of tracks plus a manifest. The tracks ARE the chapters. The manifest is at
//         the front of the zip's central directory, which is at the END of the file — so
//         this reads the tail, then the manifest entry, and still does not touch the audio.
//
// A plain `.m4a`/`.aac` has neither: no chapter box and no manifest, so it degrades to a
// one-chapter book. That is the honest answer rather than a failure — the file really does
// have one chapter.

import { unzipSync, strFromU8 } from 'fflate';
import { findMoov, chaptersFromChpl, chapterTrack, chapterTitle, movieDuration, metadataFrom } from './mp4.js';
import { parsePublication, chaptersFrom, manifestEntry, resolveHref } from './lpf.js';
export { loadCover } from './loadCover.js';

/** How much of the head and tail to read while looking for structure. */
const WINDOW = 64 * 1024;

const isLpf = (file) => /\.lpf$/i.test(file.name || '') || (file.contentType || '').includes('lpf');

/**
 * @param {object} ctx the plugin SDK context
 * @param {object} file the node being opened
 * @returns {Promise<{kind: 'm4b'|'lpf'|'audio', title: string, author: string|null,
 *   duration: number|null, chapters: Array<{time: number, title: string}>,
 *   streamable: boolean, why: string|null, tracks?: Array<object>}>}
 */
export async function openBook(ctx, file) {
  // INDEXED FIRST. The book indexer already walked this container on the server, once, at
  // upload — so the title, chapters and cover are on the node before anyone opens it, and
  // reading them costs nothing. Parsing here is the fallback for a file uploaded before the
  // plugin was installed, or on a drive whose indexers have not run.
  //
  // An LPF still opens its zip regardless: its tracks are the audio, and playback needs the
  // entries themselves, not a description of them.
  const indexed = indexedBook(file);
  // The indexed record has everything to DRAW a book, but streaming needs the sample
  // tables, which only live in `moov`. So the probe still runs for an m4b — a few
  // kilobytes, no audio — and the record carries the result.
  if (indexed && !isLpf(file)) {
    // Swallowing this was a mistake worth naming: the probe failed for a reason the
    // player then reported as "this book's index could not be read", which is true and
    // useless. The reason reaches the screen now.
    try {
      const blob = await ctx.files.blob(file.id);
      if (!blob?.size) throw new Error(`the drive reported this file as ${blob?.size ?? 'unknown'} bytes`);
      const read = async (start, end) => blob.slice(start, end).bytes();
      const probe = await findMoov(read, blob.size, { window: WINDOW });
      if (!probe.found) throw new Error('no moov box was found in it');
      indexed.moov = await read(probe.offset, probe.offset + probe.size);
    } catch (err) {
      indexed.moovError = err?.message || String(err);
    }
    return indexed;
  }

  const blob = await ctx.files.blob(file.id);
  if (isLpf(file)) return { ...(await openLpf(ctx, file, blob)), ...titlesFrom(indexed) };
  return openMp4(ctx, file, blob);
}

/**
 * What the indexer already found, if it ran.
 *
 * Contributions are namespaced by contributor and the viewer does not care which one wrote
 * this — the same indifference the grid has about thumbnails. A record with no chapters is
 * not usable as a book, so it falls through to parsing rather than opening a book that
 * claims to have none.
 */
function indexedBook(file) {
  for (const contribution of Object.values(file?.contributions || {})) {
    const meta = contribution?.metadata;
    if (!meta?.book || !meta.chapters?.length) continue;
    return {
      // The cover, as the indexer left it: either a range into the file or a data: URL.
      // Resolved to something drawable by `loadCover` once there is an SDK to read with.
      cover: meta.thumbnail || null,
      kind: 'm4b',
      title: meta.book.title || file.name,
      author: meta.book.author || null,
      narrator: meta.book.narrator || null,
      series: meta.book.series || null,
      duration: meta.book.duration || null,
      chapters: meta.chapters,
      streamable: true,
      why: null,
    };
  }
  return null;
}

/** The names an indexed record knows that an LPF's own manifest may not. */
const titlesFrom = (indexed) => (indexed
  ? { narrator: indexed.narrator, series: indexed.series }
  : {});

/**
 * The M4B path.
 *
 * `streamable` is what the moov probe buys, and it drives the UI rather than being a
 * detail: a file whose `moov` cannot be found has no sample tables anyone can reach, so
 * there is no chapter list and no way to say where in the file a given second lives. The
 * browser can still play it end to end from a URL, and that is what the answer means —
 * "playable, but nothing here knows its shape".
 */
async function openMp4(ctx, file, blob) {
  const read = async (start, end) => blob.slice(start, end).bytes();
  const probe = await findMoov(read, blob.size, { window: WINDOW });
  if (!probe.found) {
    return {
      kind: 'audio',
      title: file.name,
      author: null,
      duration: null,
      chapters: [{ time: 0, title: file.name }],
      streamable: true,
      why: 'No chapter information — this file does not carry an MP4 index we can read.',
    };
  }

  const moov = await read(probe.offset, probe.offset + probe.size);
  const meta = metadataFrom(moov);
  // Kept for the streamer, which needs the sample tables this walk already has in hand.
  const moovBytes = moov;
  const duration = movieDuration(moov);

  // `chpl` first: it is what almost every m4b in the wild uses, and it needs no second
  // read because the titles are inside `moov` itself. A chapter TRACK keeps its titles in
  // `mdat`, so it costs one more range read — worth it, but only as the fallback.
  let chapters = chaptersFromChpl(moov);
  if (!chapters) chapters = await chaptersFromTrack(moov, read);

  return {
    kind: 'm4b',
    moov: moovBytes,
    title: meta.title || file.name,
    author: meta.author || null,
    narrator: meta.narrator || null,
    series: meta.series || null,
    cover: null,
    duration,
    chapters: chapters?.length ? chapters : [{ time: 0, title: meta.title || file.name }],
    streamable: true,
    // Not an error, and worth saying: a non-faststart file has its index at the END, so
    // everything above took a read of the tail rather than the head. Nothing is broken —
    // but it is the fact that explains why opening it took two round trips.
    why: probe.faststart ? null : 'This file keeps its index at the end, so opening it read the tail first.',
  };
}

/** Chapter track titles, which live outside `moov` and so cost one more read. */
async function chaptersFromTrack(moov, read) {
  const samples = chapterTrack(moov);
  if (!samples?.length) return null;
  // One read spanning every title rather than one per chapter: they are contiguous in
  // practice, and forty round trips to name forty chapters is forty chances to stall.
  const from = Math.min(...samples.map((s) => s.offset));
  const to = Math.max(...samples.map((s) => s.offset + s.length));
  if (!(to > from) || to - from > 1024 * 1024) return null;
  const bytes = await read(from, to);
  return samples.map((s, i) => ({
    time: s.time,
    title: chapterTitle(bytes.subarray(s.offset - from, s.offset - from + s.length)) || `Chapter ${i + 1}`,
  }));
}

/**
 * The LPF path.
 *
 * The whole zip is read, deliberately, and the reason is worth stating so nobody
 * "optimises" it into something that breaks: an LPF's tracks are the audio, so the file is
 * as large as the book, and reading it whole would be exactly the buffering this design
 * exists to avoid. What is read here is the CENTRAL DIRECTORY and the manifest — the tail
 * of the zip and one small entry — and the tracks stay where they are until played.
 */
async function openLpf(ctx, file, blob) {
  // fflate needs the whole archive to inflate one entry, so an LPF is read whole. That is
  // the honest cost of the format: a zip's entries are not independently addressable
  // without implementing the central directory walk ourselves, and a book people actually
  // have is tens to hundreds of megabytes. It is read ONCE and kept as blob URLs.
  const bytes = await blob.bytes();
  const files = unzipSync(bytes);
  const manifestPath = manifestEntry(files);
  if (!manifestPath) throw new Error('This .lpf has no publication.json, so it is not an audiobook package.');

  const pub = parsePublication(strFromU8(files[manifestPath]));
  const tracks = pub.tracks.map((t) => {
    const entry = files[resolveHref(manifestPath, t.href)];
    return {
      ...t,
      // An object URL over the entry's own bytes. Local to this frame, revoked on close —
      // no host URL, and `<audio src>` can seek within it because it is a real Blob.
      url: entry ? URL.createObjectURL(new Blob([entry], { type: t.type || 'audio/mpeg' })) : null,
    };
  }).filter((t) => t.url);

  if (!tracks.length) throw new Error('This book lists no playable tracks.');
  return {
    kind: 'lpf',
    title: pub.title || file.name,
    author: pub.authors[0] || null,
    duration: pub.duration,
    chapters: chaptersFrom(tracks),
    tracks,
    streamable: true,
    why: null,
  };
}

/** Give back the object URLs an LPF minted. Called when the viewer closes. */
export function releaseBook(book) {
  for (const t of book?.tracks || []) if (t.url) URL.revokeObjectURL(t.url);
}

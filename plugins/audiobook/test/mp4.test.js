// Reading an MP4 without decoding it.
//
// Every case here is built byte by byte rather than from a fixture file, because the
// failures worth catching are the ENCODINGS: a 64-bit size, a to-EOF size, an index at the
// end of the file rather than the front. A single real m4b exercises one of those and hides
// the other two.
//
// What a constructed file cannot catch is a mismatch between the fixture's CONVENTION and
// the caller's, and that is what happened: these tests passed `moov`'s payload while the
// player passed the box as read, header and all, so every lookup returned null on every
// real file and twelve green tests said otherwise. They pass the box now, exactly as
// `read(probe.offset, probe.offset + probe.size)` hands it over.

import { test, expect } from 'bun:test';
import {
  readHeader, topLevelBoxes, findMoov, findBox, movieTimescale, movieDuration,
  chaptersFromChpl, chaptersRanged, chapterTrack, chapterTitle, metadataFrom, coverFrom, plausibleType,
} from '../src/mp4.js';

const enc = new TextEncoder();
const u32 = (n) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const u64 = (n) => [...u32(Math.floor(n / 2 ** 32)), ...u32(n >>> 0)];

/**
 * A four-character type as BYTES.
 *
 * One byte per character, not UTF-8: the iTunes metadata keys begin with 0xA9, and a
 * TextEncoder turns that into the two bytes 0xC2 0xA9 — so a helper that encoded types as
 * UTF-8 would write a five-byte type and nothing would ever match it. The parser reads
 * types with `String.fromCharCode`, which is the same convention.
 */
const type4 = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255));

/** A box: 4-byte size, 4-byte type, payload. */
function box(type, payload = []) {
  const body = Array.from(payload);
  return Uint8Array.from([...u32(body.length + 8), ...type4(type), ...body]);
}
/** The 64-bit form: size 1, then a `largesize` after the type. */
function bigBox(type, payload = []) {
  const body = Array.from(payload);
  return Uint8Array.from([...u32(1), ...type4(type), ...u64(body.length + 16), ...body]);
}
const join = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
/** A reader over a buffer, half-open, as the SDK's blob gives one. */
const reader = (bytes) => async (start, end) => bytes.subarray(start, Math.min(end, bytes.length));

test('a box header reads the 32-bit, 64-bit and to-EOF forms', () => {
  expect(readHeader(box('ftyp', [1, 2, 3]))).toEqual({ type: 'ftyp', size: 11, header: 8, toEnd: false });
  expect(readHeader(bigBox('mdat', [1, 2, 3]))).toEqual({ type: 'mdat', size: 19, header: 16, toEnd: false });
  // `size == 0` means "to the end of the file", which is legal for the last box.
  expect(readHeader(Uint8Array.from([...u32(0), ...type4('mdat')])))
    .toEqual({ type: 'mdat', size: 0, header: 8, toEnd: true });
  // A size smaller than its own header is not a box. Treating it as one makes the walk
  // loop forever on an offset that never advances, which is a hang rather than an error.
  expect(readHeader(Uint8Array.from([...u32(4), ...type4('junk')]))).toBe(null);
});

test('moov is found at the front, and says so', async () => {
  const file = join(box('ftyp', enc.encode('M4A ')), box('moov', box('mvhd')), box('mdat', new Uint8Array(64)));
  const got = await findMoov(reader(file), file.length);
  expect(got.found).toBe(true);
  expect(got.via).toBe('chain');
  // Faststart: the index comes before the audio, which is what makes a file streamable
  // from the first byte.
  expect(got.faststart).toBe(true);
  expect(file.subarray(got.offset + 4, got.offset + 8)).toEqual(type4('moov'));
});

test('moov is found at the END, past a 64-bit mdat', async () => {
  // The common shape for a long audiobook: an encoder that did not know the final size
  // wrote the index last, and the audio needed the 64-bit size because it is over 4 GiB —
  // except here it is small, which is the point. The ENCODING is what breaks walkers.
  const file = join(box('ftyp'), bigBox('mdat', new Uint8Array(2048)), box('moov', box('mvhd')));
  const got = await findMoov(reader(file), file.length, { window: 256 });
  expect(got.found).toBe(true);
  expect(got.via).toBe('chain');
  expect(got.faststart).toBe(false);
});

test('a to-EOF mdat does not swallow the walk', async () => {
  const file = join(box('ftyp'), box('moov', box('mvhd')), Uint8Array.from([...u32(0), ...type4('mdat')]), new Uint8Array(32));
  const got = await findMoov(reader(file), file.length);
  expect(got.found).toBe(true);
  expect(got.faststart).toBe(true);
});

test('a broken chain falls back to scanning the tail, and validates what it finds', async () => {
  const moov = box('moov', box('mvhd'));
  // A file whose second box lies about its size, so the chain walks into nothing. The real
  // `moov` is still at the end and still findable.
  const broken = Uint8Array.from([...u32(9999), ...type4('free')]);
  const file = join(box('ftyp'), broken, moov);
  const got = await findMoov(reader(file), file.length, { window: 512 });
  expect(got.found).toBe(true);
  expect(got.via).toBe('tail-scan');
  expect(got.offset).toBe(file.length - moov.length);
});

test('four bytes spelling moov inside audio are not mistaken for a box', async () => {
  // The reason the scan validates rather than trusting: over hundreds of megabytes, the
  // ASCII 'moov' turns up inside compressed audio, and a scan that returned it would send
  // a parser into the middle of a sample.
  const decoy = Uint8Array.from([...u32(0x7fffff), ...type4('moov'), 9, 9, 9, 9]);
  const file = join(box('ftyp'), box('mdat', decoy));
  const got = await findMoov(reader(file), file.length, { window: 512 });
  expect(got.found).toBe(false);
});

test('something that is not an MP4 is refused before the walk', async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  expect((await findMoov(reader(jpeg), jpeg.length)).found).toBe(false);
});

test('the timescale and duration come out of mvhd, in seconds', () => {
  // v0 mvhd: version/flags, created, modified, timescale, duration.
  const mvhd = box('mvhd', [...u32(0), ...u32(0), ...u32(0), ...u32(1000), ...u32(90_000)]);
  const moov = box('moov', mvhd);
  expect(movieTimescale(moov)).toBe(1000);
  expect(movieDuration(moov)).toBe(90);
});

test('chpl chapters are read in 100-nanosecond units, not the movie timescale', () => {
  // `chpl` predates being part of this file and carries its own unit — reading it in the
  // movie's timescale puts every chapter in the wrong place by a factor of thousands.
  const title = (s) => [s.length, ...enc.encode(s)];
  const chpl = box('chpl', [
    ...u32(0), ...u32(2),
    ...u64(0), ...title('One'),
    ...u64(600 * 10_000_000), ...title('Two'),
  ]);
  const moov = box('moov', box('udta', chpl));
  expect(chaptersFromChpl(moov)).toEqual([
    { time: 0, title: 'One' },
    { time: 600, title: 'Two' },
  ]);
});

test('a chapter-track title is length-prefixed, and the prefix is trusted only so far', () => {
  expect(chapterTitle(Uint8Array.from([0, 5, ...enc.encode('Intro')]))).toBe('Intro');
  // A length longer than the buffer is clamped rather than throwing: a truncated read is a
  // short title, not a failed book.
  expect(chapterTitle(Uint8Array.from([0, 99, ...enc.encode('Intro')]))).toBe('Intro');
  expect(chapterTitle(new Uint8Array(0))).toBe('');
});

test('title and author come out of ilst, through the full-box meta', () => {
  const item = (key, value) => box(key, box('data', [...u32(1), ...u32(0), ...enc.encode(value)]));
  const ilst = box('ilst', join(item('\xa9nam', 'A Long Book'), item('\xa9ART', 'Someone')));
  // `meta` is a FULL box — version and flags before its children — so a naive descent
  // lands four bytes early and finds nothing.
  const meta = box('meta', join(Uint8Array.from(u32(0)), ilst));
  const moov = box('moov', box('udta', meta));
  expect(metadataFrom(moov)).toMatchObject({ title: 'A Long Book', author: 'Someone' });
});

test('the narrator is ©nrt, and ©wrt is not mistaken for the author', () => {
  const item = (key, value) => box(key, box('data', [...u32(1), ...u32(0), ...enc.encode(value)]));
  // What the real book carries: `©wrt` ("writer") holds the NARRATOR's name, not the
  // author's — Audible's tagging, and taking the obvious field would credit the book to
  // the person who read it.
  const ilst = box('ilst', join(
    item('\xa9nam', 'All the Skills'),
    item('\xa9ART', 'Honour Rae'),
    item('\xa9nrt', 'Luke Daniels'),
    item('\xa9wrt', 'Luke Daniels'),
  ));
  const moov = box('moov', box('udta', box('meta', join(Uint8Array.from(u32(0)), ilst))));
  const meta = metadataFrom(moov);
  expect(meta).toMatchObject({ author: 'Honour Rae', narrator: 'Luke Daniels' });
  expect(meta.author).not.toBe('Luke Daniels');
});

test('series and part come out of the ---- freeform atoms', () => {
  // A freeform atom is three children: who defined it, what it is called, and the value.
  // The NAME is what identifies it — the four-byte type is `----` for every one of them,
  // so a reader that keys on the type alone sees one indistinguishable blob.
  const freeform = (name, value) => box('----', join(
    box('mean', [...u32(0), ...enc.encode('com.apple.iTunes')]),
    box('name', [...u32(0), ...enc.encode(name)]),
    box('data', [...u32(1), ...u32(0), ...enc.encode(value)]),
  ));
  const ilst = box('ilst', join(
    freeform('SERIES', 'All the Skills'),
    freeform('PART', '1'),
    freeform('LANGUAGE', 'English'),
  ));
  const moov = box('moov', box('udta', box('meta', join(Uint8Array.from(u32(0)), ilst))));
  // `part` comes back as a NUMBER: it is what orders a series on a shelf, and "10" sorts
  // before "2" as a string.
  expect(metadataFrom(moov)).toMatchObject({ series: 'All the Skills', part: 1, language: 'English' });
});

test('findBox descends, and topLevelBoxes walks', () => {
  const file = join(box('ftyp'), box('moov', box('udta', box('chpl'))), box('mdat'));
  expect(topLevelBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
  expect(findBox(file, ['moov', 'udta', 'chpl'])).toBeTruthy();
  expect(findBox(file, ['moov', 'udta', 'nope'])).toBe(null);
});

// --- the chapter track ---------------------------------------------------------
//
// The path a real Audible-derived book actually uses. `All the Skills` (193 MB, 64
// chapters) has no `chpl` at all: chapters are a text track, referenced from the audio
// track by `tref/chap`, with the titles as length-prefixed samples at the front of `mdat`.
// Every case below is one thing that book taught, or one thing it would have hidden.

/** A minimal text track: `n` chapter samples, packed `perChunk` to a chunk. */
function chapterTrackBox({ id = 2, n = 3, perChunk = 1, timescale = 1000, delta = 10_000, wide = false,
  sizes = Array.from({ length: n }, (_, i) => 10 + i), at = 1000, stride = 100 } = {}) {
  const chunks = Math.ceil(n / perChunk);
  const offsets = Array.from({ length: chunks }, (_, c) => at + c * stride);
  const tkhd = box('tkhd', [...u32(0), ...u32(0), ...u32(0), ...u32(id)]);
  const mdhd = box('mdhd', [...u32(0), ...u32(0), ...u32(0), ...u32(timescale), ...u32(n * delta)]);
  const hdlr = box('hdlr', [...u32(0), ...u32(0), ...type4('text'), ...u32(0), ...u32(0), ...u32(0)]);
  const stts = box('stts', [...u32(0), ...u32(1), ...u32(n), ...u32(delta)]);
  const stsc = box('stsc', [...u32(0), ...u32(1), ...u32(1), ...u32(perChunk), ...u32(1)]);
  const stsz = box('stsz', [...u32(0), ...u32(0), ...u32(n), ...sizes.flatMap(u32)]);
  const table = wide
    ? box('co64', [...u32(0), ...u32(chunks), ...offsets.flatMap(u64)])
    : box('stco', [...u32(0), ...u32(chunks), ...offsets.flatMap(u32)]);
  const stbl = box('stbl', join(stts, stsc, stsz, table));
  return box('trak', join(tkhd, box('mdia', join(mdhd, hdlr, box('minf', stbl)))));
}

/** An audio track that points at `chapterId` through `tref/chap`. */
function audioTrackBox(id, chapterId) {
  const tkhd = box('tkhd', [...u32(0), ...u32(0), ...u32(0), ...u32(id)]);
  const tref = box('tref', box('chap', u32(chapterId)));
  const hdlr = box('hdlr', [...u32(0), ...u32(0), ...type4('soun'), ...u32(0), ...u32(0), ...u32(0)]);
  return box('trak', join(tkhd, tref, box('mdia', hdlr)));
}

test('chapter samples packed into ONE chunk are all found', () => {
  // The bug the real book would have exposed and a fixture did not: `stsc` was ignored and
  // offsets came straight from `stco`, so N samples sharing a chunk reported ONE chapter.
  // Sixty-four tiny text samples in one chunk is the obvious thing for a muxer to do.
  const moov = box('moov', chapterTrackBox({ n: 5, perChunk: 5 }));
  const got = chapterTrack(moov);
  expect(got.length).toBe(5);
  // And each sample sits after the ones before it IN its chunk, not at the chunk's start.
  expect(got.map((s) => s.offset)).toEqual([1000, 1010, 1021, 1033, 1046]);
  expect(got.map((s) => s.time)).toEqual([0, 10, 20, 30, 40]);
});

test('samples spread one per chunk still line up', () => {
  const got = chapterTrack(box('moov', chapterTrackBox({ n: 3, perChunk: 1 })));
  expect(got.map((s) => s.offset)).toEqual([1000, 1100, 1200]);
});

test('a book over 4 GB uses co64, and it is read', () => {
  // Long audiobooks are exactly the files that cross 4 GB, so this is not an exotic case.
  // Absent, the chapter track was not found at all and the book fell back to one chapter.
  const got = chapterTrack(box('moov', chapterTrackBox({ n: 3, perChunk: 1, wide: true })));
  expect(got.length).toBe(3);
  expect(got[0].offset).toBe(1000);
});

test('the chapter track is the one tref/chap names, not merely the first text track', () => {
  // A file can carry more than one text track — subtitles are one — and only the
  // referenced one is the chapters. This is the route ffmpeg takes.
  const subtitles = chapterTrackBox({ id: 2, n: 2, delta: 5000 });
  const chapters = chapterTrackBox({ id: 3, n: 4, delta: 20_000 });
  const moov = box('moov', join(audioTrackBox(1, 3), subtitles, chapters));
  expect(chapterTrack(moov).length).toBe(4);
});

test('with no tref, the first text track is the honest guess', () => {
  const moov = box('moov', join(audioTrackBox(1, 0), chapterTrackBox({ id: 2, n: 2 })));
  expect(chapterTrack(moov).length).toBe(2);
});

// --- cover art -----------------------------------------------------------------

test('the iTunes © atoms are recognised as boxes', () => {
  // `©nam` begins with 0xa9, and an ASCII-only plausibility test rejects it — which made
  // `findBox` give up on the FIRST item inside `ilst` and never reach `covr`. That cost the
  // cover art on a real book while every other test stayed green.
  expect(plausibleType('\xa9nam')).toBe(true);
  expect(plausibleType('covr')).toBe(true);
  // Still not anything: a high byte is legal in the first position only, which is the
  // convention, and garbage must stay implausible or the tail scan loses its guard.
  expect(plausibleType('na\xa9m')).toBe(false);
  expect(plausibleType('\x00\x00\x00\x00')).toBe(false);
});

test('cover art is found past the © atoms, and reports where it is', () => {
  const item = (key, payload) => box(key, payload);
  // A `data` box: version/flags where the low byte is the well-known type (13 = JPEG),
  // four reserved bytes, then the image.
  const jpeg = [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9];
  const covr = item('covr', box('data', [...u32(13), ...u32(0), ...jpeg]));
  const ilst = box('ilst', join(item('\xa9nam', box('data', [...u32(1), ...u32(0), ...enc.encode('Title')])), covr));
  const meta = box('meta', join(Uint8Array.from(u32(0)), ilst));
  const udta = new Uint8Array(box('udta', meta).slice(8));

  const cover = coverFrom(udta);
  expect(cover.contentType).toBe('image/jpeg');
  expect([...cover.bytes]).toEqual(jpeg);
  // `at` is what lets a caller point at the bytes in the file instead of copying them.
  expect([...udta.subarray(cover.at, cover.at + jpeg.length)]).toEqual(jpeg);
});

test('a cover in a format we cannot name is left alone', () => {
  // Type 27 is BMP. Claiming a content type we have not checked would put a broken image
  // on a tile; reporting nothing puts the icon there, which is what the list shows anyway.
  const covr = box('covr', box('data', [...u32(27), ...u32(0), 1, 2, 3]));
  const meta = box('meta', join(Uint8Array.from(u32(0)), box('ilst', covr)));
  expect(coverFrom(new Uint8Array(box('udta', meta).slice(8)))).toBe(null);
});

// --- the ranged chapter walk ---------------------------------------------------
//
// What the INDEXER uses. `chaptersRanged` never has the file in hand — it is given a reader
// and the moov's position, and has to reach the same answer `chaptersFromChpl`/`chapterTrack`
// reach from a buffer, without pulling a 185 MB book through a server's memory.

/** A file whose moov holds a chapter track, plus the titles out in `mdat`. */
function rangedFile({ chpl = false } = {}) {
  const titles = join(...['One', 'Two', 'Three'].map((t) => join(
    Uint8Array.from([0, t.length]), enc.encode(t),
  )));
  const mdatAt = 8; // `mdat` first, so the sample offsets are real file offsets
  const mdat = box('mdat', titles);
  const inner = chpl
    ? box('udta', box('chpl', [...u32(0), ...u32(1), ...u64(0), 4, ...enc.encode('Only')]))
    : join(audioTrackBox(1, 2), chapterTrackBox({
      id: 2, n: 3, perChunk: 3, at: mdatAt, sizes: [5, 5, 7],
    }));
  const moov = box('moov', inner);
  return { bytes: join(mdat, moov), moov: { offset: mdat.length, size: moov.length } };
}

test('the ranged walk finds a chapter track without holding the file', async () => {
  const { bytes, moov } = rangedFile();
  let reads = 0, got = 0;
  const read = async (start, end) => { reads++; got += end - start; return bytes.subarray(start, end); };
  const chapters = await chaptersRanged(read, moov);
  expect(chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
  // The point of the exercise: a handful of small reads, not the file. `mdat` here holds
  // only titles, but in a real book it is every byte of audio.
  expect(reads).toBeLessThan(12);
  expect(got).toBeLessThan(bytes.length * 2);
});

test('the ranged walk prefers chpl, and stops there', async () => {
  const { bytes, moov } = rangedFile({ chpl: true });
  const read = async (start, end) => bytes.subarray(start, end);
  expect((await chaptersRanged(read, moov)).map((c) => c.title)).toEqual(['Only']);
});

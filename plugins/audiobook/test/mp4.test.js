// Reading an MP4 without decoding it.
//
// Every case here is built byte by byte rather than from a fixture file, because the
// failures worth catching are the ENCODINGS: a 64-bit size, a to-EOF size, an index at the
// end of the file rather than the front. A single real m4b exercises one of those and hides
// the other two.

import { test, expect } from 'bun:test';
import {
  readHeader, topLevelBoxes, findMoov, findBox, movieTimescale, movieDuration,
  chaptersFromChpl, chapterTitle, metadataFrom,
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
  const moov = box('moov', mvhd).subarray(8);
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
  const moov = box('moov', box('udta', chpl)).subarray(8);
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
  const moov = box('moov', box('udta', meta)).subarray(8);
  expect(metadataFrom(moov)).toMatchObject({ title: 'A Long Book', author: 'Someone' });
});

test('findBox descends, and topLevelBoxes walks', () => {
  const file = join(box('ftyp'), box('moov', box('udta', box('chpl'))), box('mdat'));
  expect(topLevelBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
  expect(findBox(file, ['moov', 'udta', 'chpl'])).toBeTruthy();
  expect(findBox(file, ['moov', 'udta', 'nope'])).toBe(null);
});

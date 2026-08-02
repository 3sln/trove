// Progressive MP4 in, fragmented MP4 out.
//
// MediaSource takes an init segment plus `moof`+`mdat` media segments. An m4b is one
// `moov` and one enormous `mdat`, so `appendBuffer` on its bytes fails however they are
// ordered — which is why "front-load the moov atom" makes a file seekable without making
// it appendable, and why this module exists.
//
// The tests build a real (small) progressive file and check the boxes that come out,
// because everything here is byte layout: a field written at the wrong offset produces a
// segment a decoder rejects with no useful message.

import { test, expect } from 'bun:test';
import { audioTrack, initSegment, mediaSegment, windowAt, mimeOf, box } from '../src/transmux.js';
import { topLevelBoxes, readHeader, findBox } from '../src/mp4.js';

const enc = new TextEncoder();
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const b = (...n) => Uint8Array.from(n.flat());
const cat = (...p) => { const n = p.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let a = 0; for (const x of p) { o.set(x, a); a += x.length; } return o; };
const read32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

/** A progressive audio file: mdat first, then a moov whose tables point into it. */
function progressive({ n = 6, size = 10, delta = 1024, timescale = 44100 } = {}) {
  const mdatAt = 8;
  const audio = new Uint8Array(n * size).map((_, i) => i & 255);
  const mdat = cat(b(u32(audio.length + 8)), enc.encode('mdat'), audio);

  const stsd = box('stsd', b(u32(0), u32(1)), box('mp4a', b(new Array(28).fill(0))));
  const mdhd = box('mdhd', b(u32(0), u32(0), u32(0), u32(timescale), u32(n * delta), [0x55, 0xc4, 0, 0]));
  const hdlr = box('hdlr', b(u32(0), u32(0)), enc.encode('soun'), b(u32(0), u32(0), u32(0), [0]));
  const stts = box('stts', b(u32(0), u32(1), u32(n), u32(delta)));
  const stsz = box('stsz', b(u32(0), u32(size), u32(n)));
  const stsc = box('stsc', b(u32(0), u32(1), u32(1), u32(n), u32(1)));  // all in one chunk
  const stco = box('stco', b(u32(0), u32(1), u32(mdatAt)));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const minf = box('minf', box('smhd', b(u32(0), u32(0))), stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = box('tkhd', b(u32(0), u32(0), u32(0), u32(3)));   // track id 3
  const moov = box('moov', box('trak', tkhd, mdia));
  return { file: cat(mdat, moov), moov, audio, mdatAt, n, size, delta, timescale };
}

test('the audio track is found by its handler, and its tables come out whole', () => {
  const f = progressive();
  const t = audioTrack(f.moov);
  expect(t).toBeTruthy();
  expect(t.id).toBe(3);
  expect(t.timescale).toBe(44100);
  expect(t.count).toBe(6);
  // Offsets are absolute file positions, walked through stsc — the first sample sits at
  // the chunk offset and each later one after the previous sample's bytes.
  expect([...t.offsets]).toEqual([8, 18, 28, 38, 48, 58]);
  expect([...t.sizes]).toEqual([10, 10, 10, 10, 10, 10]);
  expect([...t.deltas]).toEqual([1024, 1024, 1024, 1024, 1024, 1024]);
  // stsd is copied VERBATIM, header and all: it carries the codec config and nothing
  // here has any business interpreting it.
  expect(readHeader(t.stsd, 0).type).toBe('stsd');
});

test('a track with no soun handler is not offered as audio', () => {
  const f = progressive();
  // Same file with the handler changed to text — a chapter track, which must not be
  // mistaken for the audio.
  const moov = Uint8Array.from(f.moov);
  // Past the moov's own header, since findBox walks children.
  const hdlr = findBox(moov, ['trak', 'mdia', 'hdlr'], { at: 8, end: moov.length });
  moov.set(enc.encode('text'), hdlr.offset + 8);
  expect(audioTrack(moov)).toBe(null);
});

test('the init segment declares a fragmented movie', () => {
  const t = audioTrack(progressive().moov);
  const init = initSegment(t);
  const top = topLevelBoxes(init).map((x) => x.type);
  expect(top).toEqual(['ftyp', 'moov']);

  const moovBox = topLevelBoxes(init).find((x) => x.type === 'moov');
  const inMoov = { at: moovBox.offset + 8, end: moovBox.offset + moovBox.size };
  // `mvex` is what makes it fragmented rather than merely empty. Without it a decoder
  // reads a zero-length movie and refuses everything appended afterwards.
  expect(findBox(init, ['mvex', 'trex'], inMoov)).toBeTruthy();
  // And the sample tables are empty — every sample arrives inside a fragment.
  const stsz = findBox(init, ['trak', 'mdia', 'minf', 'stbl', 'stsz'], inMoov);
  expect(read32(init, stsz.offset + 8)).toBe(0);
  // The codec config survived the trip.
  expect(findBox(init, ['trak', 'mdia', 'minf', 'stbl', 'stsd'], inMoov)).toBeTruthy();
});

test('a media segment carries the samples it claims, byte for byte', () => {
  const f = progressive();
  const t = audioTrack(f.moov);
  // Samples 2..5, read out of the file the way a ranged reader would.
  const w = { from: 2, to: 5 };
  const start = t.offsets[w.from];
  const end = t.offsets[w.to - 1] + t.sizes[w.to - 1];
  const seg = mediaSegment(t, w.from, w.to, f.file.subarray(start, end), start, 7);

  const top = topLevelBoxes(seg).map((x) => x.type);
  expect(top).toEqual(['moof', 'mdat']);

  const mdatBox = topLevelBoxes(seg).find((x) => x.type === 'mdat');
  const payload = seg.subarray(mdatBox.offset + 8, mdatBox.offset + mdatBox.size);
  // THE CRITICAL PROPERTY: the audio is copied, not re-encoded. These are the original
  // file's bytes for those samples and nothing else.
  expect([...payload]).toEqual([...f.file.subarray(start, end)]);
  expect(payload.length).toBe(30);
});

test('a fragment says where in the book it belongs, so seeking works', () => {
  const f = progressive();
  const t = audioTrack(f.moov);
  const start = t.offsets[2];
  const seg = mediaSegment(t, 2, 4, f.file.subarray(start, t.offsets[3] + t.sizes[3]), start, 1);
  const moofBox = topLevelBoxes(seg).find((x) => x.type === 'moof');
  // Bounds into `seg` itself: findBox walks CHILDREN, so it has to start past the moof's
  // own header, and the offsets it answers with stay absolute in `seg`.
  const inMoof = { at: moofBox.offset + 8, end: moofBox.offset + moofBox.size };
  const tfdt = findBox(seg, ['traf', 'tfdt'], inMoof);
  expect(tfdt).toBeTruthy();
  // Version 1, so a 64-bit decode time: two samples of 1024 have already played.
  expect(seg[tfdt.offset]).toBe(1);
  const lo = read32(seg, tfdt.offset + 8);
  expect(lo).toBe(2 * 1024);
  // Appending this at zero instead would put the middle of a book at its start, which is
  // exactly the bug a missing tfdt produces.
});

test('the data offset points past the mdat header, or every fragment is silent', () => {
  const f = progressive();
  const t = audioTrack(f.moov);
  const start = t.offsets[0];
  const seg = mediaSegment(t, 0, 3, f.file.subarray(start, t.offsets[2] + t.sizes[2]), start, 1);
  const moofBox = topLevelBoxes(seg).find((x) => x.type === 'moof');
  const inMoof = { at: moofBox.offset + 8, end: moofBox.offset + moofBox.size };
  const trun = findBox(seg, ['traf', 'trun'], inMoof);
  // trun: version/flags(4), sample_count(4), data_offset(4)
  const dataOffset = read32(seg, trun.offset + 8);
  // default-base-is-moof, so the offset is measured from the start of the moof — and it
  // must land on the first byte AFTER the mdat header, not on the header itself.
  expect(dataOffset).toBe(moofBox.size + 8);
  expect(read32(seg, trun.offset + 4)).toBe(3); // sample_count
});

test('a window picks the samples covering a moment, and the range holding them', () => {
  const f = progressive({ n: 100, size: 10, delta: 1024, timescale: 1024 }); // 1 sample/sec
  const t = audioTrack(f.moov);
  const w = windowAt(t, 10, 5);
  expect(w.from).toBe(10);
  expect(w.to).toBe(15);
  expect(w.time).toBe(10);
  // Contiguous in a progressive file, so one range covers the run.
  expect(w.start).toBe(t.offsets[10]);
  expect(w.end).toBe(t.offsets[14] + t.sizes[14]);
});

test('a window past the end is null rather than an empty fragment', () => {
  const t = audioTrack(progressive({ n: 4, delta: 1024, timescale: 1024 }).moov);
  expect(windowAt(t, 999, 5)).toBe(null);
  expect(mediaSegment(t, 99, 200, new Uint8Array(0), 0, 1).length).toBe(0);
});

test('the MIME comes from the sample entry, not from a guess', () => {
  const t = audioTrack(progressive().moov);
  expect(mimeOf(t)).toBe('audio/mp4; codecs="mp4a.40.2"');
  // A book that is not AAC must not be handed to a decoder under AAC's name — it would
  // fail as a decode error, which reads as a corrupt file rather than an unsupported one.
  const alac = { stsd: box('stsd', b(u32(0), u32(1)), box('alac', b(new Array(8).fill(0)))) };
  expect(mimeOf(alac)).toBe('audio/mp4; codecs="alac"');
});

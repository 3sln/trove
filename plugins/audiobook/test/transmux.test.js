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

// --- box layout, field by field -------------------------------------------------
//
// Everything above tests what the boxes SAY. These test how long they are, which is the
// failure mode that actually bit: a 24-byte matrix where the spec wants 36 shifts every
// field after it, the box still parses as a box, and the decoder answers with
// "the decoder rejected a fragment" and not one word about which field it disliked.

const SPEC = {
  // ISO/IEC 14496-12 payload sizes, excluding the 8-byte box header.
  mvhd: 4 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + 8 + 36 + 24 + 4,   // 100
  tkhd: 4 + 4 + 4 + 4 + 4 + 4 + 8 + 2 + 2 + 2 + 2 + 36 + 8, // 84
  mdhd: 4 + 4 + 4 + 4 + 4 + 2 + 2,                          // 24
  trex: 4 + 4 + 4 + 4 + 4 + 4,                              // 24
  smhd: 4 + 2 + 2,                                          // 8
};

function payloadOf(bytes, path) {
  // Walk to a box and return its payload length. Bounds start past the container header.
  let at = 8;
  let end = bytes.length;
  let found = null;
  for (const want of path) {
    found = findBox(bytes, [want], { at, end });
    if (!found) return null;
    at = found.offset;
    end = found.end;
  }
  return found.end - found.offset;
}

test('every header box in the init segment is exactly the length the spec says', () => {
  const init = initSegment(audioTrack(progressive().moov));
  const moovBox = topLevelBoxes(init).find((x) => x.type === 'moov');
  const inMoov = { at: moovBox.offset + 8, end: moovBox.offset + moovBox.size };

  const len = (path) => {
    let at = inMoov.at;
    let end = inMoov.end;
    let found = null;
    for (const want of path) {
      found = findBox(init, [want], { at, end });
      if (!found) return null;
      at = found.offset;
      end = found.end;
    }
    return found.end - found.offset;
  };

  // A wrong length here is not a cosmetic problem: it is a decoder rejecting every
  // fragment with no indication of why.
  expect(len(['mvhd'])).toBe(SPEC.mvhd);
  expect(len(['trak', 'tkhd'])).toBe(SPEC.tkhd);
  expect(len(['trak', 'mdia', 'mdhd'])).toBe(SPEC.mdhd);
  expect(len(['mvex', 'trex'])).toBe(SPEC.trex);
  expect(len(['trak', 'mdia', 'minf', 'smhd'])).toBe(SPEC.smhd);
});

test('the transformation matrix is 36 bytes, in both headers that carry one', () => {
  // Pinned separately because it is the specific mistake that was made, and because both
  // mvhd and tkhd carry one — fixing a single copy would leave the other shifted.
  const init = initSegment(audioTrack(progressive().moov));
  const moovBox = topLevelBoxes(init).find((x) => x.type === 'moov');
  const inMoov = { at: moovBox.offset + 8, end: moovBox.offset + moovBox.size };
  const mvhd = findBox(init, ['mvhd'], inMoov);
  // The matrix ends 28 bytes before the end of mvhd (pre_defined 24 + next_track_ID 4),
  // and begins 36 before that. Unity's first cell is 0x00010000.
  expect(read32(init, mvhd.end - 28 - 36)).toBe(0x00010000);
  // ...and its last is 0x40000000, which is where a short matrix shows up as garbage.
  expect(read32(init, mvhd.end - 28 - 4)).toBe(0x40000000);
});

test('trun flags are 0x000301, not a byte-order accident', () => {
  const f = progressive();
  const t = audioTrack(f.moov);
  const start = t.offsets[0];
  const seg = mediaSegment(t, 0, 2, f.file.subarray(start, t.offsets[1] + t.sizes[1]), start, 1);
  const moofBox = topLevelBoxes(seg).find((x) => x.type === 'moof');
  const trun = findBox(seg, ['traf', 'trun'], { at: moofBox.offset + 8, end: moofBox.offset + moofBox.size });
  // version(1) + flags(3). Packing these by hand produced 0x030100 the first time, which
  // asks the decoder for fields in an order the entries are not written in.
  expect(seg[trun.offset]).toBe(0);              // version
  expect(read32(seg, trun.offset) & 0xffffff).toBe(0x000301);
  // data-offset-present | sample-duration-present | sample-size-present, and the entry
  // table has to match: two samples, two 4-byte fields each.
  const n = read32(seg, trun.offset + 4);
  expect(n).toBe(2);
  expect(trun.end - trun.offset).toBe(4 + 4 + 4 + n * 8);
});

test('the track reports its own duration, so a stream can declare one', () => {
  // A MediaSource starts at NaN and only learns its length from `endOfStream()`. A book
  // fed a window at a time would therefore have no duration until the last fragment —
  // and until then the seek bar has no scale, its thumb pins to one end, and jumping to
  // a chapter looks like jumping to the end of the book. The tables already know, so
  // `stream.js` declares it up front from this.
  const f = progressive({ n: 100, delta: 1024, timescale: 1024 });
  const t = audioTrack(f.moov);
  expect(t.duration / t.timescale).toBe(100);
  // And it agrees with the samples, which is what makes it safe to trust: a `duration`
  // that disagreed with the fragments would put the end of the bar in the wrong place.
  let summed = 0;
  for (let i = 0; i < t.count; i++) summed += t.deltas[i];
  expect(summed / t.timescale).toBe(100);
});

// --- the index read is bounded ------------------------------------------------
//
// `findMoov` reports `total - offset` for a box claiming to run to the end of the file,
// and its chain branch does not validate the size the header states. Believing one meant
// asking for four hundred megabytes through a MessagePort — which is not slow, it is
// indistinguishable from hung, and is what "Reading the book's structure…" sat on for
// minutes with nothing else to say.

import { readMoovFor } from '../src/book.js';

test('a moov that claims to be the whole file is refused, not fetched', async () => {
  // 500 MB "index" on a 500 MB book: a misparse, not a book. The read must not be issued.
  let requested = 0;
  const read = async (a, b) => { requested += b - a; return new Uint8Array(0); };
  const got = await readMoovFor(read, { found: true, offset: 0, size: 500 * 1024 * 1024 });
  expect(got.error).toMatch(/not an index/);
  expect(requested).toBe(0);
});

test('a real index is read, and its size is reported before the wait', async () => {
  const read = async (a, b) => new Uint8Array(b - a);
  const sizes = [];
  const got = await readMoovFor(read, { found: true, offset: 10, size: 4_900_000 }, (n) => sizes.push(n));
  expect(got.moov.length).toBe(4_900_000);
  // Announced BEFORE the read, so the message names the wait rather than following it.
  expect(sizes).toEqual([4_900_000]);
});

test('a missing or zero-sized index is a reason, not a throw', async () => {
  const read = async () => new Uint8Array(0);
  expect((await readMoovFor(read, { found: false })).error).toMatch(/no moov/);
  expect((await readMoovFor(read, { found: true, offset: 0, size: 0 })).error).toMatch(/no size/);
});

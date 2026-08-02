// Progressive MP4 in, fragmented MP4 out — the piece that lets a book stream.
//
// MediaSource does not take an `.m4b`. It takes an INITIALISATION segment (`ftyp` plus a
// `moov` carrying `mvex`, describing the track and nothing else) followed by MEDIA
// segments (`moof` + `mdat`, each carrying a run of samples with its own timing). An m4b
// is the other shape entirely: one `moov` holding sample tables that point into one
// enormous `mdat`. `appendBuffer` on those bytes fails however they are ordered, which is
// why moving `moov` to the front makes a file seekable without making it appendable.
//
// So the tables are read once and the fragments are built here, on demand. What that buys
// is the whole point of the ranged design: constant memory, seeking anywhere, and audio
// starting after a few hundred kilobytes instead of after 185 megabytes.
//
// The sample data is never rewritten. A fragment's `mdat` is a COPY OF THE ORIGINAL BYTES
// for a run of samples — the codec, the encoding and the frames are untouched, and only
// the boxes describing them are new. That is what makes this a transmux rather than a
// transcode, and it is why it can run in a sandbox with no decoder in it.

import { findBox, readHeader } from './mp4.js';

const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64be = (n) => [...u32be(Math.floor(n / 2 ** 32)), ...u32be(n >>> 0)];
const type4 = (s) => [...s].map((c) => c.charCodeAt(0) & 255);

/** One box: size, type, payload. */
export function box(type, ...parts) {
  let length = 8;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  out.set(u32be(length), 0);
  out.set(type4(type), 4);
  let at = 8;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const bytes = (...n) => Uint8Array.from(n.flat());

/**
 * Everything about the audio track that building fragments needs.
 *
 * Kept as TYPED ARRAYS rather than an array of objects on purpose: a thirteen-hour
 * audiobook is around two million samples, and two million little objects is tens of
 * megabytes of heap to describe bytes we are not even holding.
 *
 * `stsd` is copied out whole and handed to the init segment untouched. It carries the
 * codec configuration — for AAC, the `esds` with its AudioSpecificConfig — and nothing
 * here has any business interpreting it. Copying it verbatim is what makes this work for
 * codecs this file has never heard of.
 *
 * @returns {null | {id, timescale, duration, stsd, count, sizes, offsets, deltas}}
 */
export function audioTrack(moov) {
  for (const trak of traks(moov)) {
    const hdlr = findBox(moov, ['mdia', 'hdlr'], trak);
    if (!hdlr) continue;
    // hdlr: version/flags, pre_defined, handler_type — 'soun' for audio.
    const handler = String.fromCharCode(moov[hdlr.offset + 8], moov[hdlr.offset + 9], moov[hdlr.offset + 10], moov[hdlr.offset + 11]);
    if (handler !== 'soun') continue;

    const mdhd = findBox(moov, ['mdia', 'mdhd'], trak);
    const stsd = findBox(moov, ['mdia', 'minf', 'stbl', 'stsd'], trak);
    const stts = findBox(moov, ['mdia', 'minf', 'stbl', 'stts'], trak);
    const stsz = findBox(moov, ['mdia', 'minf', 'stbl', 'stsz'], trak);
    const stsc = findBox(moov, ['mdia', 'minf', 'stbl', 'stsc'], trak);
    const stco = findBox(moov, ['mdia', 'minf', 'stbl', 'stco'], trak);
    const co64 = findBox(moov, ['mdia', 'minf', 'stbl', 'co64'], trak);
    if (!mdhd || !stsd || !stts || !stsz || !(stco || co64)) continue;

    const v = moov[mdhd.offset];
    const timescale = u32(moov, mdhd.offset + 4 + (v === 1 ? 16 : 8));
    const duration = v === 1 ? u64(moov, mdhd.offset + 24) : u32(moov, mdhd.offset + 16);
    if (!timescale) continue;

    const count = u32(moov, stsz.offset + 8);
    if (!count) continue;

    // Sizes: one fixed size for every sample, or a table when that field is zero.
    const fixed = u32(moov, stsz.offset + 4);
    const sizes = new Uint32Array(count);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < count; i++) sizes[i] = u32(moov, stsz.offset + 12 + i * 4);

    // Durations, expanded from stts's (count, delta) runs. In the TRACK timescale — the
    // fragment writes them back in the same units, so nothing is ever converted and no
    // rounding creeps in across two million samples.
    const deltas = new Uint32Array(count);
    let s = 0;
    const runs = u32(moov, stts.offset + 4);
    for (let i = 0; i < runs && s < count; i++) {
      const at = stts.offset + 8 + i * 8;
      if (at + 8 > stts.end) break;
      const n = u32(moov, at);
      const d = u32(moov, at + 4);
      for (let k = 0; k < n && s < count; k++) deltas[s++] = d;
    }
    // A truncated stts leaves the tail at zero, which would make every later sample
    // instantaneous. Carrying the last known delta is the honest repair.
    for (let i = s; i < count; i++) deltas[i] = deltas[s - 1] || 1024;

    // Offsets: chunk offsets plus the running size of the samples before it in the chunk.
    // Float64 because a file over 4 GB has offsets past what a Uint32 holds, and an m4b
    // that big is a normal thing rather than an edge case.
    const offsets = new Float64Array(count);
    const chunks = u32(moov, (co64 || stco).offset + 4);
    const chunkAt = (i) => (co64 ? u64(moov, co64.offset + 8 + i * 8) : u32(moov, stco.offset + 8 + i * 4));
    const scRuns = stsc ? u32(moov, stsc.offset + 4) : 0;
    const perChunk = (chunkIndex) => {
      let n = 1;
      for (let i = 0; i < scRuns; i++) {
        const at = stsc.offset + 8 + i * 12;
        if (at + 12 > stsc.end) break;
        if (u32(moov, at) - 1 > chunkIndex) break;
        n = u32(moov, at + 4);
      }
      return Math.max(1, n);
    };
    let sample = 0;
    for (let c = 0; c < chunks && sample < count; c++) {
      let at = chunkAt(c);
      for (let k = 0; k < perChunk(c) && sample < count; k++) {
        offsets[sample] = at;
        at += sizes[sample];
        sample++;
      }
    }
    if (sample < count) continue; // tables disagree; not a track we can fragment

    return {
      id: trackIdOf(moov, trak) || 1,
      timescale,
      duration,
      stsd: moov.slice(stsd.offset - 8, stsd.end), // the whole box, header included
      count,
      sizes,
      offsets,
      deltas,
    };
  }
  return null;
}

/**
 * The initialisation segment: what the track IS, with no samples in it.
 *
 * `mvex`/`trex` is the part that makes this fragmented rather than merely empty — without
 * it a decoder reads a movie of zero duration and refuses everything appended after.
 */
export function initSegment(track) {
  const ftyp = box('ftyp', bytes(type4('isom')), bytes(u32be(0x200)), bytes(type4('isom'), type4('iso2'), type4('mp41'), type4('dash')));

  const mvhd = box('mvhd', bytes(
    u32be(0), // version/flags
    u32be(0), u32be(0), // created / modified
    u32be(track.timescale),
    u32be(0), // duration 0: a fragmented movie declares its length as it goes
    u32be(0x00010000), u32be(0x01000000), // rate 1.0, volume 1.0
    u32be(0), u32be(0),
    [0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0], // unity matrix
    u32be(0), u32be(0), u32be(0), u32be(0), u32be(0), u32be(0),
    u32be(track.id + 1), // next track id
  ));

  const tkhd = box('tkhd', bytes(
    [0, 0, 0, 7], // version 0, flags: enabled | in movie | in preview
    u32be(0), u32be(0),
    u32be(track.id),
    u32be(0),
    u32be(0), // duration 0, as above
    u32be(0), u32be(0),
    u32be(0x01000000), // volume 1.0 for an audio track, then reserved
    [0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0],
    u32be(0), u32be(0), // width/height: zero for audio
  ));

  const mdhd = box('mdhd', bytes(
    u32be(0), u32be(0), u32be(0),
    u32be(track.timescale),
    u32be(0),
    [0x55, 0xc4], // language 'und'
    u32be(0).slice(2),
  ));
  const hdlr = box('hdlr', bytes(u32be(0), u32be(0), type4('soun'), u32be(0), u32be(0), u32be(0), [0]));
  const smhd = box('smhd', bytes(u32be(0), u32be(0)));
  const dref = box('dref', bytes(u32be(0), u32be(1)), box('url ', bytes(u32be(1))));
  const dinf = box('dinf', dref);

  // The sample tables are EMPTY here, deliberately: an init segment describes the track,
  // and every sample arrives later inside a fragment with its own timing.
  const stbl = box('stbl',
    track.stsd,
    box('stts', bytes(u32be(0), u32be(0))),
    box('stsc', bytes(u32be(0), u32be(0))),
    box('stsz', bytes(u32be(0), u32be(0), u32be(0))),
    box('stco', bytes(u32be(0), u32be(0))));

  const minf = box('minf', smhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  // trex: the defaults every fragment inherits. Zeroed, because each `trun` states its
  // own sizes and durations — which is what lets a fragment be built from any run of
  // samples without consulting anything else.
  const trex = box('trex', bytes(u32be(0), u32be(track.id), u32be(1), u32be(0), u32be(0), u32be(0)));
  const mvex = box('mvex', trex);
  const moov = box('moov', mvhd, trak, mvex);
  return concat(ftyp, moov);
}

/**
 * One media segment: samples `[from, to)` as `moof` + `mdat`.
 *
 * `data` is the file's bytes for exactly that run — the caller reads them by range and
 * passes them in, so this function holds nothing and can be driven a fragment at a time.
 * `dataStart` is where that buffer begins in the FILE, which is how a sample's absolute
 * offset becomes an index into it.
 *
 * `tfdt` carries the decode time of the first sample, in the track timescale. It is what
 * makes seeking work: append a fragment from the middle of a book and the decoder puts it
 * where it belongs rather than at zero.
 */
export function mediaSegment(track, from, to, data, dataStart, sequence = 1) {
  const n = Math.max(0, Math.min(to, track.count) - from);
  if (!n) return new Uint8Array(0);

  let baseDecodeTime = 0;
  for (let i = 0; i < from; i++) baseDecodeTime += track.deltas[i];

  let payload = 0;
  for (let i = from; i < from + n; i++) payload += track.sizes[i];

  // trun: per-sample duration and size, one pair each. Flags 0x000301 —
  // data-offset-present | sample-duration-present | sample-size-present.
  const trunEntries = new Uint8Array(n * 8);
  for (let i = 0; i < n; i++) {
    trunEntries.set(u32be(track.deltas[from + i]), i * 8);
    trunEntries.set(u32be(track.sizes[from + i]), i * 8 + 4);
  }

  const mfhd = box('mfhd', bytes(u32be(0), u32be(sequence)));
  // tfhd flags 0x020000 — default-base-is-moof, so the data offset below is relative to
  // the start of this `moof` and the fragment is self-contained.
  const tfhd = box('tfhd', bytes([0, 0x02, 0, 0], u32be(track.id)));
  const tfdt = box('tfdt', bytes([1, 0, 0, 0], u64be(baseDecodeTime))); // version 1: 64-bit
  const trunSize = 8 + 4 + 4 + 4 + trunEntries.length;
  const trafSize = 8 + tfhd.length + tfdt.length + trunSize;
  const moofSize = 8 + mfhd.length + trafSize;
  // The offset from the moof to the first byte of sample data — past the mdat header.
  const dataOffset = moofSize + 8;
  const trun = box('trun', bytes([0, 0x03, 0x01], [0]), bytes(u32be(n)), bytes(u32be(dataOffset)), trunEntries);
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);

  const mdatPayload = new Uint8Array(payload);
  let at = 0;
  for (let i = from; i < from + n; i++) {
    const start = track.offsets[i] - dataStart;
    if (start < 0 || start + track.sizes[i] > data.length) return new Uint8Array(0);
    mdatPayload.set(data.subarray(start, start + track.sizes[i]), at);
    at += track.sizes[i];
  }
  return concat(moof, box('mdat', mdatPayload));
}

/**
 * Which samples cover `[seconds, seconds + window)`, and the byte range holding them.
 *
 * The answer a streamer needs before it reads anything: what to fetch, and what to tell
 * `mediaSegment` afterwards. Samples are contiguous in a progressive file, so one range
 * covers the run.
 */
export function windowAt(track, seconds, windowSeconds = 20) {
  const wanted = Math.max(0, seconds) * track.timescale;
  let t = 0;
  let from = 0;
  while (from < track.count && t + track.deltas[from] <= wanted) { t += track.deltas[from]; from++; }
  let to = from;
  let span = 0;
  const limit = windowSeconds * track.timescale;
  while (to < track.count && span < limit) { span += track.deltas[to]; to++; }
  if (to <= from) return null;
  const start = track.offsets[from];
  const end = track.offsets[to - 1] + track.sizes[to - 1];
  return { from, to, start, end, time: t / track.timescale };
}

/** The MIME the codec configuration implies, for `addSourceBuffer`. */
export function mimeOf(track) {
  // The sample entry's own four-character type is the codec: `mp4a` for AAC, `alac`,
  // `ac-3`. Read from the stsd rather than assumed, because a book that is not AAC would
  // otherwise be handed to a decoder under the wrong name and fail as a decode error.
  const h = readHeader(track.stsd, 8 + 8);
  const fourcc = h?.type || 'mp4a';
  // mp4a.40.2 is AAC-LC, which is what an m4b almost always is. The object type sits in
  // the esds; reading it properly is worth doing if anything ever ships AAC-HE.
  return fourcc === 'mp4a' ? 'audio/mp4; codecs="mp4a.40.2"' : `audio/mp4; codecs="${fourcc}"`;
}

// --- small helpers ------------------------------------------------------------

function traks(moov) {
  const out = [];
  const h0 = readHeader(moov, 0);
  const base = h0 && h0.type === 'moov' ? h0.header : 0;
  let at = base;
  for (let guard = 0; guard < 256 && at + 8 <= moov.length; guard++) {
    const h = readHeader(moov, at);
    if (!h || h.size <= 0) break;
    if (h.type === 'trak') out.push({ at: at + h.header, end: at + h.size });
    at += h.size;
  }
  return out;
}

function trackIdOf(moov, trak) {
  const tkhd = findBox(moov, ['tkhd'], trak);
  if (!tkhd) return null;
  const v = moov[tkhd.offset];
  return u32(moov, tkhd.offset + (v === 1 ? 20 : 12));
}

const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u64 = (b, at) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

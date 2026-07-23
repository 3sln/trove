// Validate the M4B chapter/metadata parser against a hand-built MP4 box tree:
// ftyp + moov{ udta{ chpl, meta{ ilst{ ©nam, ©ART, covr } } } }. A fake
// Range-serving fetch stands in for the network, proving the parser locates
// `moov` by walking top-level boxes and extracts chapters, metadata, and cover.

import { test, expect } from 'bun:test';
import { readAudiobookInfo } from '../src/ui/mp4.js';

const enc = new TextEncoder();

function box(type, payload) {
  // MP4 atom types are 4 raw bytes; '©' is the single byte 0xA9 (not UTF-8).
  const t = Uint8Array.from(type, (ch) => ch.charCodeAt(0) & 0xff);
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(t, 4);
  out.set(payload, 8);
  return out;
}
function concat(arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function u64(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function chpl(chapters) {
  const parts = [new Uint8Array([1, 0, 0, 0, 0, chapters.length])]; // version1, flags, reserved, count
  for (const c of chapters) {
    const title = enc.encode(c.title);
    parts.push(u64(Math.round(c.start * 1e7)), new Uint8Array([title.length]), title);
  }
  return box('chpl', concat(parts));
}
function dataBox(typeIndicator, value) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, typeIndicator);
  return box('data', concat([head, value]));
}
function ilst() {
  return box('ilst', concat([
    box('©nam', dataBox(1, enc.encode('The Great Voyage'))),
    box('©ART', dataBox(1, enc.encode('Jane Author'))),
    box('covr', dataBox(13, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))), // fake jpeg
  ]));
}
function meta() {
  return box('meta', concat([new Uint8Array([0, 0, 0, 0]), ilst()])); // fullbox header
}

function buildM4b(chapters) {
  const ftyp = box('ftyp', enc.encode('M4B mp42'));
  const udta = box('udta', concat([chpl(chapters), meta()]));
  const moov = box('moov', udta);
  return concat([ftyp, moov]);
}

function fakeFetch(bytes) {
  return async (url, opts) => {
    const m = /bytes=(\d+)-(\d*)/.exec(opts?.headers?.Range || '');
    const start = m ? +m[1] : 0;
    const end = m && m[2] ? +m[2] : bytes.length - 1;
    const slice = bytes.subarray(start, Math.min(end + 1, bytes.length));
    return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
  };
}

test('parses chapters, metadata and cover from an m4b box tree', async () => {
  const chapters = [
    { title: 'Chapter One', start: 0 },
    { title: 'Chapter Two', start: 65.5 },
    { title: 'Chapter Three', start: 130 },
  ];
  const bytes = buildM4b(chapters);
  const info = await readAudiobookInfo('mock://book.m4b', { fetch: fakeFetch(bytes) });

  expect(info.title).toBe('The Great Voyage');
  expect(info.author).toBe('Jane Author');
  expect(info.chapters.length).toBe(3);
  expect(info.chapters[1].title).toBe('Chapter Two');
  expect(Math.round(info.chapters[1].start)).toBe(66);
  expect(info.cover?.mime).toBe('image/jpeg');
  expect(info.cover.bytes.length).toBe(4);
});

test('returns empty gracefully when no moov present', async () => {
  const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]); // just a tiny ftyp-ish box
  const info = await readAudiobookInfo('mock://x', { fetch: fakeFetch(bytes) });
  expect(info.chapters).toEqual([]);
});

// Cover art: the zip half, and the indexer that ties both halves together.
//
// The m4b half is in mp4.test.js. What is here is the LPF path — a real zip, built by
// fflate and then read back through a reader that only ever sees ranges, which is the
// point: an LPF is as large as the book, so nothing may pull it through memory to reach a
// 60 KB picture.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { centralDirectory, readEntry, locateEntry, entryFor } from '../src/zip.js';
import { index } from '../src/bookIndexer.js';

const JPEG = new Uint8Array([0xff, 0xd8, ...new Array(200).fill(7), 0xff, 0xd9]);

/** A reader over a buffer that counts how much it was asked for. */
function reader(bytes) {
  const stats = { reads: 0, bytes: 0 };
  const read = async (start, end) => {
    const stop = Math.min(end, bytes.length);
    stats.reads++; stats.bytes += Math.max(0, stop - start);
    return bytes.subarray(Math.max(0, start), stop);
  };
  return { read, stats };
}

function lpf({ cover = 'cover.jpg', level = 0, prefix = '' } = {}) {
  const publication = JSON.stringify({
    name: 'A Book', author: 'Someone',
    resources: [{ rel: 'cover', url: cover }],
    readingOrder: [{ url: 'audio/01.mp3', duration: 'PT1M' }],
  });
  return zipSync({
    [`${prefix}publication.json`]: strToU8(publication),
    [`${prefix}${cover}`]: [JPEG, { level }],
    // Something big enough that reading the archive whole would be the wrong answer.
    [`${prefix}audio/01.mp3`]: [new Uint8Array(400_000), { level: 0 }],
  });
}

test('the central directory is read from the tail, not by unzipping the book', async () => {
  const bytes = lpf();
  const { read, stats } = reader(bytes);
  const entries = await centralDirectory(read, bytes.length);
  expect(entries.map((e) => e.name).sort()).toEqual(['audio/01.mp3', 'cover.jpg', 'publication.json']);
  // Two reads — the tail and the directory — and nowhere near the whole archive.
  expect(stats.reads).toBe(2);
  expect(stats.bytes).toBeLessThan(bytes.length / 2);
});

test('a stored entry reads back byte for byte, and a deflated one inflates', async () => {
  for (const level of [0, 6]) {
    const bytes = lpf({ level });
    const { read } = reader(bytes);
    const entries = await centralDirectory(read, bytes.length);
    const got = await readEntry(read, entryFor(entries, 'cover.jpg'));
    expect([...got]).toEqual([...JPEG]);
  }
});

test('the data offset comes from the LOCAL header, not the directory', async () => {
  // The two carry their own name and extra fields and the lengths routinely differ, so
  // assuming the directory's lands the read a few bytes into the image.
  const bytes = lpf({ level: 0 });
  const { read } = reader(bytes);
  const entries = await centralDirectory(read, bytes.length);
  const at = await locateEntry(read, entryFor(entries, 'cover.jpg'));
  expect([...bytes.subarray(at, at + JPEG.length)]).toEqual([...JPEG]);
});

test('a book zipped one directory too deep still finds its cover', async () => {
  const bytes = lpf({ prefix: 'My Book/' });
  const node = { id: 'itm', name: 'book.lpf', contentType: 'application/lpf+zip', size: bytes.length };
  const { read } = reader(bytes);
  const out = await index(node, { readRange: read });
  expect(out.metadata.thumbnail.contentType).toBe('image/jpeg');
});

test('a stored cover is POINTED at; a deflated one is carried', async () => {
  const node = (bytes) => ({ id: 'itm', name: 'book.lpf', contentType: 'application/lpf+zip', size: bytes.length });

  // Stored: the bytes in the zip ARE the image, so the contribution is a range and stays
  // tiny however large the picture is.
  const stored = lpf({ level: 0 });
  const a = await index(node(stored), { readRange: reader(stored).read });
  expect(a.metadata.thumbnail.range).toBeTruthy();
  expect(a.metadata.thumbnail.src).toBeUndefined();
  const { start, end } = a.metadata.thumbnail.range;
  expect([...stored.subarray(start, end)]).toEqual([...JPEG]);

  // Deflated: there is nothing to point at, so it is carried — and only because it is small.
  const packed = lpf({ level: 6 });
  const b = await index(node(packed), { readRange: reader(packed).read });
  expect(b.metadata.thumbnail.src.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(b.metadata.thumbnail.range).toBeUndefined();
});

test('a book with no cover contributes no thumbnail rather than failing', async () => {
  // An indexer that threw would mark the node failed and raise a standing issue about a
  // missing picture. A book without cover art is still a book.
  const bytes = zipSync({ 'publication.json': strToU8('{"name":"No art","readingOrder":[]}') });
  const node = { id: 'itm', name: 'book.lpf', contentType: 'application/lpf+zip', size: bytes.length };
  const out = await index(node, { readRange: reader(bytes).read });
  // Still a contribution — the title is worth having — but no thumbnail key, which is the
  // one the grid keys off. A grid tile falls back to its icon rather than drawing nothing.
  expect(out.metadata?.thumbnail).toBeUndefined();
  expect(out.metadata?.book?.title).toBe('No art');
  // And so is something that is not an audiobook at all.
  const junk = new Uint8Array(1024);
  expect(await index({ id: 'x', name: 'x.m4b', size: junk.length }, { readRange: reader(junk).read })).toEqual({});
});

test('an LPF book is indexed as fully as an m4b', async () => {
  // The promise the shared record makes: a reader of the contribution cannot tell which
  // container it came from. An LPF used to arrive with three fields and one tag against
  // an m4b's thirteen and seven — so it was missing from `#narrator:`, `#series:`,
  // `#genre:`, `#publisher:`, `#year:` and `#language:`, and the player's byline had no
  // "read by". Everything here was already in the manifest; nothing was reading it.
  const manifest = {
    conformsTo: 'https://www.w3.org/TR/audiobooks/',
    name: 'The Quick and the Kept',
    author: 'Honour Rae',
    readBy: 'Luke Daniels',
    publisher: 'Podium Audio',
    inLanguage: 'en',
    datePublished: '2022-11-08',
    genre: ['Epic', 'Sword & Sorcery'],
    belongsTo: { name: 'All the Skills', position: 2 },
    duration: 'PT2H',
    readingOrder: [
      { url: 'audio/01.mp3', duration: 'PT1H', name: 'Chapter One' },
      { url: 'audio/02.mp3', duration: 'PT1H', name: 'Chapter Two' },
    ],
    resources: [{ url: 'cover.jpg', rel: 'cover', encodingFormat: 'image/jpeg' }],
  };
  const zip = zipSync({
    'publication.json': strToU8(JSON.stringify(manifest)),
    'cover.jpg': Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    'audio/01.mp3': new Uint8Array(64),
    'audio/02.mp3': new Uint8Array(64),
  }, { level: 0 });

  const node = { id: 'i', name: 'book.lpf', contentType: 'application/lpf+zip', size: zip.length };
  const out = await index(node, { readRange: reader(zip).read });

  expect(out.metadata.book).toEqual({
    title: 'The Quick and the Kept',
    author: 'Honour Rae',
    narrator: 'Luke Daniels',
    series: 'All the Skills',
    part: 2,
    genre: 'Epic, Sword & Sorcery',
    publisher: 'Podium Audio',
    year: '2022',
    language: 'en',
    duration: 7200,
  });
  // The same seven tags an m4b produces — this is what makes a book findable.
  expect(Object.keys(out.tags).sort()).toEqual(
    ['author', 'genre', 'language', 'narrator', 'publisher', 'series', 'year'],
  );
  // An LPF's tracks ARE its chapters, laid onto one timeline.
  expect(out.metadata.chapters).toEqual([
    { time: 0, title: 'Chapter One' },
    { time: 3600, title: 'Chapter Two' },
  ]);
  // Stored (level 0), so the cover is pointed at rather than carried.
  expect(out.metadata.thumbnail.contentType).toBe('image/jpeg');
  expect(out.metadata.thumbnail.range.end - out.metadata.thumbnail.range.start).toBe(8);
});

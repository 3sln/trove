// Reading ONE entry out of a zip we can only read pieces of.
//
// `fflate` unzips a whole archive from a whole buffer, which is the right tool when you
// have the buffer. An LPF is a book — its entries ARE the audio — so it is as large as the
// audiobook, and pulling it through an indexer's memory cap to reach a 60 KB cover is not
// a trade anyone would make.
//
// A zip is readable backwards, which is what makes this cheap. The End of Central Directory
// record is last; it names where the central directory starts; the directory lists every
// entry with its name, its compressed size and where its local header sits. So: one read of
// the tail, one of the directory, one of the entry. Three reads regardless of how big the
// book is.
//
// Deliberately minimal — this reads a directory and one entry. It is not a zip library, and
// anything beyond "find the cover" belongs in fflate with the whole buffer in hand.

import { inflateSync } from 'fflate';

const EOCD = 0x06054b50; // PK\x05\x06
const CDH = 0x02014b50;  // PK\x01\x02
/** The EOCD is 22 bytes plus a comment of up to 64 KiB, so that is how far back to look. */
const TAIL = 66 * 1024;

const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * Every entry in the archive's central directory.
 *
 * @param {(start: number, end: number) => Promise<Uint8Array>} read half-open
 * @returns {Promise<Array<{name: string, offset: number, compressedSize: number, size: number, method: number}>|null>}
 */
export async function centralDirectory(read, total) {
  const from = Math.max(0, total - TAIL);
  const tail = await read(from, total);
  // Scanned BACKWARDS: the signature can also appear inside a comment or inside stored
  // data, and the real record is the last one.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = u16(tail, eocd + 10);
  const size = u32(tail, eocd + 12);
  const offset = u32(tail, eocd + 16);
  // 0xffffffff is zip64's "look in the zip64 record instead". An LPF that large is a book
  // nobody has, and guessing at a field that says "this is not the field" would be worse
  // than declining.
  if (offset === 0xffffffff || size === 0xffffffff) return null;

  const dir = await read(offset, offset + size);
  const out = [];
  let at = 0;
  for (let i = 0; i < count && at + 46 <= dir.length; i++) {
    if (u32(dir, at) !== CDH) break;
    const nameLen = u16(dir, at + 28);
    const extraLen = u16(dir, at + 30);
    const commentLen = u16(dir, at + 32);
    out.push({
      method: u16(dir, at + 10),
      compressedSize: u32(dir, at + 20),
      size: u32(dir, at + 24),
      // Where the entry's LOCAL header is — not its data, which sits past a second
      // name and extra field whose lengths only that header knows.
      offset: u32(dir, at + 42),
      name: new TextDecoder().decode(dir.subarray(at + 46, at + 46 + nameLen)),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * One entry's bytes.
 *
 * The local header repeats the name and carries its own extra field, and the two lengths
 * are routinely different from the central directory's — so the data offset has to come
 * from the local header rather than being assumed.
 *
 * Method 0 is stored and 8 is deflate; a JPEG cover is usually stored, because deflating
 * an already-compressed image buys nothing. Anything else is a compression method this
 * does not implement, and saying so beats returning noise.
 */
export async function locateEntry(read, entry) {
  const header = await read(entry.offset, entry.offset + 30);
  if (header.length < 30 || u32(header, 0) !== 0x04034b50) return null;
  // From the LOCAL header, not the central directory: both carry a name and an extra
  // field, and their lengths routinely differ, so assuming the directory's would land the
  // read a few bytes into the data.
  return entry.offset + 30 + u16(header, 26) + u16(header, 28);
}

export async function readEntry(read, entry) {
  const dataAt = await locateEntry(read, entry);
  if (dataAt == null) return null;
  const raw = await read(dataAt, dataAt + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return inflateSync(raw, { out: new Uint8Array(entry.size) });
    } catch {
      return null;
    }
  }
  return null;
}

/** Find an entry by path, tolerating a book zipped one directory too deep. */
export function entryFor(entries, path) {
  return entries.find((e) => e.name === path)
    || entries.find((e) => e.name.endsWith(`/${path}`))
    || null;
}

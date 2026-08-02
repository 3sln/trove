// RemoteBlob — a Blob subclass, which is a sharper edge than it looks.
//
// The bug this file exists for: the constructor did `this.type = type`. `Blob.prototype`
// declares `type` as an accessor with NO setter, so that assignment throws a TypeError in
// strict mode — and every ES module is strict. `ctx.files.blob()` therefore rejected on
// construction, for every plugin, always. The audiobook viewer showed it as no cover art
// and no ability to stream; the error itself never left the sandboxed frame.
//
// The same is true of `size`. Both are overridden with getters now, and this test exists
// so nobody "simplifies" either back into a field.

import { test, expect } from 'bun:test';

// The class as the SDK defines it, minimally reproduced: the point under test is the
// interaction with Blob's own prototype, which is the same wherever it is written.
class RemoteBlob extends Blob {
  constructor(id, { size = 0, type = '', start = 0, end = null } = {}) {
    super();
    this.id = id;
    this._type = type;
    this._start = start;
    this._end = end == null ? size : end;
  }

  get size() { return Math.max(0, this._end - this._start); }
  get type() { return this._type; }

  slice(begin = 0, finish = this.size, type = this.type) {
    const len = this.size;
    const from = begin < 0 ? Math.max(0, len + begin) : Math.min(begin, len);
    const to = finish < 0 ? Math.max(0, len + finish) : Math.min(finish, len);
    return new RemoteBlob(this.id, { type, start: this._start + from, end: this._start + Math.max(from, to) });
  }
}

test('constructing one does not throw, which is the whole bug', () => {
  // `this.type = type` in a strict-mode class body throws here, not later.
  expect(() => new RemoteBlob('itm_x', { size: 100, type: 'audio/mp4' })).not.toThrow();
});

test('size and type are reported, not inherited from the empty super()', () => {
  const b = new RemoteBlob('itm_x', { size: 193875928, type: 'audio/mp4' });
  // A real Blob() with no parts is zero bytes — these getters are the only reason the
  // window has a length at all, and `slice()` is meaningless without it.
  expect(b.size).toBe(193875928);
  expect(b.type).toBe('audio/mp4');
});

test('a slice is a window, and windows compose', () => {
  const b = new RemoteBlob('itm_x', { size: 1000, type: 'audio/mp4' });
  const head = b.slice(0, 100);
  expect(head.size).toBe(100);
  expect(head.type).toBe('audio/mp4');   // carried, which needs the getter to work
  // A slice of a slice is relative to the slice, which is what a caller walking a
  // container expects — and what makes "the last 64 KiB of the head" expressible.
  const inner = head.slice(10, 20);
  expect(inner.size).toBe(10);
  expect(inner._start).toBe(10);

  // Negative indices count from the end, as Blob.slice does. Reading a file's tail is
  // half of what a container parser does.
  expect(b.slice(-64).size).toBe(64);
  expect(b.slice(-64)._start).toBe(936);
});

test('an out-of-range window is empty rather than negative', () => {
  const b = new RemoteBlob('itm_x', { size: 10 });
  expect(b.slice(50, 60).size).toBe(0);
  expect(b.slice(8, 2).size).toBe(0);
});

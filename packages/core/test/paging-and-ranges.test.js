// Two things that were quietly wrong in ways no assertion could see, because the
// server answered confidently either way: which BYTES a range request gets, and which
// ITEMS the second page of a listing gets. Both produce well-formed, plausible answers
// when they're broken.

import { test, expect } from 'bun:test';
import { MemoryStorage, MemoryStore, SqliteStore, LocalSqliteProvider } from '../src/index.js';

// --- ranges -------------------------------------------------------------------

test('a suffix range serves the END of the object, not the front', async () => {
  const storage = new MemoryStorage();
  const body = new TextEncoder().encode('0123456789');
  await storage.put('k', body);

  // `bytes=-4` is "the last 4 bytes" (RFC 9110 §14.1.4). Read as `{start: 0, end: 4}`
  // it served "01234" under a 206 claiming to be the requested range — a wrong answer
  // the client has no way to detect, and one that media players hit routinely when
  // probing a container's trailer.
  const res = await storage.get('k', { range: { suffix: 4 } });
  expect(await text(res.stream)).toBe('6789');
  expect(res.range).toEqual({ start: 6, end: 9, total: 10 });

  // A suffix longer than the object is the whole object, not an error.
  const all = await storage.get('k', { range: { suffix: 99 } });
  expect(await text(all.stream)).toBe('0123456789');
});

test('an empty file is readable, not "range not satisfiable"', async () => {
  const storage = new MemoryStorage();
  await storage.put('empty', new Uint8Array(0));

  // Every read path asks for a range: the indexer caps at maxIndexBytes, the text
  // viewer caps at its own limit. On a 0-byte object `end = total - 1` is -1, so both
  // threw — leaving every empty file permanently un-indexable (a standing issue whose
  // Retry re-ran the same failure) and unopenable.
  const res = await storage.get('empty', { range: { start: 0, end: 1023 } });
  expect(await text(res.stream)).toBe('');
  expect(res.range).toBe(null); // nothing partial about it; serve a plain 200
  expect(res.size).toBe(0);
});

test('a range past the end of the object is still refused', async () => {
  const storage = new MemoryStorage();
  await storage.put('k', new TextEncoder().encode('abc'));
  await expect(storage.get('k', { range: { start: 10, end: 20 } })).rejects.toThrow(/not satisfiable/i);
});

// --- pagination ---------------------------------------------------------------

const stores = [
  ['memory', async () => new MemoryStore()],
  ['sqlite', async () => {
    const s = new SqliteStore({ provider: new LocalSqliteProvider({ path: ':memory:' }) });
    await s.init();
    return s;
  }],
];

for (const [label, make] of stores) {
  test(`${label}: paging doesn't skip an item when the collection changes underneath it`, async () => {
    const store = await make();
    if (store.init && label === 'memory') await store.init();
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
    const made = {};
    for (const name of names) made[name] = await store.create({ name, collectionId: 'default' });

    const first = await store.listItems('default', { limit: 2, sort: 'name' });
    expect(first.items.map((i) => i.name)).toEqual(['a.txt', 'b.txt']);
    expect(first.nextCursor).toBeTruthy();

    // Someone deletes an item from BEFORE the cut. Under an offset cursor the next
    // page starts at row 2 of a now-4-row list — 'c.txt' shifts into the slot we
    // already read past and is never seen again. With no folders, "load more" is the
    // only way to reach it, so the file simply vanishes until a full refresh.
    await store.remove(made['a.txt'].id);

    const second = await store.listItems('default', { limit: 2, sort: 'name', cursor: first.nextCursor });
    expect(second.items.map((i) => i.name)).toEqual(['c.txt', 'd.txt']);

    // And an insert before the cut doesn't serve a row twice.
    await store.create({ name: 'aa.txt', collectionId: 'default' });
    const third = await store.listItems('default', { limit: 2, sort: 'name', cursor: second.nextCursor });
    expect(third.items.map((i) => i.name)).toEqual(['e.txt']);
    expect(third.nextCursor).toBe(null);
  });

  test(`${label}: paging is stable when the sort column has duplicates`, async () => {
    const store = await make();
    if (store.init && label === 'memory') await store.init();
    // Same size on every item: without `id` as a tiebreaker the order between them is
    // undefined, and a cursor into an undefined order loses or repeats rows.
    for (const name of ['one', 'two', 'three', 'four']) {
      await store.create({ name, collectionId: 'default', size: 100 });
    }
    const seen = [];
    let cursor = null;
    do {
      const page = await store.listItems('default', { limit: 2, sort: 'size', cursor });
      seen.push(...page.items.map((i) => i.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['four', 'one', 'three', 'two']);
  });

  test(`${label}: listSealed spans the trash, and only its sealed half`, async () => {
    const store = await make();
    if (store.init && label === 'memory') await store.init();
    const sealed = { fingerprint: 'aa', chunkSize: 1024 };
    await store.create({ name: 'a.txt', collectionId: 'default', encryption: sealed });
    const b = await store.create({ name: 'b.txt', collectionId: 'default', encryption: sealed });
    await store.create({ name: 'c.txt', collectionId: 'default' });
    await store.softDelete(b.id, Date.now());

    // A trashed object keeps its bytes and stays sealed with whatever sealed it, so a key
    // rotation has to move it before that key can be retired — and `listItems` cannot see
    // it, which is the whole reason this method exists. Paged one at a time, because the
    // cursor has to hold across the live/trashed boundary too.
    const seen = [];
    let cursor = null;
    do {
      const page = await store.listSealed('default', { limit: 1, cursor });
      seen.push(...page.items.map((i) => i.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['a.txt', 'b.txt']);
    expect((await store.listItems('default')).items.map((i) => i.name)).toEqual(['a.txt', 'c.txt']);
  });
}

test('purging a trashed item leaves a live file of the same name alone', async () => {
  const store = new MemoryStore();
  await store.init();
  const a = await store.create({ name: 'notes.md', collectionId: 'default' });
  await store.softDelete(a.id); // frees the name, on purpose
  const b = await store.create({ name: 'notes.md', collectionId: 'default' });

  // Emptying the trash used to de-index the name unconditionally — and by now that key
  // belonged to `b`. The live file then stopped answering name lookups (so
  // `trove:default?name=notes.md` broke) and stopped being seen by the uniqueness
  // check, so the next upload created a SECOND row under the same name.
  await store.remove(a.id);

  expect((await store.getByName('default', 'notes.md'))?.id).toBe(b.id);
  await expect(store.create({ name: 'notes.md', collectionId: 'default' })).rejects.toThrow(/exists/i);
});

async function text(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

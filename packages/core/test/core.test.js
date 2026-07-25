// End-to-end exercise of the core: storage contract, VFS tree ops, resumable
// multipart upload, and hybrid search. Runs against in-memory backends so it's
// fast and offline. `bun test` (or `node --test` with light shims).

import { test, expect } from 'bun:test';
import {
  createVfs, MemoryStorage, MemoryStore, FilesystemStorage,
  SearchService, LocalHashEmbedding, TroveError, normalizePath, joinPath,
} from '../src/index.js';

async function collect(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

test('path helpers reject traversal', () => {
  expect(normalizePath('/a//b/')).toBe('/a/b');
  expect(() => normalizePath('/a/../b')).toThrow();
  expect(joinPath('/a', 'b')).toBe('/a/b');
});

test('storage backend: put/get/head/range/delete', async () => {
  const s = new MemoryStorage();
  const bytes = new TextEncoder().encode('hello world');
  const info = await s.put('k1', bytes, { contentType: 'text/plain' });
  expect(info.size).toBe(11);
  const head = await s.head('k1');
  expect(head.size).toBe(11);
  const { stream } = await s.get('k1', { range: { start: 0, end: 4 } });
  expect(new TextDecoder().decode(await collect(stream))).toBe('hello');
  await s.delete('k1');
  await expect(s.head('k1')).rejects.toThrow(TroveError);
});

test('multipart round-trip (memory)', async () => {
  const s = new MemoryStorage();
  const id = await s.createMultipart('big');
  const p1 = await s.putPart('big', id, 1, new Uint8Array([1, 2, 3]));
  const p2 = await s.putPart('big', id, 2, new Uint8Array([4, 5]));
  const res = await s.completeMultipart('big', id, [p2, p1]);
  expect(res.size).toBe(5);
  const { stream } = await s.get('big');
  expect([...(await collect(stream))]).toEqual([1, 2, 3, 4, 5]);
});

test('vfs: a collection is a flat set of uniquely-named items', async () => {
  const vfs = await createVfs();
  const file = await vfs.writeFile('note.txt', 'the quick brown fox', { contentType: 'text/plain' });
  expect(file.name).toBe('note.txt');
  expect(file.collectionId).toBe('default');
  // No hierarchy: nothing carries a parent or a path.
  expect(file.parentId).toBeUndefined();
  expect(file.path).toBeUndefined();

  const { items } = await vfs.list('default');
  expect(items.map((i) => i.name)).toEqual(['note.txt']);

  const { stream } = await vfs.readStream(file.id);
  expect(new TextDecoder().decode(await collect(stream))).toBe('the quick brown fox');

  // An item resolves by id, by bare name, or by its trove: URI.
  expect((await vfs.stat(file.id)).id).toBe(file.id);
  expect((await vfs.stat('note.txt')).id).toBe(file.id);
  expect((await vfs.stat('trove:default?name=note.txt')).id).toBe(file.id);
  expect((await vfs.stat(`trove:default?id=${file.id}`)).id).toBe(file.id);

  const renamed = await vfs.rename(file.id, 'notes.txt');
  expect(renamed.name).toBe('notes.txt');
  expect(await vfs.find('note.txt')).toBe(null); // the old name is free again

  await vfs.remove(file.id);
  await expect(vfs.stat('notes.txt')).rejects.toThrow();
});

test('vfs: names are unique per collection, so a trove: link resolves to one item', async () => {
  const vfs = await createVfs();
  await vfs.writeFile('dup.txt', 'first');
  // Writing the same name again REPLACES the item's bytes rather than making a second.
  const again = await vfs.writeFile('dup.txt', 'second');
  const { items } = await vfs.list('default');
  expect(items.length).toBe(1);
  expect(again.name).toBe('dup.txt');

  // An upload negotiates a free name instead of clobbering (see createUpload).
  const plan = await vfs.createUpload({ name: 'dup.txt', size: 1 });
  expect(plan.name).toBe('dup (1).txt'); // suffix before the extension

  // Renaming onto a taken name is refused, not silently merged.
  const other = await vfs.writeFile('other.txt', 'x');
  await expect(vfs.rename(other.id, 'dup.txt')).rejects.toThrow(/exists/i);
});

test('vfs: resumable multipart upload lifecycle', async () => {
  const vfs = await createVfs();
  const plan = await vfs.createUpload({ name: 'movie.bin', size: 5, contentType: 'application/octet-stream' });
  expect(['direct', 'presign', 'single', 'direct-single']).toContain(plan.strategy);

  // memory storage → direct multipart
  await vfs.uploadPart(plan.uploadId, 1, new Uint8Array([9, 9, 9]));
  const status = await vfs.uploadStatus(plan.uploadId);
  expect(status.received).toContain(1);
  await vfs.uploadPart(plan.uploadId, 2, new Uint8Array([1, 1]));
  const node = await vfs.completeUpload(plan.uploadId);
  expect(node.size).toBe(5);
});

test('search: hybrid semantic + keyword finds content', async () => {
  const vfs = await createVfs();
  await vfs.writeFile('recipes.md', 'How to bake sourdough bread with a crispy crust and open crumb.', { contentType: 'text/markdown' });
  await vfs.writeFile('taxes.md', 'Filing quarterly estimated tax payments for freelancers.', { contentType: 'text/markdown' });

  // keyword hit
  const kw = await vfs.searchQuery('sourdough');
  expect(kw[0].node.name).toBe('recipes.md');

  // name search still works even without content match
  const byName = await vfs.searchQuery('taxes');
  expect(byName.some((r) => r.node.name === 'taxes.md')).toBe(true);
});

test('filesystem backend put/get with range', async () => {
  const dir = `/tmp/trove-test-${Math.random().toString(36).slice(2)}`;
  const s = new FilesystemStorage({ root: dir });
  await s.put('f1', new TextEncoder().encode('abcdefgh'));
  const { stream, range } = await s.get('f1', { range: { start: 2, end: 4 } });
  expect(new TextDecoder().decode(await collect(stream))).toBe('cde');
  expect(range.total).toBe(8);
});

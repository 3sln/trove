// End-to-end exercise of the core: storage contract, VFS tree ops, resumable
// multipart upload, and hybrid search. Runs against in-memory backends so it's
// fast and offline. `bun test` (or `node --test` with light shims).

import { test, expect } from 'bun:test';
import {
  createVfs, MemoryStorage, MemoryStore, FilesystemStorage,
  SearchService, LocalHashEmbedding, TroveError, isValidItemName, extname,
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

test('an item name is the whole address, so it may not contain a separator', () => {
  expect(isValidItemName('notes.txt')).toBe(true);
  expect(isValidItemName('a b & c.md')).toBe(true);
  // A slash would split under the `trove:collection/name` shorthand.
  expect(isValidItemName('a/b.txt')).toBe(false);
  expect(isValidItemName('.')).toBe(false);
  expect(isValidItemName('..')).toBe(false);
  expect(isValidItemName('')).toBe(false);
  expect(isValidItemName('x'.repeat(256))).toBe(false);
  expect(isValidItemName('bad\u0000name')).toBe(false);

  expect(extname('a.TXT')).toBe('.txt');
  expect(extname('noext')).toBe('');
  expect(extname('.hidden')).toBe(''); // a dotfile has no extension
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
  // A 3-byte part size so 5 bytes is genuinely two parts. It used to declare 5 bytes
  // against the 8 MiB default — a ONE-part plan — then upload two parts and assert the
  // node was 5 bytes. It passed because the recorded size was the client's declared
  // number; the object in the store only ever held part 1.
  const vfs = await createVfs({ uploadPartSize: 3 });
  const plan = await vfs.createUpload({ name: 'movie.bin', size: 5, contentType: 'application/octet-stream' });
  expect(['direct', 'presign', 'single', 'direct-single']).toContain(plan.strategy);
  expect(plan.partCount).toBe(2);

  // memory storage → direct multipart
  await vfs.uploadPart(plan.uploadId, 1, new Uint8Array([9, 9, 9]));
  const status = await vfs.uploadStatus(plan.uploadId);
  expect(status.received).toContain(1);
  await vfs.uploadPart(plan.uploadId, 2, new Uint8Array([1, 1]));
  const node = await vfs.completeUpload(plan.uploadId);
  expect(node.size).toBe(5);
});

test('an upload records the bytes that arrived, not the size the client claimed', async () => {
  const vfs = await createVfs({ uploadPartSize: 3 });
  // Declare one byte, send three. `create` checked the declaration and nothing checked
  // the delivery, so both the per-file limit and the recorded size took the client's
  // word for it.
  const plan = await vfs.createUpload({ name: 'liar.bin', size: 1 });
  await vfs.uploadPart(plan.uploadId, 1, new Uint8Array([1, 2, 3]));
  const node = await vfs.completeUpload(plan.uploadId);
  expect(node.size).toBe(3);

  // And a part the plan never asked for is refused rather than silently orphaned.
  const two = await vfs.createUpload({ name: 'stray.bin', size: 1 });
  await expect(vfs.uploadPart(two.uploadId, 4, new Uint8Array([0]))).rejects.toThrow(/outside this upload/i);
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

test('two uploads racing for the same name both survive', async () => {
  const vfs = await createVfs();
  const read = async (id) => new TextDecoder().decode(await collect((await vfs.readStream(id)).stream));

  // Both negotiate before either completes, so both are told "note.txt" is free —
  // neither item exists yet. An unconditional replace at completion would destroy
  // whichever landed first, silently.
  const a = await vfs.createUpload({ name: 'note.txt', size: 5 });
  const b = await vfs.createUpload({ name: 'note.txt', size: 5 });
  expect(a.name).toBe('note.txt');
  expect(b.name).toBe('note.txt');
  await vfs.uploadPart(a.uploadId, 1, new TextEncoder().encode('AAAAA'));
  await vfs.uploadPart(b.uploadId, 1, new TextEncoder().encode('BBBBB'));
  const na = await vfs.completeUpload(a.uploadId);
  const nb = await vfs.completeUpload(b.uploadId);

  expect(na.id).not.toBe(nb.id);
  expect(await read(na.id)).toBe('AAAAA');
  expect(await read(nb.id)).toBe('BBBBB');
  expect((await vfs.list('default')).items.map((i) => i.name).sort()).toEqual(['note (1).txt', 'note.txt']);

  // An explicit overwrite still replaces in place — that's a request, not a collision.
  const o = await vfs.createUpload({ name: 'note.txt', size: 5, overwrite: true });
  await vfs.uploadPart(o.uploadId, 1, new TextEncoder().encode('CCCCC'));
  const no = await vfs.completeUpload(o.uploadId);
  expect(no.id).toBe(na.id);
  expect(await read(no.id)).toBe('CCCCC');
});

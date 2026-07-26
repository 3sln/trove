// The two registries, and the split between them.
//
// TaskRegistry is in-flight and ephemeral; IssueRegistry is standing and durable. Most
// of what is worth testing here is that neither pretends to be the other: a task can't
// come back from the dead, and an issue can't be cleared by anything except the success
// that actually fixes it.

import { test, expect } from 'bun:test';
import { TaskRegistry, IssueRegistry, MemoryKV, createVfs, MemoryStorage } from '../src/index.js';

// --- tasks -------------------------------------------------------------------

test('a task reports determinate progress, or admits it does not know', async () => {
  const tasks = new TaskRegistry();
  const known = tasks.start({ title: 'Reindexing', total: 10, unit: 'items' });
  known.progress({ done: 4 });
  expect(tasks.get(known.id)).toMatchObject({ done: 4, total: 10, unit: 'items', status: 'running' });

  // No total is a legitimate answer, and must survive as null — a caller that doesn't
  // know how much work there is must not have one invented for it downstream.
  const unknown = tasks.start({ title: 'Thinking' });
  unknown.progress({ done: 3 });
  expect(tasks.get(unknown.id).total).toBe(null);
});

test('run() finishes a task however the work ends', async () => {
  const tasks = new TaskRegistry();
  await tasks.run({ title: 'ok' }, async () => 'fine');
  expect(tasks.list()[0]).toMatchObject({ title: 'ok', status: 'done' });

  // The reason run() exists: a `start` whose owner throws before succeed/fail leaves a
  // task spinning in the UI forever, describing work that stopped long ago.
  await expect(tasks.run({ title: 'boom' }, async () => { throw new Error('nope'); })).rejects.toThrow('nope');
  expect(tasks.list().find((t) => t.title === 'boom')).toMatchObject({ status: 'failed', error: 'nope' });
});

test('cancelling marks the task at once and aborts the signal', async () => {
  const tasks = new TaskRegistry();
  let observed = null;
  const done = tasks.run({ title: 'long', cancellable: true }, async (task) => {
    for (let i = 0; i < 100; i++) {
      if (task.cancelled) { observed = i; return 'stopped'; }
      await new Promise((r) => setTimeout(r, 1));
    }
    return 'ran to completion';
  });
  await new Promise((r) => setTimeout(r, 5));
  expect(tasks.cancel(tasks.list()[0].id)).toBe(true);
  await done;
  expect(observed).not.toBe(null); // the work actually noticed
  // Marked immediately rather than when the worker gets around to it — a Cancel button
  // that does nothing visible for a second reads as broken.
  expect(tasks.list()[0].status).toBe('cancelled');
});

test('a finished task is final — a late callback cannot resurrect it', async () => {
  const tasks = new TaskRegistry();
  const handle = tasks.start({ title: 'x', cancellable: true, total: 10 });
  tasks.cancel(handle.id);
  // Work that hasn't noticed the cancel yet keeps reporting; none of it may take effect.
  handle.progress({ done: 9 });
  handle.succeed('surely not');
  expect(tasks.get(handle.id)).toMatchObject({ status: 'cancelled', done: 0 });
});

test('finished tasks are retained briefly, then pruned', async () => {
  let now = 1000;
  const tasks = new TaskRegistry({ retainMs: 100, now: () => now });
  tasks.start({ title: 'a' }).succeed();
  // Retained so a client polling at 1 Hz still sees a task that began and ended
  // between two polls.
  expect(tasks.list()).toHaveLength(1);
  now += 101;
  expect(tasks.list()).toHaveLength(0);
});

test('tasks are listed running-first, and scoped to what the caller may see', () => {
  const tasks = new TaskRegistry();
  tasks.start({ title: 'finished' }).succeed();
  tasks.start({ title: 'running' });
  expect(tasks.list().map((t) => t.title)).toEqual(['running', 'finished']);

  tasks.start({ title: 'theirs', collectionId: 'secret' });
  tasks.start({ title: 'mine', collectionId: 'default' });
  const visible = tasks.list({ collectionIds: ['default'], includeGlobal: false }).map((t) => t.title);
  expect(visible).toEqual(['mine']);
});

// --- issues ------------------------------------------------------------------

const registry = () => new IssueRegistry({ kv: new MemoryKV() });

test('raising the same problem twice updates it instead of piling up', async () => {
  const issues = registry();
  let now = 1000;
  issues.now = () => now;
  await issues.raise({ kind: 'index', subject: 'itm_1', title: 'first' });
  now = 5000;
  await issues.raise({ kind: 'index', subject: 'itm_1', title: 'second' });

  const list = await issues.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ title: 'second', count: 2, firstAt: 1000, lastAt: 5000 });
  // firstAt is kept deliberately: "failing since 09:14" is the useful fact, and it
  // would be lost if every recurrence reset the clock.
});

test('an issue is cleared by the success that fixes it', async () => {
  const issues = registry();
  await issues.raise({ kind: 'index', subject: 'itm_1', title: 'broken' });
  await issues.clear('index', 'itm_1');
  expect(await issues.list()).toEqual([]);
  // Clearing something that isn't there is not an error — the success path calls this
  // unconditionally.
  await issues.clear('index', 'itm_1');
});

test('retrying runs the registered handler and does NOT clear the issue itself', async () => {
  const issues = registry();
  let ran = 0;
  issues.handle('reindex-node', async () => { ran++; });
  const raised = await issues.raise({
    kind: 'index', subject: 'itm_1', title: 'broken', retry: { op: 'reindex-node', nodeId: 'itm_1' },
  });
  expect(issues.canRetry(raised)).toBe(true);

  await issues.retry(raised.id);
  expect(ran).toBe(1);
  // Still listed: a retry that reports success while the underlying problem persists
  // would quietly hide it. Only the work succeeding clears the issue.
  expect(await issues.list()).toHaveLength(1);
});

test('an issue with no handler is honestly not retryable', async () => {
  const issues = registry();
  const raised = await issues.raise({ kind: 'weird', title: 'no fix for this', retry: { op: 'unknown-op' } });
  expect(issues.canRetry(raised)).toBe(false);
  await expect(issues.retry(raised.id)).rejects.toThrow(/cannot be retried/);
  // …and one that declares no retry at all.
  const plain = await issues.raise({ kind: 'plain', title: 'just so you know' });
  expect(issues.canRetry(plain)).toBe(false);
});

test('issues are scoped to collections the caller can read', async () => {
  const issues = registry();
  await issues.raise({ kind: 'index', subject: 'a', title: 'mine', collectionId: 'default' });
  await issues.raise({ kind: 'index', subject: 'b', title: 'theirs', collectionId: 'secret' });
  await issues.raise({ kind: 'reindex', title: 'drive-wide' });

  // An issue names a file, so it leaks that file's existence — it is scoped exactly
  // like the file is, and a drive-wide one takes drive-wide access.
  const scoped = await issues.list({ collectionIds: ['default'], includeGlobal: false });
  expect(scoped.map((i) => i.title)).toEqual(['mine']);
  const withGlobal = await issues.list({ collectionIds: ['default'], includeGlobal: true });
  expect(withGlobal.map((i) => i.title).sort()).toEqual(['drive-wide', 'mine']);
});

test('the issue store is bounded', async () => {
  const issues = registry();
  for (let i = 0; i < 520; i++) await issues.raise({ kind: 'index', subject: `itm_${i}`, title: `#${i}` });
  // A systemic failure — storage down during a full reindex — must not fill the store.
  const all = await issues.list({ limit: 10_000 });
  expect(all.length).toBeLessThanOrEqual(500);
});

// --- the loop, end to end ----------------------------------------------------

test('a failed index becomes a standing issue, and indexing successfully clears it', async () => {
  const issues = registry();
  let broken = true;
  const vfs = await createVfs({ storage: new MemoryStorage(), issues });
  vfs.indexers.register({
    id: 'test.flaky',
    match: (n) => n.name.endsWith('.md'),
    index: async () => { if (broken) throw new Error('extractor fell over'); return { semanticTexts: [{ text: 'fine' }] }; },
  });

  const node = await vfs.writeFile('notes.md', '# Notes', { contentType: 'text/markdown' });
  const raised = await issues.list();
  expect(raised).toHaveLength(1);
  // The title says what the USER loses, not that an exception occurred.
  expect(raised[0].title).toMatch(/notes\.md/);
  expect(raised[0].title).toMatch(/search/);
  expect(raised[0].collectionId).toBe('default'); // scoped like the file it is about
  expect(raised[0].retry).toEqual({ op: 'reindex-node', nodeId: node.id });

  broken = false;
  await vfs.reindexNode(node.id);
  expect(await issues.list()).toEqual([]);
});

test('deleting an item clears the standing problem about it', async () => {
  const issues = registry();
  const vfs = await createVfs({ storage: new MemoryStorage(), issues });
  vfs.indexers.register({ id: 'test.always', match: () => true, index: async () => { throw new Error('nope'); } });
  const node = await vfs.writeFile('doomed.txt', 'x', { contentType: 'text/plain' });
  expect(await issues.list()).toHaveLength(1);
  // Leaving it behind would leave an un-fixable row pointing at nothing.
  await vfs.remove(node.id);
  expect(await issues.list()).toEqual([]);
});

test('renaming an item keeps it findable under its new name', async () => {
  // Without this, rename left the keyword index holding the OLD name: the item was
  // findable only as something it no longer was, which in a drive with no folders is
  // the item disappearing.
  const vfs = await createVfs({ storage: new MemoryStorage() });
  const node = await vfs.writeFile('sailing.txt', 'Tacking upwind at dawn.', { contentType: 'text/plain' });
  const byName = async (q) => (await vfs.search.keywords.search(q)).map((h) => h.fields?.name).filter(Boolean);

  expect(await byName('sailing')).toContain('sailing.txt');
  await vfs.rename(node.id, 'kayaking.txt');
  expect(await byName('kayaking')).toContain('kayaking.txt');
  expect(await byName('sailing')).toEqual([]); // and no longer under the old one
});

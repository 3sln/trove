// Sidecar CRDT + conversations. Verifies conflict-free merge of divergent copies
// and the SidecarService conversation/tag/mention behaviours over MemoryStorage.

import { test, expect } from 'bun:test';
import { MemoryStorage, SidecarService, sidecarOps } from '../src/index.js';
const { emptyDoc, addComment, setTag, removeTag, react, mergeDoc, viewDoc } = sidecarOps;

test('CRDT merge is conflict-free and deterministic', () => {
  // Two replicas diverge from a common base.
  const base = emptyDoc('n1');
  addComment(base, { id: 'c1', author: { id: 'u1', name: 'A' }, body: 'hello', actor: 'u1' });

  const a = JSON.parse(JSON.stringify(base));
  const b = JSON.parse(JSON.stringify(base));

  // Replica A: adds a reply + a tag.
  addComment(a, { id: 'c2', parentId: 'c1', author: { id: 'u2', name: 'B' }, body: 'reply', actor: 'u2' });
  setTag(a, 'important', { actor: 'u2' });

  // Replica B: reacts + a different tag + removes then... independent ops.
  react(b, 'c1', '👍', 'u3', true);
  setTag(b, 'review', { actor: 'u3' });

  const m1 = mergeDoc(a, b);
  const m2 = mergeDoc(b, a);
  // Commutative.
  expect(JSON.stringify(viewDoc(m1))).toBe(JSON.stringify(viewDoc(m2)));

  const view = viewDoc(m1);
  expect(view.commentCount).toBe(2);
  expect(view.comments[0].replies.length).toBe(1);
  expect(view.tags.map((t) => t.name).sort()).toEqual(['important', 'review']);
  expect(view.comments[0].reactions['👍']).toContain('u3');
});

test('tag remove-wins by later stamp', () => {
  const d = emptyDoc('n');
  setTag(d, 't', { actor: 'u1' });
  removeTag(d, 't', { actor: 'u1' });
  expect(viewDoc(d).tags.length).toBe(0);
});

test('SidecarService: comment, mention emission, edit auth, delete', async () => {
  const storage = new MemoryStorage();
  const mentioned = [];
  const svc = new SidecarService({ storage, onMentions: (m) => mentioned.push(...m) });
  const alice = { id: 'alice', name: 'Alice' };
  const bob = { id: 'bob', name: 'Bob' };

  const c = await svc.addComment('file1', { body: 'hey @[Bob](bob) look at this' }, alice);
  expect(c.body).toContain('look at this');
  expect(mentioned.length).toBe(1);
  expect(mentioned[0].userId).toBe('bob');
  expect(mentioned[0].by.id).toBe('alice');

  // Bob is auto-subscribed via the mention.
  const view = await svc.view('file1');
  expect(view.subscribers).toContain('bob');
  expect(view.subscribers).toContain('alice');

  // Only the author may edit.
  await expect(svc.editComment('file1', c.id, 'nope', bob)).rejects.toThrow(/your own/i);
  const edited = await svc.editComment('file1', c.id, 'edited body', alice);
  expect(edited.body).toBe('edited body');
  expect(edited.edited).toBe(true);

  // Delete tombstones (body hidden, still counted structurally).
  await svc.deleteComment('file1', c.id, alice);
  const after = await svc.view('file1');
  expect(after.commentCount).toBe(0);

  await svc.dispose();
});

test('SidecarService: tags and reactions round-trip through cold storage', async () => {
  const storage = new MemoryStorage();
  const svc = new SidecarService({ storage });
  await svc.setTag('f', 'blue', 'property-value', { id: 'u1' });
  await svc.manager.flush('f'); // force cold write
  // New service instance reads the persisted sidecar.
  const svc2 = new SidecarService({ storage });
  const view = await svc2.view('f');
  expect(view.tags[0]).toEqual({ name: 'blue', value: 'property-value' });
});

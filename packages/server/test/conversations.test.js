// Integration: identity + conversations + mention notifications over the real
// HTTP handler. A JWT-authenticated user posts a comment that @mentions another
// user; after a flush, the mention lands in the mentioned user's inbox.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';

const enc = new TextEncoder();
const b64url = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NOW = 1_700_000_000_000;
const SECRET = 'test-secret';

async function mint(payload) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify({ exp: NOW / 1000 + 3600, ...payload })));
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

async function req(handle, method, path, { token, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handle(new Request(`http://t${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('anonymous default: /api/me is the shared anonymous user', async () => {
  const { handle, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const me = await req(handle, 'GET', '/api/me');
  expect(me.json.principal.id).toBe('anonymous');
  const caps = await req(handle, 'GET', '/api/capabilities');
  expect(caps.json.features.conversations).toBe(true);
});

test('JWT identity + comment mention → recipient inbox', async () => {
  const { handle, vfs, notifications, collections: __cols } = await createServer({
    identity: { driver: 'jwt', jwt: { secret: SECRET, now: NOW, algorithms: ['HS256'] } },
    startFlusher: false, // we flush manually for determinism
  });
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const file = await vfs.writeFile('design.md', '# Design', { contentType: 'text/markdown' });

  const aliceToken = await mint({ sub: 'alice', name: 'Alice', email: 'alice@x.io' });
  const bobToken = await mint({ sub: 'bob', name: 'Bob' });

  // Alice is authenticated.
  const me = await req(handle, 'GET', '/api/me', { token: aliceToken });
  expect(me.json.principal.id).toBe('alice');

  // Alice comments, mentioning Bob.
  const posted = await req(handle, 'POST', `/api/items/${file.id}/comments`, {
    token: aliceToken, body: { body: 'What do you think @[Bob](bob)?' },
  });
  expect(posted.status).toBe(200);
  expect(posted.json.comment.body).toContain('What do you think');

  // The sidecar view shows the comment + Bob auto-subscribed.
  const view = await req(handle, 'GET', `/api/items/${file.id}/sidecar`, { token: aliceToken });
  expect(view.json.commentCount).toBe(1);
  expect(view.json.subscribers).toContain('bob');

  // No inbox yet (not flushed).
  expect((await req(handle, 'GET', '/api/notifications', { token: bobToken })).json.unread).toBe(0);

  // Flush the mention batch → Bob has a notification.
  await notifications.flush(NOW);
  const inbox = await req(handle, 'GET', '/api/notifications', { token: bobToken });
  expect(inbox.json.unread).toBe(1);
  expect(inbox.json.items[0].items[0].by.id).toBe('alice');

  // A reply is rejected without auth.
  const noauth = await req(handle, 'POST', `/api/items/${file.id}/comments`, { body: { body: 'hi' } });
  expect(noauth.status).toBe(401);
});

test('tags round-trip through the API', async () => {
  const { handle, vfs, collections: __cols } = await createServer();
  await __cols?.ensure({ id: 'default', name: 'My Drive' });
  const file = await vfs.writeFile('a.txt', 'hi', { contentType: 'text/plain' });
  await req(handle, 'POST', `/api/items/${file.id}/tags`, { body: { name: 'starred' } });
  await req(handle, 'POST', `/api/items/${file.id}/tags`, { body: { name: 'priority', value: 'high' } });
  const view = await req(handle, 'GET', `/api/items/${file.id}/sidecar`);
  expect(view.json.tags).toEqual([{ name: 'priority', value: 'high' }, { name: 'starred', value: null }]);
});

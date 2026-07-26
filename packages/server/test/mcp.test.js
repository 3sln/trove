// The drive, spoken to by an agent.
//
// Two things are being tested and they matter for different reasons.
//
// The PROTOCOL half is about interoperability: an off-the-shelf agent connects, or it
// doesn't, and the ways it fails are all silent. A JSON-RPC envelope returned for a
// notification, a well-known URL assembled by appending instead of inserting, an
// unknown tool reported as a transport fault — each one leaves a client that just
// "can't connect", with nothing in the log a user could act on.
//
// The AUTHORIZATION half is about the drive not becoming a hole in its own permissions.
// An agent is a program holding somebody's token, and the whole design rests on it being
// exactly as privileged as that person and no more. A tool that skipped the collection
// ACL would be a way to read every file on the server through a token that grants one
// collection.

import { test, expect } from 'bun:test';
import { createServer } from '../src/index.js';
import { CollectionService, MemoryKV, MemoryStorage } from '@trove/core';
import { metadataUrl, resourceUri, protectedResourceMetadata, challengeHeaders } from '../src/mcp/auth.js';

// --- helpers -----------------------------------------------------------------

const ORIGIN = 'http://drive.test';
async function rpc(handle, method, params, { token, id = 1, path = '/mcp' } = {}) {
  const res = await handle(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
  }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const callTool = async (handle, name, args, opts) => {
  const r = await rpc(handle, 'tools/call', { name, arguments: args }, opts);
  return { ...r, text: r.body?.result?.content?.[0]?.text, isError: !!r.body?.result?.isError };
};

// A real signing key, so the token an agent presents is verified the way a real one is.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const b64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function sign(claims) {
  const input = `${enc({ alg: 'ES256', typ: 'JWT', kid: 'k1' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

async function openDrive(extra = {}) {
  const server = await createServer({ rebuildIndexOnStart: false, ...extra });
  await server.vfs.writeFile('welcome.md', '# Welcome\n\nNotes about sailing and the boat refit.\n', { contentType: 'text/markdown' });
  await server.vfs.writeFile('recipe.txt', 'flour, water, salt', { contentType: 'text/plain' });
  return server;
}

// --- discovery ---------------------------------------------------------------

test('the metadata URL inserts the well-known segment, it does not append it', () => {
  // RFC 9728 puts /.well-known/ between the host and the path. Appending is the common
  // mistake, and it produces a URL every conformant client will 404 on.
  expect(metadataUrl('https://d.example/mcp')).toBe('https://d.example/.well-known/oauth-protected-resource/mcp');
  expect(metadataUrl('https://d.example')).toBe('https://d.example/.well-known/oauth-protected-resource');
  expect(metadataUrl('https://d.example/a/b')).toBe('https://d.example/.well-known/oauth-protected-resource/a/b');
});

test('the resource URI follows the proxy headers, because the drive is usually behind one', () => {
  // Guessing from the socket gives http://internal:8080 — an identifier no token issued
  // for the public name will ever match.
  const req = new Request('http://10.0.0.4:8080/mcp', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'drive.example.com' },
  });
  expect(resourceUri(req, { path: '/mcp' })).toBe('https://drive.example.com/mcp');
  // And an explicit setting beats every guess.
  expect(resourceUri(req, { resource: 'https://pinned.example/mcp/' })).toBe('https://pinned.example/mcp');
});

test('the discovery document is served, and served without a token', async () => {
  // It is the document that tells you how to get a token. Requiring one to read it would
  // be a loop with no entry.
  const { handle } = await openDrive({
    identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
    mcp: { authorizationServers: ['https://auth.example.com'] },
  });
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const res = await handle(new Request(`${ORIGIN}${path}`));
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.resource).toBe(`${ORIGIN}/mcp`);
    expect(doc.authorization_servers).toEqual(['https://auth.example.com']);
    expect(doc.bearer_methods_supported).toEqual(['header']);
  }
});

test('an unauthenticated agent is told where to authenticate, not just refused', async () => {
  const { handle } = await openDrive({
    identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
    mcp: { authorizationServers: ['https://auth.example.com'] },
  });
  const r = await rpc(handle, 'tools/list', {});
  expect(r.status).toBe(401);
  const challenge = r.headers.get('www-authenticate');
  expect(challenge).toContain('Bearer');
  // The pointer to the metadata is the entire mechanism — without it the agent has a
  // 401 and no next step.
  expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
});

test('a challenge with no authorization server configured says so in words', () => {
  // This is the state that looks configured and cannot work: auth is required, and
  // there is nowhere to send the agent. A bare 401 would leave the operator guessing.
  const req = new Request(`${ORIGIN}/mcp`);
  const h = challengeHeaders(req, { path: '/mcp' });
  expect(h["www-authenticate"]).toMatch(/TROVE_MCP_AUTH_SERVER/);
  expect(h['www-authenticate']).toContain('resource_metadata=');
  // And the document omits the field rather than publishing an empty list, which would
  // read to a client as "there are none" instead of "not configured".
  expect('authorization_servers' in protectedResourceMetadata(req, {})).toBe(false);
});

test('a challenge stays a valid header even when the message is written for a person', () => {
  // Header values are bytes. A curly quote or an em dash — exactly what shows up when
  // someone writes an error message meant to be read — makes Response() throw, and the
  // helpful 401 becomes a 500 with no challenge at all.
  const h = challengeHeaders(new Request(`${ORIGIN}/mcp`), {}, {
    description: 'The token’s audience didn—t match “this drive”…',
  });
  expect(() => new Response(null, { status: 401, headers: h })).not.toThrow();
  expect(h['www-authenticate']).toMatch(/^[\x20-\x7e]+$/);
  // And it still carries the pointer, which is the part that must survive sanitizing.
  expect(h['www-authenticate']).toContain('resource_metadata=');
});

test('an expired or forged token gets the same directions as no token at all', async () => {
  const { handle } = await openDrive({
    identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
    mcp: { authorizationServers: ['https://auth.example.com'] },
  });
  const r = await rpc(handle, 'tools/list', {}, { token: 'not.a.jwt' });
  expect(r.status).toBe(401);
  // An agent whose token expired needs to know where to get another — the same answer.
  expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
});

// --- protocol ----------------------------------------------------------------

test('initialize negotiates down to a version the client asked for', async () => {
  const { handle } = await openDrive();
  const r = await rpc(handle, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  expect(r.status).toBe(200);
  // Echoing the client's version when we can speak it — forcing an upgrade would
  // disconnect every agent pinned to an older revision.
  expect(r.body.result.protocolVersion).toBe('2025-06-18');
  expect(r.body.result.capabilities.tools).toBeTruthy();
  expect(r.body.result.serverInfo.name).toBe('trove');
  // The instructions are how a model learns this drive has no folders, which it will
  // otherwise assume and waste every turn on.
  expect(r.body.result.instructions).toMatch(/NO FOLDERS/i);

  // A version we don't know gets ours, rather than a pretence that we speak it.
  const future = await rpc(handle, 'initialize', { protocolVersion: '1999-01-01' });
  expect(future.body.result.protocolVersion).toBe('2025-11-25');
});

test('a notification gets 202 and no body whatsoever', async () => {
  // Returning a JSON-RPC envelope for a notification is how conformant clients decide
  // the server is broken and hang up.
  const { handle } = await openDrive();
  const res = await handle(new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }));
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('');
});

test('an unknown method is a JSON-RPC error; an unknown TOOL is not', async () => {
  const { handle } = await openDrive();
  const bad = await rpc(handle, 'does/notexist', {});
  expect(bad.body.error.code).toBe(-32601);

  // Models hallucinate tool names constantly. Reporting that as a transport fault kills
  // the connection over something the model could have corrected by reading a sentence.
  const ghost = await callTool(handle, 'summon_ghost', {});
  expect(ghost.status).toBe(200);
  expect(ghost.body.error).toBeUndefined();
  expect(ghost.isError).toBe(true);
  expect(ghost.text).toMatch(/No such tool/);
});

test('malformed JSON is a parse error, not a crash', async () => {
  const { handle } = await openDrive();
  const res = await handle(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":',
  }));
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe(-32700);
});

// --- tools -------------------------------------------------------------------

test('tools are listed with schemas, and the read-only ones say so', async () => {
  const { handle } = await openDrive();
  const r = await rpc(handle, 'tools/list', {});
  const names = r.body.result.tools.map((t) => t.name);
  expect(names).toContain('search_files');
  expect(names).toContain('read_file');
  expect(names).toContain('write_file');
  for (const t of r.body.result.tools) {
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.inputSchema.type).toBe('object');
  }
  expect(r.body.result.tools.find((t) => t.name === 'search_files').annotations.readOnlyHint).toBe(true);
  expect(r.body.result.tools.find((t) => t.name === 'write_file').annotations).toBeUndefined();
});

test('search finds a file, and an empty result says so in a sentence', async () => {
  const { handle } = await openDrive();
  const found = await callTool(handle, 'search_files', { query: 'sailing' });
  expect(found.isError).toBe(false);
  expect(found.text).toContain('welcome.md');

  // A model reading `[]` retries the identical query. A sentence prompts it to rephrase.
  const empty = await callTool(handle, 'search_files', { query: '#nosuchtagatall' });
  expect(empty.isError).toBe(false);
  expect(empty.text).toMatch(/No files matched/);
});

test('read, write, and delete round-trip through the same Vfs the browser uses', async () => {
  const { handle, vfs } = await openDrive();
  const read = await callTool(handle, 'read_file', { file: 'recipe.txt' });
  expect(read.text).toBe('flour, water, salt');

  const wrote = await callTool(handle, 'write_file', { name: 'agent-note.md', content: '# From an agent\n' });
  expect(wrote.isError).toBe(false);
  expect(await (await vfs.find('agent-note.md')).name).toBe('agent-note.md');

  const gone = await callTool(handle, 'delete_file', { file: 'agent-note.md' });
  expect(gone.isError).toBe(false);
  // Trash, not destruction — and the tool says which, because a model deciding whether
  // to delete needs to know it is recoverable.
  expect(gone.text).toMatch(/trash/i);
  expect(await vfs.find('agent-note.md')).toBeFalsy();
});

test('a missing file is a readable failure the model can act on', async () => {
  const { handle } = await openDrive();
  const r = await callTool(handle, 'read_file', { file: 'nothing-here.txt' });
  expect(r.status).toBe(200); // not a transport fault
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/No file called/);
});

test('a binary file returns its details rather than mangled bytes as text', async () => {
  const { handle, vfs } = await openDrive();
  await vfs.writeFile('photo.png', new Uint8Array([137, 80, 78, 71, 0, 1, 2]), { contentType: 'image/png' });
  const r = await callTool(handle, 'read_file', { file: 'photo.png' });
  expect(r.isError).toBe(false);
  expect(r.text).toMatch(/image\/png/);
});

// --- permissions -------------------------------------------------------------

test('an agent is exactly as privileged as the person whose token it holds', async () => {
  // The security claim of the whole feature. If a tool skipped the ACL, one token
  // scoped to one collection would read every file on the server.
  const kv = new MemoryKV();
  const collections = new CollectionService({
    kv, storageFactory: () => new MemoryStorage(), admins: ['admin@example.com'], defaultOpen: false,
    defaultStore: { driver: 'memory' },
  });
  const server = await createServer({
    rebuildIndexOnStart: false,
    collections,
    identity: { driver: 'jwt', jwt: { jwks: { keys: [publicJwk] }, required: true } },
    mcp: { authorizationServers: ['https://auth.example.com'] },
  });
  const { handle, vfs } = server;
  const admin = { id: 'admin@example.com', email: 'admin@example.com', roles: [] };
  const priv = await collections.create({ name: 'Private', store: { driver: 'memory' } }, admin);
  const shared = await collections.create({ name: 'Shared', store: { driver: 'memory' } }, admin);
  await collections.setGrant(shared.id, { type: 'user', subject: 'bob@example.com', capabilities: ['read'] }, admin);
  await vfs.writeFile('secret.txt', 'the combination is 1234', { collectionId: priv.id, contentType: 'text/plain' });
  await vfs.writeFile('public.txt', 'anyone here may read this', { collectionId: shared.id, contentType: 'text/plain' });

  const bob = await sign({ sub: 'bob@example.com', email: 'bob@example.com' });

  // Bob can see the collection he was granted, and not the one he wasn't.
  const cols = await callTool(handle, 'list_collections', {}, { token: bob });
  expect(cols.text).toContain(shared.id);
  expect(cols.text).not.toContain(priv.id);

  // Reading across the boundary fails — by NAME, which is the path an agent would take
  // if it were told the file exists.
  const denied = await callTool(handle, 'read_file', { file: 'secret.txt', collection: priv.id }, { token: bob });
  expect(denied.isError).toBe(true);
  expect(denied.text).not.toContain('1234');

  // And search does not leak it either, which is the subtler hole: search runs across
  // collections by design, so it has to be scoped before it runs, not filtered after.
  const searched = await callTool(handle, 'search_files', { query: 'combination' }, { token: bob });
  expect(searched.text).not.toContain('secret.txt');
  expect(searched.text).not.toContain('1234');

  // What he can read, he can read.
  const allowed = await callTool(handle, 'read_file', { file: 'public.txt', collection: shared.id }, { token: bob });
  expect(allowed.isError).toBe(false);
  expect(allowed.text).toContain('anyone here may read this');

  // Read access is not write access.
  const write = await callTool(handle, 'write_file', { name: 'x.txt', content: 'nope', collection: shared.id }, { token: bob });
  expect(write.isError).toBe(true);
});

test('an open drive serves an open MCP endpoint, and does not demand a token it never issued', async () => {
  // The zero-config case. Requiring a bearer token for MCP on a drive whose browser
  // needs none protects nothing and just makes the endpoint unusable.
  const { handle } = await openDrive();
  const r = await rpc(handle, 'tools/list', {});
  expect(r.status).toBe(200);
  expect(r.body.result.tools.length).toBeGreaterThan(0);
});

test('an operator can require auth on an open drive, and is then told what is missing', async () => {
  const { handle } = await openDrive({ mcp: { requireAuth: true } });
  const r = await rpc(handle, 'tools/list', {});
  expect(r.status).toBe(401);
  expect(r.headers.get('www-authenticate')).toMatch(/No MCP authorization server is configured/);
});

// --- configuration -----------------------------------------------------------

test('the endpoint and its gaps are reported over the API', async () => {
  const { handle } = await openDrive({ mcp: { requireAuth: true } });
  const res = await handle(new Request(`${ORIGIN}/api/mcp`));
  const info = await res.json();
  expect(info.enabled).toBe(true);
  expect(info.endpoint).toBe(`${ORIGIN}/mcp`);
  expect(info.metadataUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  // The state that looks fine and cannot work, named outright.
  expect(info.needsAuthorizationServer).toBe(true);
});

test('an admin can point the drive at an authorization server without a redeploy', async () => {
  // For someone running this on a NAS, "configurable" that requires editing env and
  // restarting is not configurable.
  const { handle } = await openDrive({ mcp: { requireAuth: true } });
  const put = await handle(new Request(`${ORIGIN}/api/mcp`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorizationServers: ['https://auth.example.com/'] }),
  }));
  expect(put.status).toBe(200);

  const doc = await (await handle(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))).json();
  expect(doc.authorization_servers).toEqual(['https://auth.example.com']); // trailing slash normalized
  const info = await (await handle(new Request(`${ORIGIN}/api/mcp`))).json();
  expect(info.needsAuthorizationServer).toBe(false);
});

test('a plaintext authorization server is refused', async () => {
  // An agent will hand a bearer token to whatever this names, so http:// is either a
  // typo or a downgrade. Localhost is allowed, because that is where people develop.
  const { handle } = await openDrive();
  const bad = await handle(new Request(`${ORIGIN}/api/mcp`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorizationServers: ['http://auth.example.com'] }),
  }));
  expect(bad.status).toBe(400);

  const local = await handle(new Request(`${ORIGIN}/api/mcp`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorizationServers: ['http://localhost:9000'] }),
  }));
  expect(local.status).toBe(200);
});

test('MCP can be switched off entirely, and then the endpoint is simply not there', async () => {
  const { handle } = await openDrive({ mcp: { enabled: false } });
  const res = await handle(new Request(`${ORIGIN}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }));
  expect(res.status).toBe(404);
  const info = await (await handle(new Request(`${ORIGIN}/api/mcp`))).json();
  expect(info.enabled).toBe(false);
});

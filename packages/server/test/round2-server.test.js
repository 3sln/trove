// Round-2/3 audit findings at the server boundary: settings that were silently dead,
// a route that could be made to allocate without limit, and an error that escaped the
// error funnel.

import { test, expect } from 'bun:test';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { createServer, configFromEnv } from '../src/index.js';
import { Router } from '../src/router.js';

const post = (handle, path, body) => handle(new Request(`http://t${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

// --- the MCP switches have to actually switch something -------------------------

test('TROVE_MCP=off removes the agent endpoint', async () => {
  // `mcpConfigFromEnv` reads `config.env`, and `configFromEnv` never set it — so every
  // documented TROVE_MCP_* variable was a no-op. An operator who used the documented
  // way to remove the agent endpoint still had it live at /mcp, with write_file and
  // delete_file on it, unauthenticated on a zero-config drive.
  const { handle } = await createServer(configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP: 'off' }));
  const res = await post(handle, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.status).toBe(404);
});

test('TROVE_MCP_PATH moves it, and TROVE_MCP_REQUIRE_AUTH locks it', async () => {
  const moved = await createServer(configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP_PATH: '/agent' }));
  expect((await post(moved.handle, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
  expect((await post(moved.handle, '/agent', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);

  // An open web app with a locked-down agent endpoint is the whole point of this knob.
  const locked = await createServer(configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP_REQUIRE_AUTH: 'true' }));
  const res = await post(locked.handle, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain('Bearer');
  // …while the drive itself stays open.
  expect((await locked.handle(new Request('http://t/api/items'))).status).toBe(200);
});

// --- a plugin package must not be able to allocate without limit ----------------

test('a zip bomb is refused before it is inflated', async () => {
  const { handle } = await createServer();
  // 200 MB of zeroes compresses to almost nothing. The 32 MiB cap is on the COMPRESSED
  // bytes; nothing bounded the inflated size, and unzipSync is synchronous — so one
  // small request cost a gigabyte of RSS and thirteen seconds of blocked event loop,
  // from an unauthenticated caller (the route needs a principal, and the shared
  // anonymous one satisfies it).
  const bomb = zipSync({
    'manifest.json': strToU8(JSON.stringify({ domain: 'acme.com', name: 'bomb', version: '1' })),
    'big.bin': new Uint8Array(200 * 1024 * 1024),
  });
  expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024); // it really is a bomb
  const t0 = Date.now();
  const res = await handle(new Request('http://t/api/plugins/install', { method: 'POST', body: bomb }));
  expect(res.status).toBe(413);
  expect((await res.json()).error.message).toMatch(/expands to more than/i);
  expect(Date.now() - t0).toBeLessThan(4000);
  // Building the bomb is 200 MB of allocation and a deflate, and it happens BEFORE t0 —
  // the budget this test actually asserts is the one above, on the request. The default
  // 5s covers the fixture too, which left about twice the headroom locally and none at
  // all on a shared CI runner, where the same work takes ~6.5s. Raising it here rather
  // than passing --timeout to the whole suite: one test is expensive, and hiding that
  // behind a global would also hide the next test that gets slow for a real reason.
}, 60_000);

test('an oversized body is refused while streaming, not after buffering', async () => {
  const { handle } = await createServer();
  // No content-length, so the declared-size check can't fire. `arrayBuffer()` then
  // checking `.byteLength` meant the whole body was resident before being refused.
  let sent = 0;
  const body = new ReadableStream({
    pull(c) {
      if (sent >= 200 * 1024 * 1024) return c.close();
      sent += 1024 * 1024;
      c.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  const res = await handle(new Request('http://t/api/plugins/install', { method: 'POST', body, duplex: 'half' }));
  expect(res.status).toBe(400);
  // Refused near the cap rather than after the whole 200 MB arrived.
  expect(sent).toBeLessThan(64 * 1024 * 1024);
});

// --- errors stay inside the error funnel ----------------------------------------

test('a malformed percent-escape in a path is a 404, not a rejected promise', async () => {
  // decodeURIComponent runs in #match, OUTSIDE the try that turns everything into a
  // Response — so a URIError rejected handle() itself and the adapters turned it into a
  // plaintext 500.
  const r = new Router();
  r.get('/api/uploads/:id/status', () => ({ ok: true }));
  for (const path of ['/api/uploads/%ZZ/status', '/api/uploads/%/status', '/api/uploads/%E0%A4%A/status']) {
    const res = await r.handle(new Request(`http://t${path}`));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  }
});

// --- a re-install must not serve the previous bytes -----------------------------

test('re-installing a plugin at the same version replaces its package', async () => {
  const { handle } = await createServer();
  const pkg = (marker) => zipSync({
    'manifest.json': strToU8(JSON.stringify({
      domain: 'acme.com', name: 'demo', version: '1.0.0', entry: 'plugin.js', capabilities: { ui: true },
    })),
    'plugin.js': strToU8(`export const VERSION = "${marker}";`),
  });
  const install = (marker) => handle(new Request('http://t/api/plugins/install?grants=ui', { method: 'POST', body: pkg(marker) }));

  await install('OLD');
  const second = await install('NEW');
  expect(second.status).toBe(200);

  // The blob ref was <account>/<pluginId>/<version>.zip and was written only when
  // absent, so iterating on a plugin without bumping its version recorded the new
  // digest, grants and indexer specs against the OLD bytes — and every device that
  // synced the package got the old code forever.
  const dl = await handle(new Request('http://t/api/plugins/acme.com%2Fdemo/package'));
  const served = unzipSync(new Uint8Array(await dl.arrayBuffer()));
  expect(strFromU8(served['plugin.js'])).toContain('NEW');
});

// --- MCP tells the truth about its own ordering ---------------------------------

test('list_files returns what its description promises', async () => {
  const { handle, vfs } = await createServer();
  for (const name of ['zebra.txt', 'apple.txt', 'mango.txt']) {
    await vfs.writeFile(name, name, { contentType: 'text/plain' });
    await new Promise((r) => setTimeout(r, 5)); // distinct updatedAt
  }
  const res = await post(handle, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: {} },
  });
  const payload = JSON.parse((await res.json()).result.content[0].text);
  // The tool said "newest first" and passed no sort, so vfs.list's alphabetical default
  // applied. An agent asked "what did I add recently?" read the top of that and answered
  // confidently wrong.
  expect(payload.items.map((i) => i.name)).toEqual(['mango.txt', 'apple.txt', 'zebra.txt']);
});

// --- maintenance drives the mention drain ---------------------------------------

test('runMaintenance flushes pending mentions', async () => {
  // The drain had exactly one caller: a setInterval inside NotificationCenter. On
  // Workers the adapter turns that flusher off, because a timer registered during a
  // request does not outlive it — and nothing else called flush. Mentions accumulated
  // in the pending store and were never delivered: no inbox entry, no push, no error,
  // for the entire life of the deployment. Maintenance runs from a cron there, so it
  // is what has to drive this.
  const srv = await createServer(configFromEnv({
    TROVE_STORAGE: 'memory', TROVE_MCP: 'off',
  }));
  await srv.notifications.enqueue([
    { userId: 'bob', nodeId: 'f1', by: { id: 'alice', name: 'Alice' }, excerpt: 'look at this', at: 1 },
  ]);

  // Nothing has run yet: the mention is queued, the inbox is empty.
  expect((await srv.notifications.inbox('bob')).items.length).toBe(0);

  const out = await srv.runMaintenance({ scan: false });

  expect(out.notified).toBe(1);
  const inbox = await srv.notifications.inbox('bob');
  expect(inbox.items.length).toBe(1);
  expect(inbox.items[0].title).toBe('Alice mentioned you');
  await srv.close?.();
});

// --- channels own their registration endpoints ----------------------------------

const get = (handle, path) => handle(new Request(`http://t${path}`));

test('no web push configured means no /api/push/* at all', async () => {
  // It used to answer regardless: /api/push/vapid returned { publicKey: null } and
  // subscribe accepted endpoints the drive could never send to. A route table that
  // advertises a transport nobody configured is a route table describing something
  // other than this drive.
  const srv = await createServer(configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP: 'off' }));
  expect((await get(srv.handle, '/api/push/vapid')).status).toBe(404);
  expect((await post(srv.handle, '/api/push/subscribe', { subscription: {} })).status).toBe(404);
  // The inbox is not a channel and is always there.
  expect((await get(srv.handle, '/api/notifications')).status).toBe(200);
  await srv.close?.();
});

test('configuring VAPID mounts the channel’s routes', async () => {
  const { generateVapidKeys } = await import('@3sln/trove/core');
  const keys = await generateVapidKeys();
  const srv = await createServer({
    ...configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP: 'off' }),
    vapid: { ...keys, subject: 'mailto:admin@example.com' },
  });

  const res = await get(srv.handle, '/api/push/vapid');
  expect(res.status).toBe(200);
  expect((await res.json()).publicKey).toBe(keys.publicKey);

  // And the drive still reports the capability from the same place it always did.
  const caps = await (await get(srv.handle, '/api/capabilities')).json();
  expect(caps.features.webPush).toBe(true);
  await srv.close?.();
});

test('a channel cannot shadow a built-in route', async () => {
  // Contributions are added after the core table, and the router matches in order.
  const { NotificationChannel } = await import('@3sln/trove/core');
  class Greedy extends NotificationChannel {
    get id() { return 'greedy'; }
    async deliver() {}
    routes() {
      return [{ method: 'GET', path: '/api/health', handler: () => ({ hijacked: true }) }];
    }
  }
  const srv = await createServer({
    ...configFromEnv({ TROVE_STORAGE: 'memory', TROVE_MCP: 'off' }),
    notificationChannels: [new Greedy()],
  });
  const health = await (await get(srv.handle, '/api/health')).json();
  expect(health.hijacked).toBeUndefined();
  expect(health.ok).toBe(true);
  await srv.close?.();
});

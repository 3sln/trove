// Server plugin installs: upload a package, list/download it for cross-device sync,
// enforce granted capabilities on plugin API calls, gate admin-only packages, and
// clean up on removal.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from '../src/index.js';

function pkg(manifest, extra = {}) {
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'plugin.js': strToU8('//'), ...extra });
}
async function req(handle, method, path, { body, headers } = {}) {
  const res = await handle(new Request(`http://t${path}`, { method, headers, body }));
  const ct = res.headers.get('content-type') || '';
  const out = { status: res.status, headers: res.headers };
  out.json = ct.includes('application/json') ? await res.json() : null;
  return out;
}

// A package's identity is its domain + name; `<domain>/<name>` is the plugin id, and
// it's URL-encoded into plugin API paths.
const base = { domain: 'acme.com', name: 'demo', displayName: 'Demo', version: '1.0.0' };
const DEMO = 'acme.com/demo';
const enc = (id) => encodeURIComponent(id);

test('install → list → download → remove lifecycle', async () => {
  const { handle } = await createServer();
  const zip = pkg({ ...base, capabilities: { ui: true, commands: true, storage: true } });

  const inst = await req(handle, 'POST', '/api/plugins/install?grants=ui,commands,storage', { body: zip });
  expect(inst.status).toBe(200);
  expect(inst.json.install.pluginId).toBe(DEMO);
  expect(inst.json.install.grants.sort()).toEqual(['commands', 'storage', 'ui']);
  expect(inst.json.install.digest).toStartWith('sha256:');
  expect(inst.json.install.secrets).toBeUndefined(); // never exposed

  const list = await req(handle, 'GET', '/api/plugins/installed');
  expect(list.json.plugins.map((p) => p.pluginId)).toContain(DEMO);

  const dl = await handle(new Request(`http://t/api/plugins/${enc(DEMO)}/package`));
  expect(dl.status).toBe(200);
  expect(dl.headers.get('content-type')).toBe('application/zip');
  expect((await dl.arrayBuffer()).byteLength).toBe(zip.byteLength);

  const rm = await req(handle, 'DELETE', `/api/plugins/${enc(DEMO)}/install`);
  expect(rm.json.removed).toBe(DEMO);
  const after = await req(handle, 'GET', '/api/plugins/installed');
  expect(after.json.plugins.length).toBe(0);
  const gone = await handle(new Request(`http://t/api/plugins/${enc(DEMO)}/package`));
  expect(gone.status).toBe(404);
});

test('capabilities are enforced for a server-installed plugin', async () => {
  const { handle } = await createServer();
  // Install WITHOUT storage granted.
  await req(handle, 'POST', '/api/plugins/install?grants=ui,commands', { body: pkg({ ...base, capabilities: { ui: true, commands: true, storage: true } }) });
  const denied = await req(handle, 'POST', `/api/plugins/${enc(DEMO)}/sql`, {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'exec', sql: 'CREATE TABLE t (x)' }),
  });
  expect(denied.status).toBe(403);
  expect(denied.json.error.code).toBe('forbidden');

  // A different plugin WITH storage granted → not blocked by the capability check.
  await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ domain: 'acme.com', name: 'store', version: '1', capabilities: { storage: true } }) });
  const ok = await req(handle, 'POST', `/api/plugins/${enc('acme.com/store')}/sql`, {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'exec', sql: 'CREATE TABLE t (x)' }),
  });
  expect(ok.status).toBe(200);
});

test('server-component / shared-resource packages need an admin', async () => {
  const { handle } = await createServer(); // anonymous principal → not admin
  // Shared (domain) storage requires admin.
  const shared = await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ ...base, capabilities: { storage: { domain: true } } }) });
  expect(shared.status).toBe(403);

  // A server indexer (embedded sub-package) also requires admin.
  const withIndexer = pkg({
    ...base, name: 'idx', entry: 'src/index.js',
    contributes: { pdf: { type: 'indexer', match: { ext: ['.pdf'] }, entry: 'src/indexers/pdf.js' } },
  }, { 'src/indexers/pdf.js': strToU8('export default async () => ({})') });
  const idx = await req(handle, 'POST', '/api/plugins/install', { body: withIndexer });
  expect(idx.status).toBe(403);
});

test('strict mode denies plugin API calls with no install record', async () => {
  const { handle } = await createServer({ enforcePluginCaps: true });
  // No install record → strict deny (closes the "any client names any pluginId" gap).
  const denied = await req(handle, 'POST', `/api/plugins/${enc('nope.example/n')}/sql`, {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'exec', sql: 'CREATE TABLE t (x)' }),
  });
  expect(denied.status).toBe(403);

  // Install it, and the same call is allowed.
  await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ domain: 'nope.example', name: 'n', version: '1', capabilities: { storage: true } }) });
  const ok = await req(handle, 'POST', `/api/plugins/${enc('nope.example/n')}/sql`, {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'exec', sql: 'CREATE TABLE t (x)' }),
  });
  expect(ok.status).toBe(200);
});

test('admin can install an admin-gated package', async () => {
  // Grant the anonymous principal admin via config.
  const { handle } = await createServer({ admins: ['anonymous'] });
  const shared = await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ ...base, capabilities: { storage: { domain: true } } }) });
  expect(shared.status).toBe(200);
  expect(shared.json.install.adminApprovedBy).toBe('anonymous');
});

test('a contributor namespace can only be written by the plugin that owns it', async () => {
  const { handle, vfs } = await createServer({ admins: ['anonymous'] });
  // Installed, because the namespace is only unforgeable if being the plugin is a fact
  // on the server rather than a string in the URL — see the ghost case below.
  await req(handle, 'POST', '/api/plugins/install?grants=indexer', {
    body: pkg({ domain: 'acme.com', name: 'p', version: '1.0.0', capabilities: { indexer: true }, entry: 'plugin.js', contributes: { idx: { type: 'indexer', match: { ext: ['.md'] } } } }),
  });
  const target = await vfs.writeFile('target.md', 'x', { contentType: 'text/markdown' });
  const index = await vfs.writeFile('index.md', 'see [t](trove:default/target.md)', { contentType: 'text/markdown' });
  expect((await vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['index.md']);

  const push = (ns, b) => handle(new Request(`http://t/api/index/${encodeURIComponent(ns)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  }));

  // A built-in's namespace is the server's to write. Letting a client overwrite
  // `core.links` would silently break every backlink in the drive.
  expect((await push('core.links', { nodeId: index.id, metadata: { links: [] } })).status).toBe(403);
  expect((await push('trove+contrib:core/workbench/x', { nodeId: index.id, tags: { a: 1 } })).status).toBe(403);
  // The reserved user-tag scope goes through the tags routes, not this one.
  expect((await push('user', { nodeId: index.id, tags: { fav: 'yes' } })).status).toBe(403);
  // A bare string names nothing verifiable.
  expect((await push('whatever', { nodeId: index.id, tags: { a: 1 } })).status).toBe(403);
  expect((await vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['index.md']);

  // A plugin that was never installed is not an identity, whatever the URI says. This
  // is checked whether or not strict capability enforcement is on: the transitional
  // allow covers a missing GRANT, not a missing plugin.
  expect((await push('trove+contrib:ghost.example/p/idx', { nodeId: index.id, tags: { a: 1 } })).status).toBe(403);

  // A plugin's own contribution URI is fine — it's scoped to its verified identity.
  expect((await push('trove+contrib:acme.com/p/idx', { nodeId: index.id, tags: { a: 1 } })).status).toBe(200);
});

test('strict mode also requires the plugin to be installed with the indexer capability', async () => {
  const { handle, vfs } = await createServer({ enforcePluginCaps: true });
  const n = await vfs.writeFile('x.md', 'hi', { contentType: 'text/markdown' });
  const push = (ns) => handle(new Request(`http://t/api/index/${encodeURIComponent(ns)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: n.id, tags: { a: 1 } }),
  }));
  expect((await push('trove+contrib:acme.com/ghost/idx')).status).toBe(403);

  // Installed WITHOUT the indexer capability → still refused.
  await req(handle, 'POST', '/api/plugins/install?grants=storage', {
    body: pkg({ domain: 'acme.com', name: 'p', version: '1', capabilities: { storage: true, indexer: true } }),
  });
  expect((await push('trove+contrib:acme.com/p/idx')).status).toBe(403);
});

// Two independent limits, and the order matters: the request body cap rejects a
// payload too big to even parse, and the contribution caps bound what a payload that
// DID parse may store. This exercises the second — the first is covered in hardening.
test('a contribution is clamped wherever it came from, including the API push', async () => {
  const { handle, vfs } = await createServer({ admins: ['anonymous'] });
  await req(handle, 'POST', '/api/plugins/install?grants=indexer', {
    body: pkg({ domain: 'acme.com', name: 'p', version: '1.0.0', capabilities: { indexer: true }, entry: 'plugin.js', contributes: { idx: { type: 'indexer', match: { ext: ['.md'] } } } }),
  });
  const n = await vfs.writeFile('x.md', 'hi', { contentType: 'text/markdown' });
  const ns = 'trove+contrib:acme.com/p/idx';
  const res = await handle(new Request(`http://t/api/index/${encodeURIComponent(ns)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: n.id,
      tags: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, 'v'.repeat(500)])),
      metadata: { blob: 'y'.repeat(400 * 1024) },
      semanticTexts: Array.from({ length: 2000 }, (_, i) => ({ text: `chunk ${i}` })),
    }),
  }));
  expect(res.status).toBe(200);
  const after = await vfs.stat(n.id);
  const mine = after.contributions[ns];
  expect(Object.keys(mine.tags).length).toBe(100);          // maxTags
  expect(Object.values(mine.tags)[0].length).toBe(500);     // under maxTagValueChars, kept whole
  expect(mine.metadata).toBeUndefined();                    // over maxMetadataBytes → dropped
});

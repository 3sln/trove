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

const base = { id: 'com.acme.demo', name: 'Demo', version: '1.0.0' };

test('install → list → download → remove lifecycle', async () => {
  const { handle } = await createServer();
  const zip = pkg({ ...base, capabilities: { ui: true, commands: true, storage: true } });

  const inst = await req(handle, 'POST', '/api/plugins/install?grants=ui,commands,storage', { body: zip });
  expect(inst.status).toBe(200);
  expect(inst.json.install.pluginId).toBe('com.acme.demo');
  expect(inst.json.install.grants.sort()).toEqual(['commands', 'storage', 'ui']);
  expect(inst.json.install.digest).toStartWith('sha256:');
  expect(inst.json.install.secrets).toBeUndefined(); // never exposed

  const list = await req(handle, 'GET', '/api/plugins/installed');
  expect(list.json.plugins.map((p) => p.pluginId)).toContain('com.acme.demo');

  const dl = await handle(new Request('http://t/api/plugins/com.acme.demo/package'));
  expect(dl.status).toBe(200);
  expect(dl.headers.get('content-type')).toBe('application/zip');
  expect((await dl.arrayBuffer()).byteLength).toBe(zip.byteLength);

  const rm = await req(handle, 'DELETE', '/api/plugins/com.acme.demo/install');
  expect(rm.json.removed).toBe('com.acme.demo');
  const after = await req(handle, 'GET', '/api/plugins/installed');
  expect(after.json.plugins.length).toBe(0);
  const gone = await handle(new Request('http://t/api/plugins/com.acme.demo/package'));
  expect(gone.status).toBe(404);
});

test('capabilities are enforced for a server-installed plugin', async () => {
  const { handle } = await createServer();
  // Install WITHOUT storage granted.
  await req(handle, 'POST', '/api/plugins/install?grants=ui,commands', { body: pkg({ ...base, capabilities: { ui: true, commands: true, storage: true } }) });
  const denied = await req(handle, 'POST', '/api/plugins/com.acme.demo/sql', {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'exec', sql: 'CREATE TABLE t (x)' }),
  });
  expect(denied.status).toBe(403);
  expect(denied.json.error.code).toBe('forbidden');

  // A different plugin WITH storage granted → not blocked by the capability check.
  await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ id: 'com.acme.store', name: 'S', version: '1', capabilities: { storage: true } }) });
  const ok = await req(handle, 'POST', '/api/plugins/com.acme.store/sql', {
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
  const withIndexer = pkg({ ...base, id: 'com.acme.idx' }, {
    'indexers/pdf/manifest.json': strToU8(JSON.stringify({ id: 'com.acme.idx.pdf', match: { ext: ['.pdf'] } })),
    'indexers/pdf/index.js': strToU8('export default async () => ({})'),
  });
  const idx = await req(handle, 'POST', '/api/plugins/install', { body: withIndexer });
  expect(idx.status).toBe(403);
});

test('admin can install an admin-gated package', async () => {
  // Grant the anonymous principal admin via config.
  const { handle } = await createServer({ admins: ['anonymous'] });
  const shared = await req(handle, 'POST', '/api/plugins/install?grants=storage', { body: pkg({ ...base, capabilities: { storage: { domain: true } } }) });
  expect(shared.status).toBe(200);
  expect(shared.json.install.adminApprovedBy).toBe('anonymous');
});

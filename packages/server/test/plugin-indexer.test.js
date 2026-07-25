// Server indexer pipeline (HTTP wiring): an admin installs a plugin that ships a
// server indexer; installing backfills existing files, and uninstalling purges. This
// exercises the createServer wiring (IndexerRuntime + PluginIndexers ↔ PluginService ↔
// Vfs); the fine-grained pipeline behaviour is covered by the core test.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from '../src/index.js';

const INDEXER_SRC = `export default async (node, ctx) => {
  const text = await ctx.readText();
  const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
  return { tags: { indexed: true, words } };
};`;

const DEMO_ID = 'acme.com/demo';
const IDX = 'trove+contrib:acme.com/demo/idx';

function indexerPackage(domain = 'acme.com') {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({
      domain, name: 'demo', displayName: 'Demo', version: '1.0.0',
      entry: 'src/index.js', capabilities: { ui: true },
      contributes: {
        idx: { type: 'indexer', match: { ext: ['.demo'] }, entry: 'src/indexers/demo.js' },
      },
    })),
    'src/index.js': strToU8('//'),
    'src/indexers/demo.js': strToU8(INDEXER_SRC),
  });
}

async function json(handle, method, path, body) {
  const res = await handle(new Request(`http://t${path}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// Full proxied upload of a small text body; returns the created node.
async function upload(handle, name, content) {
  const create = await json(handle, 'POST', '/api/uploads', { parentId: 'root', name, size: content.length, contentType: 'application/octet-stream' });
  const d = create.json;
  await handle(new Request(`http://t${d.transfer.partUrl.replace('{partNumber}', '1')}`, { method: 'PUT', body: content }));
  const done = await json(handle, 'POST', d.endpoints.complete, {});
  return done.json.node;
}

test('installing a server indexer backfills existing files; uninstall purges', async () => {
  const { handle } = await createServer({ admins: ['anonymous'] });

  // A file exists before the indexer is installed (its .demo ext matches nothing yet).
  const node = await upload(handle, 'report.demo', 'alpha beta gamma');
  let stat = await json(handle, 'GET', `/api/fs/stat?id=${node.id}`);
  expect(stat.json.node.contributions?.[IDX]).toBeUndefined();

  // Admin installs it → activate() backfills synchronously within the request.
  const inst = await handle(new Request('http://t/api/plugins/install', { method: 'POST', body: indexerPackage() }));
  expect(inst.status).toBe(200);

  stat = await json(handle, 'GET', `/api/fs/stat?id=${node.id}`);
  expect(stat.json.node.contributions[IDX].tags).toEqual({ indexed: true, words: 3 });
  expect(stat.json.node.tags.words).toBe(3); // merged view

  // Uninstall → purge() clears the contribution.
  const rm = await json(handle, 'DELETE', `/api/plugins/${encodeURIComponent(DEMO_ID)}/install`);
  expect(rm.json.removed).toBe(DEMO_ID);
  stat = await json(handle, 'GET', `/api/fs/stat?id=${node.id}`);
  expect(stat.json.node.contributions?.[IDX]).toBeUndefined();
});

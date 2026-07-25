// Server indexer sub-packages: install a plugin that ships an indexer, and verify the
// full pipeline — auto-run on upload, backfill over pre-existing files, output caps,
// and purge on uninstall. Also covers the runtime's clamp + the match selector.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import {
  createVfs, MemoryStorage, IndexerRegistry, textIndexer,
  PluginService, StoragePackageStore, MemoryPluginInstallStore, PluginIndexers,
  InProcessIndexerRuntime, clampContribution, matchFromSelector,
} from '../src/index.js';
import { ROOT_ID } from '../src/metadata/memory.js';

// An indexer that turns a .demo file into tags + metadata + one semantic chunk.
const INDEXER_SRC = `export default async (node, ctx) => {
  const text = await ctx.readText();
  const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
  return {
    tags: { kind: 'demo', words },
    metadata: { firstLine: text.split('\\n')[0] },
    semanticTexts: [{ id: node.id + ':0', text }],
  };
};`;

// An indexer is an entry MODULE in the plugin's own tree, declared in the manifest —
// not a nested sub-package — so it shares code with the rest of the plugin. Its id is
// the contribution URI it lives at, which is also the namespace its output lands under.
const DEMO_ID = 'acme.com/demo';
const IDX = 'trove+contrib:acme.com/demo/idx';

function demoPackage(domain = 'acme.com') {
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

// A Vfs whose indexer registry has only the built-in text indexer, plus the plugin
// wiring (service + coordinator) sharing one PackageStore/install store.
async function harness() {
  const indexers = new IndexerRegistry();
  indexers.register(textIndexer);
  const vfs = await createVfs({ indexers });
  const packages = new StoragePackageStore(new MemoryStorage());
  const runtime = new InProcessIndexerRuntime();
  const coordinator = new PluginIndexers({ vfs, runtime, packages });
  const installs = new MemoryPluginInstallStore();
  const plugins = new PluginService({ packages, installs, indexers: coordinator, isAdmin: () => true });
  await plugins.init();
  return { vfs, plugins, installs, coordinator };
}

const principal = { id: 'user1' };

async function write(vfs, name, text) {
  return vfs.writeFile(ROOT_ID, name, strToU8(text), { contentType: 'application/octet-stream' });
}

test('installed indexer auto-runs on upload and namespaces its contribution', async () => {
  const { vfs, plugins } = await harness();
  await plugins.install({ principal, bytes: demoPackage() });

  const node = await write(vfs, 'notes.demo', 'alpha beta gamma\nsecond line');
  const fresh = await vfs.metadata.getById(node.id);
  expect(fresh.contributions[IDX].tags).toEqual({ kind: 'demo', words: 5 });
  expect(fresh.contributions[IDX].metadata.firstLine).toBe('alpha beta gamma');
  // Merged tag view drives filtering.
  expect(fresh.tags.kind).toBe('demo');
  expect(fresh.tags.words).toBe(5);
});

test('installing an indexer backfills existing files', async () => {
  const { vfs, plugins } = await harness();
  // File exists BEFORE the indexer is installed → only the text indexer (which
  // doesn't match .demo) has run, so no plugin contribution yet.
  const node = await write(vfs, 'old.demo', 'one two three');
  expect((await vfs.metadata.getById(node.id)).contributions[IDX]).toBeUndefined();

  await plugins.install({ principal, bytes: demoPackage() });
  const after = await vfs.metadata.getById(node.id);
  expect(after.contributions[IDX].tags.words).toBe(3);
});

test('uninstalling an indexer purges its contributions everywhere', async () => {
  const { vfs, plugins } = await harness();
  await plugins.install({ principal, bytes: demoPackage() });
  const a = await write(vfs, 'a.demo', 'x y');
  const b = await write(vfs, 'b.demo', 'p');
  expect((await vfs.metadata.getById(a.id)).contributions[IDX]).toBeDefined();

  await plugins.remove(principal, DEMO_ID);
  expect((await vfs.metadata.getById(a.id)).contributions[IDX]).toBeUndefined();
  expect((await vfs.metadata.getById(b.id)).contributions[IDX]).toBeUndefined();

  // And it no longer runs on new uploads.
  const c = await write(vfs, 'c.demo', 'q');
  expect((await vfs.metadata.getById(c.id)).contributions[IDX]).toBeUndefined();
});

test('init() re-activates installed indexers (live hook restored, no double backfill)', async () => {
  const { vfs, plugins, installs, coordinator } = await harness();
  await plugins.install({ principal, bytes: demoPackage() });

  // Simulate a restart: a brand-new service over the SAME stores/coordinator.
  vfs.indexers.unregister(IDX); // drop the live registration
  const plugins2 = new PluginService({ packages: plugins.packages, installs, indexers: coordinator, isAdmin: () => true });
  await plugins2.init();

  const node = await write(vfs, 'after-restart.demo', 'a b c d e');
  expect((await vfs.metadata.getById(node.id)).contributions[IDX].tags.words).toBe(5);
});

test('server-indexer plugins are refused when no runtime is configured', async () => {
  const indexers = new IndexerRegistry();
  indexers.register(textIndexer);
  const vfs = await createVfs({ indexers });
  void vfs;
  const packages = new StoragePackageStore(new MemoryStorage());
  // No `indexers` coordinator → indexer packages must be rejected, not silently no-op.
  const plugins = new PluginService({ packages, installs: new MemoryPluginInstallStore(), indexers: null, isAdmin: () => true });
  await plugins.init();
  let code = null;
  try { await plugins.install({ principal, bytes: demoPackage() }); } catch (e) { code = e.code; }
  expect(code).toBe('unsupported');
});

test('clampContribution enforces the output caps', () => {
  const big = 'x'.repeat(200_000);
  const out = clampContribution({
    semanticTexts: Array.from({ length: 1000 }, (_, i) => ({ text: `t${i}` })),
    tags: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i])),
    metadata: { note: 'ok' },
  });
  expect(out.semanticTexts.length).toBe(500); // maxSemanticTexts
  expect(Object.keys(out.tags).length).toBe(100); // maxTags

  const clipped = clampContribution({ semanticTexts: [{ text: big }] });
  expect(clipped.semanticTexts[0].text.length).toBe(100_000); // maxTextChars

  // Object/array tag values and oversized metadata are dropped.
  const dropped = clampContribution({ tags: { good: 'v', bad: { nested: 1 }, arr: [1] } });
  expect(dropped.tags).toEqual({ good: 'v' });
  const huge = clampContribution({ metadata: { blob: 'y'.repeat(300 * 1024) } });
  expect(huge.metadata).toBeUndefined();
});

test('matchFromSelector matches by extension and mime (exact + prefix)', () => {
  const byExt = matchFromSelector({ ext: ['.pdf', 'epub'] });
  expect(byExt({ kind: 'file', name: 'a.pdf' })).toBe(true);
  expect(byExt({ kind: 'file', name: 'a.epub' })).toBe(true);
  expect(byExt({ kind: 'file', name: 'a.txt' })).toBe(false);
  expect(byExt({ kind: 'folder', name: 'a.pdf' })).toBe(false);

  const byMime = matchFromSelector({ mime: ['application/pdf', 'image/*'] });
  expect(byMime({ kind: 'file', name: 'x', contentType: 'application/pdf' })).toBe(true);
  expect(byMime({ kind: 'file', name: 'x', contentType: 'image/png' })).toBe(true);
  expect(byMime({ kind: 'file', name: 'x', contentType: 'text/plain' })).toBe(false);

  expect(matchFromSelector({})({ kind: 'file', name: 'x.pdf' })).toBe(false); // no selector → matches nothing
});

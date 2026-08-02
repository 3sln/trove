// The install-time refusal, and the sandbox runtime that makes it unnecessary.
//
// This file exists because of a specific failure, and the shape of that failure is the
// reason the probe is worth its keep: the in-process runner loads indexer code by
// importing a `data:` URL. Node and Bun allow that. **workerd does not.** So on a
// Cloudflare deployment every plugin indexer installed cleanly, reported no error at
// install, and then failed once per file with `No such module "data:…"` — a drive whose
// search index was quietly missing everything its plugins were supposed to contribute,
// with nothing anywhere saying so.
//
// The design doc's provider matrix already specified the refusal (§7, `CF plain / none`
// → "install-scope check refuses server-indexer plugins on this deployment, with a clear
// message"). It could not fire, because it keyed on the runtime being ABSENT, and a
// broken runtime is present.

import { test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { InProcessIndexerRuntime, WorkerLoaderIndexerRuntime, PluginService, MemoryPluginInstallStore, parsePluginPackage } from '../src/index.js';

test('the in-process runtime probes true where dynamic import works', async () => {
  // Bun, so it does work — and the probe must say so, or the refusal would fire on every
  // deployment and nobody could install an indexer anywhere.
  expect(await new InProcessIndexerRuntime().probe()).toEqual({ ok: true });
});

test('a runtime that cannot load code SKIPS the indexers and says so', async () => {
  // The REAL install path, with a real package zip — not a re-statement of the gate.
  // A test that reimplements the check it is testing passes when the check is deleted,
  // which is the same class of hole that let the original bug live.
  const manifest = {
    name: 'probe', domain: 'test.com', version: '1.0.0', entry: 'i.js',
    capabilities: { indexer: true },
    contributes: { things: { type: 'indexer', entry: 'i.js', match: { ext: ['.bin'] } } },
  };
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'i.js': strToU8('export default () => ({})'),
  });
  const pkg = await parsePluginPackage(bytes);
  expect(pkg.indexers.length).toBe(1); // the gate is only reachable for a package like this

  let activated = 0;
  const store = new Map();
  const service = new PluginService({
    packages: {
      async has(r) { return store.has(r); },
      async put(r, b) { store.set(r, b); },
      async get(r) { return store.get(r); },
      async delete(r) { store.delete(r); },
      async countByDigest() { return 0; },
    },
    installs: new MemoryPluginInstallStore(),
    isAdmin: () => true,
    // Standing in for workerd: the probe fails exactly as the `data:` import does there.
    indexers: {
      async probe() { return { ok: false, reason: 'this runtime cannot load plugin code dynamically' }; },
      async activate() { activated++; return 0; },
    },
  });

  const principal = { id: 'admin' };
  // It INSTALLS. A plugin is more than its indexer — refusing would take the viewers and
  // commands away too, over one part this deployment happens not to be able to host.
  const rec = await service.install({ principal, bytes });
  expect(rec.pluginId).toBe('test.com/probe');

  // But the indexer is not registered, so it cannot fail once per file forever...
  expect(activated).toBe(0);
  // ...and the reason rides on the record, which is what turns "my search is empty" into
  // a sentence someone can act on.
  expect(rec.indexersSkipped).toMatch(/cannot load plugin code dynamically/);
  expect((await service.list(principal))[0].indexersSkipped).toBeTruthy();
});

test('the same package installs when the runtime CAN run it', async () => {
  // The other side of the gate — without this, a probe hard-wired to false would pass
  // the test above and break every deployment.
  const manifest = {
    name: 'probe', domain: 'test.com', version: '1.0.0', entry: 'i.js',
    capabilities: { indexer: true },
    contributes: { things: { type: 'indexer', entry: 'i.js', match: { ext: ['.bin'] } } },
  };
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'i.js': strToU8('export default () => ({})'),
  });
  const store = new Map();
  const service = new PluginService({
    packages: {
      async has(r) { return store.has(r); },
      async put(r, b) { store.set(r, b); },
      async get(r) { return store.get(r); },
      async delete(r) { store.delete(r); },
      async countByDigest() { return 0; },
    },
    installs: new MemoryPluginInstallStore(),
    isAdmin: () => true,
    indexers: { async probe() { return { ok: true }; }, async activate() { return 0; } },
  });
  const principal = { id: 'admin' };
  const rec = await service.install({ principal, bytes });
  expect(rec.pluginId).toBe('test.com/probe');
  expect(rec.indexers.length).toBe(1);
  // No annotation when they ARE running — otherwise the UI would warn on every drive.
  expect(rec.indexersSkipped).toBeUndefined();
});

test('the Worker Loader runtime refuses to exist without a binding', () => {
  // Constructing it is the check — a runtime that silently no-ops is how the original
  // bug survived, so this one cannot be built in a state where it cannot run.
  expect(() => new WorkerLoaderIndexerRuntime({})).toThrow();
  expect(() => new WorkerLoaderIndexerRuntime({ loader: { get: () => {} } })).not.toThrow();
});

test('the Worker Loader runtime hands the sandbox code and a URL, and nothing else', async () => {
  let loaded = null;
  let sent = null;
  const loader = {
    get(id, getCode) {
      return {
        getEntrypoint: () => ({
          async fetch(url, init) {
            loaded = { id, code: await getCode() };
            sent = JSON.parse(init.body);
            return new Response(JSON.stringify({ contribution: { tags: { ok: 'yes' } } }), {
              headers: { 'content-type': 'application/json' },
            });
          },
        }),
      };
    },
  };
  const runtime = new WorkerLoaderIndexerRuntime({ loader });
  const spec = { id: 'ind', entry: 'e.js', cacheKey: 'digest\0ind', files: { 'e.js': new TextEncoder().encode('export default () => ({})') } };
  const node = { id: 'n1', name: 'b.m4b', contentType: 'audio/mp4', size: 99 };

  const out = await runtime.run(spec, node, {
    presignRead: async () => 'https://bucket.example/obj?sig=abc',
    maxBytes: 1234,
    config: { a: 1 },
  });

  // Keyed by the cacheKey, which embeds the package digest — so reinstalling at the same
  // version cannot be served by an isolate still holding the previous code.
  expect(loaded.id).toBe('digest\0ind');
  // The plugin's entry goes in as a module beside the host shim, never evaluated by the
  // parent Worker.
  expect(Object.keys(loaded.code.modules).sort()).toEqual(['entry.js', 'shim.js']);
  expect(loaded.code.mainModule).toBe('shim.js');
  // NO bindings. The sandbox's entire reach is the one presigned URL in the body.
  expect(loaded.code.env).toEqual({});
  expect(sent.url).toBe('https://bucket.example/obj?sig=abc');
  expect(sent.maxBytes).toBe(1234);
  // Output still goes through the clamp, same as every other runtime.
  expect(out.tags).toEqual({ ok: 'yes' });
});

test('a storage backend that cannot presign fails loudly rather than indexing nothing', async () => {
  const runtime = new WorkerLoaderIndexerRuntime({ loader: { get: () => ({ getEntrypoint: () => ({}) }) } });
  const spec = { id: 'ind', entry: 'e.js', files: { 'e.js': new Uint8Array(1) } };
  // No `presignRead` on the context: the sandbox has no other way to reach the bytes,
  // and an empty contribution would look like "this file has no metadata".
  await expect(runtime.run(spec, { id: 'n', name: 'x', size: 1 }, {})).rejects.toThrow(/presigned read URL/);
});

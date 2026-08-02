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
import { SHIM } from '../src/plugins/workerLoaderRuntime.js';
import { PROBE_BYTES } from '../src/plugins/runtime.js';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Written to a file rather than imported as a data: URL — Bun refuses one this long
// with `NameTooLong`, which is a property of the test harness, not of the shim.
let n = 0;
const asModule = async (src) => {
  // Each module gets its OWN fresh directory. Bun resolves the first dynamic import of a
  // newly-written file in a directory and then fails the second with
  // `Cannot find module … from ''` — a cached directory listing, reproducible in four
  // lines outside this suite. A new directory per module sidesteps it; writing both files
  // up front does not.
  const dir = join(tmpdir(), `trove-shim-${process.pid}-${n++}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'shim.mjs');
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
};

test('the in-process runtime probes true where dynamic import works', async () => {
  // Bun, so it does work — and the probe must say so, or the refusal would fire on every
  // deployment and nobody could install an indexer anywhere.
  expect(await new InProcessIndexerRuntime().probe()).toEqual({ ok: true });
});

test('an indexer bigger than a data: URL can hold still loads', async () => {
  // The bug this pins: Bun resolves a data: URL as a PATH, so anything over ~1.5 KB comes
  // back as `NameTooLong`. The real audiobook entry is 34 KB — thirty times over — so
  // every non-toy indexer failed on Bun, per file, while a 12-byte probe said all was
  // well. Node has no such limit but rejects the blob: fallback, so the loader needs both.
  const runtime = new InProcessIndexerRuntime();
  const big = new TextEncoder().encode(
    `export default (node) => ({ tags: { size: '${'x'.repeat(40_000)}'.length } });`,
  );
  const out = await runtime.run({ id: 'big', entry: 'e.js', files: { 'e.js': big } }, { id: 'n' }, {});
  expect(out.tags.size).toBe(40_000);
});

test('the probe is bigger than a real indexer entry, or it proves nothing', async () => {
  // The whole point of the padding: a probe under the limit it is meant to detect passes
  // on a runtime that then fails every actual file. Pinned against the real thing — the
  // audiobook indexer's built entry — so shrinking the probe fails here rather than in
  // production. If a plugin ever ships an entry larger than this, the probe stops being
  // representative and this test is where that gets noticed.
  const entry = statSync(new URL('../../../plugins/audiobook/src/bookIndexer.js', import.meta.url)).size;
  expect(PROBE_BYTES).toBeGreaterThan(entry);
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

test('the sandbox shim is valid JavaScript', async () => {
  // The shim is code GENERATED as a template literal, which means a mis-escaped nested
  // literal is a syntax error nothing catches until a sandbox refuses to boot — and what
  // workerd says then is "Failed to start Worker:", with no location and no detail.
  // The first version of this file had exactly that bug, and the fake-loader test above
  // sailed past it because a fake loader never compiles anything.
  //
  // So: actually parse it. Bun can import a data: URL, which is the cheapest real parser
  // available here.
  const mod = await asModule(SHIM.replace("import * as entry from './entry.js';", 'const entry = { default: () => ({}) };'));
  expect(typeof mod.default?.fetch).toBe('function');
});

test('the shim reads a range as an inclusive HTTP header, and honours maxBytes', async () => {
  // `end` is EXCLUSIVE host-side and INCLUSIVE in a Range header. Getting that wrong
  // silently drops the last byte of every read, which in an MP4 box walk means a header
  // that is one byte short and a parse that fails somewhere else entirely.
  // Load the module BEFORE stubbing fetch: Bun's ESM loader uses global fetch to resolve,
  // so a stub installed first makes the import itself fail.
  const mod = await asModule(SHIM.replace(
    "import * as entry from './entry.js';",
    'const entry = { default: async (node, ctx) => { await ctx.readRange(0, 4); await ctx.readRange(0, 1e9); return {}; } };',
  ));

  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(init?.headers?.Range);
    return new Response(new Uint8Array(4), { status: 206 });
  };
  try {
    await mod.default.fetch(new Request('https://x/', {
      method: 'POST',
      body: JSON.stringify({ node: { size: 100 }, url: 'https://o/', maxBytes: 10, config: {}, secrets: {} }),
    }));
  } finally {
    globalThis.fetch = realFetch;
  }
  // 0..4 exclusive -> bytes=0-3
  expect(asked[0]).toBe('bytes=0-3');
  // clamped by maxBytes (10), not by the node's size (100)
  expect(asked[1]).toBe('bytes=0-9');
});

test('a deployment that cannot index raises a diagnostic, and clears it when it can', async () => {
  // The symptom is an ABSENCE — a drive whose plugin indexers never ran looks identical
  // to one with nothing to index — so the only way anyone finds out is if the drive says
  // so. And it has to stop saying so on its own, or every drive that later gains a
  // Worker Loader binding keeps a permanent false warning.
  const raised = new Map();
  const issues = {
    async raise(spec) { raised.set(`${spec.kind}:${spec.subject}`, spec); return spec; },
    async clear(kind, subject) { raised.delete(`${kind}:${subject}`); },
  };
  const record = { account: 'a', pluginId: 'test.com/probe', digest: 'sha256:d', packageRef: 'r', indexers: [{ id: 'i1', entry: 'e.js' }] };

  let canRun = false;
  const runtime = { async probe() { return canRun ? { ok: true } : { ok: false, reason: 'no isolate runtime here' }; } };
  const vfs = { issues, indexers: { register: () => () => {} }, async purgeIndexer() {}, async backfillIndexer() {} };
  const { PluginIndexers } = await import('../src/plugins/indexers.js');
  const coordinator = new PluginIndexers({ vfs, runtime, packages: { async get() { return { stream: null }; } } });

  // Cannot run → the diagnostic is raised, and registration is not even attempted.
  expect(await coordinator.activate(record, { backfill: false })).toBe(0);
  const issue = raised.get('plugin-indexers:test.com/probe');
  expect(issue).toBeTruthy();
  expect(issue.detail).toBe('no isolate runtime here');
  // It must be RETRYABLE and say what to do — an issue with neither is just a complaint.
  expect(issue.retry.op).toBe('reactivate-indexers');
  expect(issue.remedy).toMatch(/worker_loaders/);
  // A warning, not an error: the drive works, one thing it could do is missing.
  expect(issue.severity).toBe('warning');

  // The binding appears (a deploy, a restart) → the next activation clears it, with
  // nobody rewriting a stored answer.
  canRun = true;
  await coordinator.activate(record, { backfill: false }).catch(() => {});
  expect(raised.get('plugin-indexers:test.com/probe')).toBeUndefined();
});

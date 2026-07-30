// Restart survival. Trove has no folders — search IS the navigation — so an index
// that doesn't come back is a drive whose files are all present and none of them
// reachable. That is data loss in everything but name, and it is exactly what these
// tests reproduce: write, stop the server, start it again, ask for the file back.
//
// Two mechanisms have to hold, and they are tested separately because either one
// alone leaves a hole:
//   1. the stores persist, so an ordinary restart costs nothing; and
//   2. when the index IS empty beside a non-empty drive — a store that used to be in
//      memory, a metadata-only restore, an embedding change — startup rebuilds it.

import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index.js';
// A filesystem-backed drive has to say it can do filesystems. The driver is registered by
// the entry point, not by core — which is what keeps node:fs out of a Workers bundle.
import { filesystemDriver } from '@3sln/trove/core/storage/filesystem.js';

const TEXT = 'Dune is a science fiction novel about the desert planet Arrakis and the spice melange.';

async function withDrive(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'trove-persist-'));
  const config = () => ({
    storage: { driver: 'filesystem', root: join(dir, 'objects') },
    metadata: { driver: 'sqlite', path: join(dir, 'trove.db') },
    storageDrivers: [filesystemDriver()],
    startFlusher: false,
  });
  const open = async (extra = {}) => createServer({ ...config(), ...extra });
  try {
    return await fn(open, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const hits = (srv, q) => srv.vfs.search.search(q).then((r) => r.length);

test('a file written before a restart is still findable after it', async () => {
  await withDrive(async (open) => {
    let srv = await open();
    // A file-backed deployment gets durable stores without being asked; the memory
    // ones are a test double and a fallback, not a default for a drive with files.
    expect(srv.vfs.search.describe().keywordStore).toBe('SqliteKeywordStore');
    await srv.vfs.writeFile('dune.md', TEXT, { contentType: 'text/markdown' });
    expect(await hits(srv, 'melange')).toBe(1);
    expect(await hits(srv, 'dune.md')).toBe(1); // by name, too
    await srv.close();

    srv = await open();
    await srv.indexRebuild;
    expect((await srv.vfs.list('default')).items.length).toBe(1);
    expect(await hits(srv, 'melange')).toBe(1);
    expect(await hits(srv, 'dune.md')).toBe(1);
    // Nothing needed rebuilding — the index was simply still there.
    expect(await srv.indexRebuild).toBe(null);
    await srv.close();
  });
});

test('an empty index beside a non-empty drive is rebuilt at startup', async () => {
  await withDrive(async (open) => {
    let srv = await open();
    for (const name of ['dune.md', 'arrakis.md', 'spice.md']) {
      await srv.vfs.writeFile(name, TEXT, { contentType: 'text/markdown' });
    }
    // Simulate the index being lost while the drive survives: a metadata-only restore,
    // or an upgrade from a deployment whose stores were in memory.
    const db = await srv.sqlite.obtain({ key: 'search' });
    await db.exec('DELETE FROM kw_docs');
    await srv.close();

    srv = await open();
    const rebuild = await srv.indexRebuild;
    expect(rebuild).toEqual({ indexed: 3, failed: 0, stopped: false, total: 3 });
    expect(await hits(srv, 'melange')).toBe(3);
    await srv.close();

    // …and having rebuilt once, it does not do it again on every subsequent start.
    srv = await open();
    expect(await srv.indexRebuild).toBe(null);
    await srv.close();
  });
});

test('an empty drive is not mistaken for a lost index', async () => {
  await withDrive(async (open) => {
    const srv = await open();
    expect(await srv.indexRebuild).toBe(null); // nothing to rebuild FROM
    await srv.close();
  });
});

test('a memory drive keeps the memory stores rather than a database that vanishes', async () => {
  // With nowhere durable to write, SQLite would be worse than memory: it would look
  // persistent right up until the restart that proves it isn't.
  const srv = await createServer({ startFlusher: false });
  expect(srv.vfs.search.describe().vectorStore).toBe('MemoryVectorStore');
  expect(srv.vfs.search.describe().keywordStore).toBe('MemoryKeywordStore');
  expect(await srv.indexRebuild).toBe(null);
  await srv.close();
});

test('an injected search service is used as-is, and an explicit driver overrides the default', async () => {
  await withDrive(async (open) => {
    // A durable drive asked for memory gets memory — the default is a default, not a
    // policy.
    const srv = await open({ vectorStore: { driver: 'memory' }, keywordStore: { driver: 'memory' } });
    expect(srv.vfs.search.describe().vectorStore).toBe('MemoryVectorStore');
    expect(srv.vfs.search.describe().keywordStore).toBe('MemoryKeywordStore');
    await srv.close();
  });
});

test('links and backlinks survive a restart too', async () => {
  // Backlinks live in the metadata store, not the search index — but they are derived
  // from an indexer's contribution, so a rebuild has to put them back the same way.
  await withDrive(async (open) => {
    let srv = await open();
    const target = await srv.vfs.writeFile('target.md', '# Target', { contentType: 'text/markdown' });
    await srv.vfs.writeFile('index.md', '- [Target](trove:default/target.md)\n', { contentType: 'text/markdown' });
    expect((await srv.vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['index.md']);
    await srv.close();

    srv = await open();
    await srv.indexRebuild;
    expect((await srv.vfs.backlinks(target.id)).map((n) => n.name)).toEqual(['index.md']);
    await srv.close();
  });
});

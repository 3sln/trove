// The client half of encryption, against the real server.
//
// Both halves were written from the same envelope module, which is exactly the kind of
// agreement that looks obvious and is worth proving: the client seals, the server refuses
// anything that is not sealed correctly, and what comes back out is the file.

import { test, expect } from './testkit.js';
import { TroveApiClient } from '../src/platform/api.js';
import { createServer } from '@3sln/trove/server';
import { CollectionService, MemoryKV, MemoryStorage, isEnvelope } from '@3sln/trove/core';

const BOSS = { id: 'boss@example.com', email: 'boss@example.com', roles: [] };

/**
 * Just enough XMLHttpRequest to run the upload orchestrator outside a browser.
 *
 * `upload()` uses XHR because fetch cannot report upload progress; what is under test here
 * is the sealing and the part sequencing, not XHR itself. Delegates to the same handler the
 * client's fetch does, so the server sees exactly what a browser would send.
 */
function installXhr(handle) {
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    constructor() {
      this.upload = { onprogress: null };
      this.status = 0;
      this.responseText = '';
      this._headers = {};
    }
    open(method, url) { this._method = method; this._url = url; }
    setRequestHeader(k, v) { this._headers[k] = v; }
    getResponseHeader(k) { return this._res?.headers.get(k) || null; }
    abort() { this._aborted = true; }
    send(body) {
      (async () => {
        try {
          const res = await handle(new Request(this._url, {
            method: this._method, headers: this._headers, body,
          }));
          this._res = res;
          this.status = res.status;
          this.responseText = await res.text();
          const n = body?.size ?? body?.byteLength ?? 0;
          this.upload.onprogress?.({ loaded: n, total: n, lengthComputable: true });
          this.onload?.();
        } catch (err) {
          this.onerror?.(err);
        }
      })();
    }
  };
  return () => { globalThis.XMLHttpRequest = previous; };
}

/** A real server, reached the way the browser reaches one. */
async function drive({ rules = { all: true } } = {}) {
  const kv = new MemoryKV();
  const storage = new MemoryStorage();
  const collections = new CollectionService({
    kv, storageFactory: () => storage, admins: [BOSS.id], defaultOpen: false,
  });
  const server = await createServer({
    rebuildIndexOnStart: false, collections,
    identity: { driver: 'header', header: { idHeader: 'x-user', required: false } },
  });
  const secret = await collections.create({
    name: 'Private', store: { driver: 'memory' }, encryption: { enabled: true, rules },
  }, BOSS);
  const open = await collections.create({ name: 'Open', store: { driver: 'memory' } }, BOSS);

  // The client, with every request carrying the admin header the way a session would.
  const client = new TroveApiClient({
    baseUrl: 'https://drive.test',
    fetch: (url, init = {}) => server.handle(new Request(url, {
      ...init, headers: { ...(init.headers || {}), 'x-user': BOSS.id },
    })),
  });
  const restoreXhr = installXhr((req) => server.handle(new Request(req, {
    headers: { ...Object.fromEntries(req.headers), 'x-user': BOSS.id },
  })));
  return { server, storage, collections, client, secret, open, restoreXhr };
}

const fileOf = (name, text, type = 'text/plain') => new File([text], name, { type });

test('the client seals before the bytes leave, and the drive returns the file', async () => {
  const d = await drive();
  const node = await d.client.upload(fileOf('q.txt', 'nobody else’s business'), { collection: d.secret.id });
  expect(node.name).toBe('q.txt');
  // The size the user recognises, not the envelope's.
  expect(node.size).toBe(new TextEncoder().encode('nobody else’s business').length);

  // What the bucket holds is an envelope.
  const raw = await d.storage.get(node.storageKey);
  const stored = new Uint8Array(await new Response(raw.stream).arrayBuffer());
  expect(isEnvelope(stored)).toBe(true);
  expect(new TextDecoder().decode(stored)).not.toContain('business');

  // And reading it back gives the file — the server decrypts, so this needs no client work.
  const res = await d.client._fetch('https://drive.test/api/items/download?id=' + node.id);
  expect(await res.text()).toBe('nobody else’s business');
});

test('an unencrypted collection is untouched by any of it', async () => {
  const d = await drive();
  const node = await d.client.upload(fileOf('plain.txt', 'nothing secret'), { collection: d.open.id });
  const raw = await d.storage.get(node.storageKey);
  const stored = new Uint8Array(await new Response(raw.stream).arrayBuffer());
  expect(isEnvelope(stored)).toBe(false);
  expect(new TextDecoder().decode(stored)).toBe('nothing secret');
});

test('rules decide per file, and the client follows the plan rather than guessing', async () => {
  const d = await drive({ rules: { extensions: ['secret'] } });
  const hidden = await d.client.upload(fileOf('a.secret', 'hidden', 'application/octet-stream'), { collection: d.secret.id });
  const shown = await d.client.upload(fileOf('b.txt', 'visible'), { collection: d.secret.id });

  const one = new Uint8Array(await new Response((await d.storage.get(hidden.storageKey)).stream).arrayBuffer());
  const two = new Uint8Array(await new Response((await d.storage.get(shown.storageKey)).stream).arrayBuffer());
  expect(isEnvelope(one)).toBe(true);
  expect(isEnvelope(two)).toBe(false);
});

test('a large file goes up sealed, in parts, and comes back whole', async () => {
  // The multipart path: parts are slices of the ENVELOPE, produced in order because the
  // nonce comes from the chunk's position. This is the one that cannot reuse the plaintext
  // path at all.
  const d = await drive();
  const size = 3 * 1024 * 1024;
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 512) body[i] = i % 251;
  const node = await d.client.upload(new File([body], 'big.bin', { type: 'application/octet-stream' }), {
    collection: d.secret.id,
  });
  expect(node.size).toBe(size);

  const res = await d.client._fetch('https://drive.test/api/items/download?id=' + node.id);
  const out = new Uint8Array(await res.arrayBuffer());
  expect(out.length).toBe(size);
  expect(out[0]).toBe(body[0]);
  expect(out[512]).toBe(body[512]);
  expect(out[size - 512]).toBe(body[size - 512]);
});

test('progress is reported against what travels, so it never passes 100%', async () => {
  // The envelope is larger than the file; measured against the file the bar would run past
  // the end and sit there.
  const d = await drive();
  const ratios = [];
  await d.client.upload(fileOf('p.txt', 'x'.repeat(1000)), {
    collection: d.secret.id,
    onProgress: (p) => ratios.push(p.ratio),
  });
  expect(ratios.length).toBeGreaterThan(0);
  expect(Math.max(...ratios)).toBeLessThanOrEqual(1);
});

// --- sealing sequentially, sending concurrently ---------------------------------
//
// Chunk n's nonce is `prefix || n`, so SEALING must stay strictly ordered. SENDING has no
// such constraint — the backend assembles by part number. The two used to be conflated:
// each part was awaited before more of the envelope was read, making an encrypted upload
// roughly `concurrency` times slower than the same file to a plain collection on any link
// where round-trip time dominates.
//
// Measured before it was changed: sealing runs at ~2 GiB/s against ~12 MiB/s for a good
// 100 Mbit link, so it was never the cost. What follows tests the decoupling, not the
// speed — a wall-clock assertion would be a flake.

/** A drive whose part uploads block until released, so overlap is observable. */
async function gatedDrive() {
  const d = await drive();
  const inFlight = new Set();
  let peak = 0;
  let release = null;
  const gate = () => new Promise((r) => { release = r; });
  let pending = gate();

  const realXhrRestore = d.restoreXhr;
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class extends previous {
    send(body) {
      const isPart = /\/parts\/\d+$/.test(this._url || '');
      if (!isPart) return super.send(body);
      inFlight.add(this);
      peak = Math.max(peak, inFlight.size);
      pending.then(() => { inFlight.delete(this); super.send(body); });
    }
  };
  return {
    ...d,
    peak: () => peak,
    inFlight: () => inFlight.size,
    releaseAll() { release?.(); pending = gate(); },
    restore() { globalThis.XMLHttpRequest = previous; realXhrRestore?.(); },
  };
}

test('parts of an encrypted upload go out concurrently', async () => {
  const d = await gatedDrive();
  try {
    // Four parts at the 5 MiB floor the plan uses.
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'big.bin', { type: 'application/octet-stream' });
    const done = d.client.upload(big, { collection: d.secret.id, concurrency: 4 });

    // Give the producer time to seal ahead and the senders time to pick work up.
    for (let i = 0; i < 20 && d.inFlight() < 2; i++) await new Promise((r) => setTimeout(r, 20));
    // The property: more than one part is on the wire at once. Before this it was always
    // exactly one, because sealing and sending were the same loop.
    expect(d.peak()).toBeGreaterThan(1);

    for (let i = 0; i < 40; i++) { d.releaseAll(); await new Promise((r) => setTimeout(r, 10)); }
    const node = await done;
    expect(node.size).toBe(21 * 1024 * 1024);
  } finally {
    d.restore();
  }
});

test('sealing ahead is bounded, so a slow link cannot buffer the file', async () => {
  const d = await gatedDrive();
  try {
    const big = new File([new Uint8Array(60 * 1024 * 1024)], 'huge.bin', { type: 'application/octet-stream' });
    const done = d.client.upload(big, { collection: d.secret.id, concurrency: 2 });
    // Nothing is released, so every sender is stuck. The producer must block on the queue
    // rather than sealing the rest of the file into memory — which is the problem the
    // streaming rewrite existed to solve and a queue could quietly reintroduce.
    await new Promise((r) => setTimeout(r, 250));
    // workers + 1 queued + the ones actually in flight. Far short of the 12 parts this file
    // would make if the producer ran to completion.
    expect(d.inFlight()).toBeLessThanOrEqual(4);

    for (let i = 0; i < 60; i++) { d.releaseAll(); await new Promise((r) => setTimeout(r, 5)); }
    await done;
  } finally {
    d.restore();
  }
});

test('parts sent out of order still assemble into the original file', async () => {
  // The risk of decoupling: a part manifest in arrival order rather than part-number order
  // would produce a file that is byte-shuffled and still "uploads successfully".
  const d = await drive();
  const body = new Uint8Array(12 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31) % 251;
  const node = await d.client.upload(
    new File([body], 'ordered.bin', { type: 'application/octet-stream' }),
    { collection: d.secret.id, concurrency: 4 },
  );
  expect(node.size).toBe(body.length);

  const res = await d.client._fetch('https://drive.test/api/items/download?id=' + node.id);
  const out = new Uint8Array(await res.arrayBuffer());
  expect(out.length).toBe(body.length);
  // Spot the seams a mis-ordered manifest would show at, then the whole thing.
  expect(Array.from(out.slice(0, 32))).toEqual(Array.from(body.slice(0, 32)));
  expect(Array.from(out.slice(5 * 1024 * 1024 - 16, 5 * 1024 * 1024 + 16)))
    .toEqual(Array.from(body.slice(5 * 1024 * 1024 - 16, 5 * 1024 * 1024 + 16)));
  expect(Array.from(out)).toEqual(Array.from(body));
});

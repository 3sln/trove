// WorkerLoaderIndexerRuntime — the Cloudflare arm of the provider matrix.
//
// This is step 4 of docs/design/server-plugins-and-indexers.md §11, and the reason the
// in-process runner is not the answer on Workers: it loads indexer code by importing a
// `data:` URL, which workerd refuses outright. Every plugin indexer on a Worker
// deployment failed with `No such module "data:text/javascript;base64,…"`, once per
// file, silently. See `InProcessIndexerRuntime.probe()`.
//
// A Worker Loader is the fix the doc already chose over Workers-for-Platforms dispatch
// namespaces: no per-install upload step, so the install flow stays identical across
// runtimes — every deployment stores the same package blob, and only execution differs.
// The parent Worker never evaluates plugin code at all; the loader builds a genuinely
// separate isolate for it.
//
// THE BYTES PROBLEM, and why it is solved with a URL rather than RPC. An indexer reads
// its file adaptively — the audiobook one walks MP4 boxes, so which range it wants next
// depends on what the last range said. That is a conversation, and a conversation across
// an isolate boundary is either RPC plumbing on every deployment or one thing the
// sandbox can already do: fetch. So the host mints a time-limited presigned read URL
// (§8, `ctx.presignRead()`) and the shim implements `readRange` as a ranged GET against
// it. The sandbox reaches exactly one object, for a few minutes, and the host holds no
// open channel it has to police.
//
// What the sandbox is allowed to do is therefore precisely: fetch that URL. `env` carries
// no bindings — no storage, no database, no secrets beyond the plugin's own config — and
// the entrypoint is called once with one node.

import { TroveError } from '../errors.js';
import { withTimeout } from '../retry.js';
import { clampContribution, DEFAULT_CAPS } from '../indexers/contribution.js';
import { IndexerRuntime } from './runtime.js';

/**
 * The module that runs INSIDE the sandbox, wrapping the plugin's own entry.
 *
 * It exists because the plugin's `index(node, ctx)` contract is a function call and a
 * dynamic Worker's contract is `fetch(request)`. This is the adapter between them, and
 * it is the only host-authored code in there.
 *
 * `readRange` is deliberately the same shape the in-process context offers, so an
 * indexer cannot tell which runtime it is on — that is what makes the audiobook indexer
 * work unchanged on both.
 */
export const SHIM = `
import * as entry from './entry.js';

const fn = entry.default || entry.index;

export default {
  async fetch(request) {
    const { node, url, maxBytes, config, secrets } = await request.json();
    if (typeof fn !== 'function') {
      return Response.json({ error: 'no default/index export' }, { status: 500 });
    }
    // One ranged GET per call, against the presigned URL and nothing else. \`end\` is
    // exclusive here (as it is host-side) and inclusive in an HTTP Range header — the
    // off-by-one that would silently drop the last byte of every read.
    const readRange = async (start = 0, end = node.size) => {
      const from = Math.max(0, Math.min(start, node.size));
      const to = Math.min(end, from + maxBytes, node.size);
      if (to <= from) return new Uint8Array(0);
      // Concatenation rather than a template literal, deliberately: this whole module is
      // itself a template literal, and a nested one has to be escaped through two levels.
      // The first version got that wrong and every sandbox died with "Failed to start
      // Worker" — a syntax error in generated code, which is invisible at the call site.
      const res = await fetch(url, { headers: { Range: 'bytes=' + from + '-' + (to - 1) } });
      if (!res.ok && res.status !== 206) throw new Error('range read failed: ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    };
    const ctx = {
      readRange,
      readBytes: () => readRange(0, node.size),
      readText: async () => new TextDecoder().decode(await readRange(0, node.size)),
      maxBytes, config, secrets,
    };
    try {
      return Response.json({ contribution: (await fn(node, ctx)) ?? null });
    } catch (err) {
      return Response.json({ error: err?.message || String(err) }, { status: 500 });
    }
  },
};
`;

export class WorkerLoaderIndexerRuntime extends IndexerRuntime {
  /**
   * @param {object} opts
   * @param {{get: Function}} opts.loader the `worker_loaders` binding (env.LOADER)
   * @param {string} [opts.compatibilityDate] what the sandbox is compiled against
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.caps]
   */
  constructor({ loader, compatibilityDate = '2025-01-01', timeoutMs = 10_000, caps = DEFAULT_CAPS } = {}) {
    super();
    if (!loader?.get) throw TroveError.invalid('WorkerLoaderIndexerRuntime needs a worker_loaders binding');
    this.loader = loader;
    this.compatibilityDate = compatibilityDate;
    this.timeoutMs = timeoutMs;
    this.caps = { ...DEFAULT_CAPS, ...caps };
  }

  /**
   * The binding either exists or it does not, and if it does it works — unlike the
   * in-process runner, there is no capability here that a runtime might withhold.
   * Constructing this class already refused a missing binding.
   */
  async probe() { return { ok: true }; }

  async run(spec, node, ctx) {
    // A presigned URL is the whole mechanism, so its absence is a hard error rather
    // than a degraded path. It fails LOUDLY and per-install-shaped: a backend that
    // cannot presign cannot host server indexers on Workers, and saying that is more
    // use than an empty contribution.
    if (typeof ctx.presignRead !== 'function') {
      throw TroveError.unsupported(
        `Indexer "${spec.id}" needs a presigned read URL to run in a sandbox, and this storage backend cannot mint one`,
      );
    }
    const url = await ctx.presignRead();

    const code = spec.files?.[spec.entry];
    if (!code) throw TroveError.invalid(`Indexer "${spec.id}" is missing its entry "${spec.entry}"`);

    // Keyed by cacheKey, which embeds the package DIGEST — so a reinstall at the same
    // version gets a different isolate rather than the old code kept warm. The loader
    // may reuse an isolate for a repeated id; that is exactly what we want within a
    // digest and exactly what we must not have across one.
    const stub = this.loader.get(spec.cacheKey || spec.id, async () => ({
      compatibilityDate: this.compatibilityDate,
      mainModule: 'shim.js',
      modules: {
        'shim.js': SHIM,
        'entry.js': new TextDecoder().decode(code),
      },
      // No bindings. The sandbox gets its instructions in the request body and its bytes
      // from one URL; there is nothing else for it to reach.
      env: {},
    }));

    const res = await withTimeout(
      stub.getEntrypoint().fetch('https://indexer.invalid/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          node: { id: node.id, name: node.name, contentType: node.contentType, size: node.size },
          url,
          maxBytes: ctx.maxBytes ?? 2 * 1024 * 1024,
          config: ctx.config || {},
          secrets: ctx.secrets || {},
        }),
      }),
      this.timeoutMs,
      `Indexer "${spec.id}" timed out after ${this.timeoutMs}ms`,
    );

    const body = await res.json().catch(() => ({ error: 'indexer returned a non-JSON response' }));
    if (!res.ok || body.error) throw TroveError.invalid(`Indexer "${spec.id}" failed: ${body.error || res.status}`);
    return clampContribution(body.contribution, this.caps);
  }
}

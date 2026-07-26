// IndexerRuntime — executes a server-side indexer sub-package against a node and
// returns a *clamped* contribution. It's the seam where untrusted plugin code runs,
// so it's pluggable: a deployment picks a runtime that matches its isolation needs.
//
//   InProcessIndexerRuntime  — imports the entry module and calls it directly. NO
//                              isolation; the indexer runs with the server's full
//                              authority. Only safe for TRUSTED code (first-party
//                              indexers, an admin-vetted package). It's the reference
//                              runtime and what tests use.
//
// Real isolation (a Node isolated-vm worker, a Bun worker_thread, a Cloudflare
// dynamic Worker loader) is a drop-in subclass that implements the same run() — see
// docs/design/server-plugins-and-indexers.md §5. Whatever the runtime, its output is
// funnelled through clampContribution() so a misbehaving indexer can't flood the
// index or the metadata store.

import { TroveError } from '../errors.js';
import { withTimeout } from '../retry.js';
// The contribution contract (shape + caps) lives with contributions, not with one of
// the runtimes that produce them. Clamping here bounds what crosses the isolate
// boundary into host memory; the indexing coordinator clamps again as the authority
// for what is actually stored.
import { clampContribution, DEFAULT_CAPS } from '../indexers/contribution.js';


export class IndexerRuntime {
  /**
   * Run an indexer sub-package against a node.
   * @param {{ id: string, entry: string, files: Record<string, Uint8Array>, cacheKey?: string }} spec
   * @param {object} node
   * @param {object} ctx  index context (readBytes/readText/presignRead/maxBytes/config/secrets)
   * @returns {Promise<object>} a clamped contribution
   */
  async run(spec, node, ctx) { throw TroveError.unsupported('IndexerRuntime.run'); }
  async close() {}
}

/**
 * Trusted, in-process runtime. Imports the entry module via a data: URL and invokes
 * its default (or named `index`) export as `index(node, ctx)`. The engine caches a
 * data: URL module, and we cache the import promise by cacheKey so re-runs are cheap.
 *
 * Limitations (accepted for the trusted reference runtime): the entry file must be
 * self-contained — relative `import` between sub-package files won't resolve through a
 * data: URL. Bundlers already collapse an indexer to one entry; multi-module loading
 * belongs to the isolate runtimes.
 */
export class InProcessIndexerRuntime extends IndexerRuntime {
  constructor({ timeoutMs = 10_000, caps = DEFAULT_CAPS } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.caps = { ...DEFAULT_CAPS, ...caps };
    this._mods = new Map(); // cacheKey -> Promise<indexFn>
  }

  #load(spec) {
    const key = spec.cacheKey || spec.id;
    let p = this._mods.get(key);
    if (!p) {
      const code = spec.files?.[spec.entry];
      if (!code) return Promise.reject(TroveError.invalid(`Indexer "${spec.id}" is missing its entry "${spec.entry}"`));
      // base64 data URL — percent-encoded JS confuses some runtimes' data: loader
      // (they fall back to a text module), whereas base64 imports reliably.
      const url = 'data:text/javascript;base64,' + bytesToBase64(code);
      p = import(/* @vite-ignore */ url).then((mod) => {
        const fn = mod.default || mod.index;
        if (typeof fn !== 'function') throw TroveError.invalid(`Indexer "${spec.id}" has no default/index export`);
        return fn;
      });
      this._mods.set(key, p);
    }
    return p;
  }

  async run(spec, node, ctx) {
    const fn = await this.#load(spec);
    const result = await withTimeout(
      Promise.resolve().then(() => fn(node, ctx)),
      this.timeoutMs,
      `Indexer "${spec.id}" timed out after ${this.timeoutMs}ms`,
    );
    return clampContribution(result, this.caps);
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}


/**
 * Bound an indexer's output to the caps. Never throws — a runaway or malformed
 * contribution is trimmed to something safe rather than rejected, so one bad chunk
 * doesn't sink the whole indexing pass.
 */


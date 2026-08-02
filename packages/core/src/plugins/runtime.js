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

  /**
   * Can this runtime actually execute an indexer HERE, on this deployment?
   *
   * Asked once, at install, because the alternative is what shipped: a runtime that
   * installs happily and then fails on every single file, silently, for the life of the
   * deployment. The in-process runner loads code by importing a `data:` URL — which
   * Node and Bun allow and **workerd does not** — so on Cloudflare every plugin indexer
   * failed with `No such module "data:text/javascript;base64,…"`, once per node, with
   * nothing to see at install time and nothing in the UI to explain the empty index.
   *
   * The design doc's provider matrix already called for this (§7, the `CF plain / none`
   * row: *"install-scope check refuses server-indexer plugins on this deployment, with a
   * clear message"*). It could not fire, because it keyed on the runtime being ABSENT
   * and the broken runtime is present — it just cannot run.
   *
   * Default true: a runtime that does not implement a probe is one that works.
   *
   * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
   */
  async probe() { return { ok: true }; }
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
      p = importModule(code).then((mod) => {
        const fn = mod.default || mod.index;
        if (typeof fn !== 'function') throw TroveError.invalid(`Indexer "${spec.id}" has no default/index export`);
        return fn;
      });
      this._mods.set(key, p);
    }
    return p;
  }

  /**
   * Try the loader itself, once, on a module that does nothing.
   *
   * The probe imports a real `data:` URL rather than sniffing for a runtime name.
   * Feature-detection over branding: workerd is the case that prompted this, but the
   * question is "does dynamic import of a data: URL work here", and only doing it
   * answers that. Cached — including the failure, which is a property of the runtime
   * and will not change while the process lives.
   */
  async probe() {
    // A REALISTICALLY SIZED module, not `export default 1`. The tiny version answered a
    // question nobody was asking: Bun imports a small data: URL happily and refuses one
    // over ~1.5 KB with ENAMETOOLONG, so a 12-byte probe passed and every real indexer —
    // the audiobook one is 34 KB — failed per file. That is the same silent shape this
    // probe exists to prevent, so it now loads something the size of a real entry.
    const padding = 'x'.repeat(PROBE_BYTES);
    const code = new TextEncoder().encode(`export default 1; //${padding}`);
    this._probe ||= importModule(code)
      .then(() => ({ ok: true }))
      .catch((err) => ({
        ok: false,
        reason: `this deployment's JavaScript runtime cannot load plugin code dynamically (${err?.message || err}). `
          + 'Server indexers need an isolate runtime — on Cloudflare, a Worker Loader binding.',
      }));
    return this._probe;
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

/**
 * How big a module the probe pretends to load. Larger than any plausible bundled indexer
 * entry (the audiobook one is 34 KB), because the failure being detected is a SIZE limit
 * and a probe under it proves nothing.
 */
export const PROBE_BYTES = 64 * 1024;

/**
 * Import a module from bytes, on whichever runtime this is.
 *
 * The two schemes are exactly complementary, which is why both are here:
 *
 *   data:   Node takes it at any size (2.6 MB tested). Bun refuses over ~1.5 KB with
 *           `NameTooLong` — it resolves the URL as a path, so ENAMETOOLONG.
 *   blob:   Bun takes it at any size. Node's ESM loader supports exactly `file:`, `data:`
 *           and `node:`, so it throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * data: first because it needs no cleanup and the same bytes give the same URL, so the
 * engine's module cache makes a re-import free. An object URL is a live registry entry
 * that leaks until revoked, which is the only reason it is the fallback rather than the
 * default.
 *
 * Neither works on workerd. That is what `WorkerLoaderIndexerRuntime` is for, and what
 * `probe()` reports when it is missing.
 */
async function importModule(code) {
  // base64 rather than percent-encoded: some runtimes' data: loader treats
  // percent-encoded JS as a text module instead of code.
  try {
    return await import(/* @vite-ignore */ 'data:text/javascript;base64,' + bytesToBase64(code));
  } catch (dataErr) {
    if (typeof URL.createObjectURL !== 'function' || typeof Blob !== 'function') throw dataErr;
    let url;
    try {
      url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    } catch {
      throw dataErr; // report the data: failure — it is the one that describes the runtime
    }
    try {
      return await import(/* @vite-ignore */ url);
    } catch {
      throw dataErr;
    } finally {
      // Safe here and only here: an ESM module is fully instantiated by the time the
      // import resolves, and `#load` caches the promise so this URL is never resolved
      // again. Without it every indexer would pin its own source in memory for the life
      // of the process.
      URL.revokeObjectURL?.(url);
    }
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


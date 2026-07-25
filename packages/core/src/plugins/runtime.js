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

/** Output caps applied to every indexer contribution regardless of runtime. */
export const DEFAULT_CAPS = {
  maxSemanticTexts: 500, // number of chunks
  maxTextChars: 100_000, // per chunk
  maxSemanticChars: 2_000_000, // total across chunks
  maxTags: 100, // number of tag entries
  maxTagKeyChars: 128,
  maxTagValueChars: 2_048,
  maxMetadataBytes: 256 * 1024, // JSON-serialized metadata
};

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
export function clampContribution(raw, caps = DEFAULT_CAPS) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};

  const texts = src.semanticTexts || src.documents;
  if (Array.isArray(texts)) {
    const docs = [];
    let budget = c.maxSemanticChars;
    for (const d of texts) {
      if (docs.length >= c.maxSemanticTexts || budget <= 0) break;
      const text = typeof d === 'string' ? d : (d && typeof d.text === 'string' ? d.text : null);
      if (!text) continue;
      const clipped = text.length > c.maxTextChars ? text.slice(0, c.maxTextChars) : text;
      const room = Math.min(clipped.length, budget);
      const finalText = room < clipped.length ? clipped.slice(0, room) : clipped;
      budget -= finalText.length;
      const doc = typeof d === 'string' ? { text: finalText } : { ...d, text: finalText };
      if (doc.fields && typeof doc.fields !== 'object') delete doc.fields;
      docs.push(doc);
    }
    if (docs.length) out.semanticTexts = docs;
  }

  const tags = src.tags;
  if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
    const clean = {};
    let n = 0;
    for (const [k, v] of Object.entries(tags)) {
      if (n >= c.maxTags) break;
      if (typeof k !== 'string' || k.length > c.maxTagKeyChars) continue;
      const cv = clampTagValue(v, c.maxTagValueChars);
      if (cv === undefined) continue;
      clean[k] = cv;
      n++;
    }
    if (n) out.tags = clean;
  }

  const metadata = src.metadata || src.facet;
  if (metadata && typeof metadata === 'object') {
    try {
      const json = JSON.stringify(metadata);
      if (json && json.length <= c.maxMetadataBytes) out.metadata = JSON.parse(json);
    } catch { /* non-serializable metadata is dropped */ }
  }

  return out;
}

function clampTagValue(v, maxChars) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > maxChars ? v.slice(0, maxChars) : v;
  return undefined; // objects/arrays/null aren't filterable tag values
}

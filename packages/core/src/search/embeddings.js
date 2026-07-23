// EmbeddingProvider — turns text into vectors. Pluggable so deployments choose
// their model/cost tradeoff. Two are bundled:
//   - LocalHashEmbedding: zero-dependency, offline, deterministic. A hashed
//     bag-of-bigrams projected to a fixed dim and L2-normalised. Not as good as
//     a real model, but makes semantic search work out of the box and in tests.
//   - HttpEmbedding: POSTs to any OpenAI-compatible /embeddings endpoint (OpenAI,
//     Ollama, LM Studio, a self-hosted model). This is the production path.
// Both expose `dimensions` and `embed(texts) -> number[][]`.

import { withRetry } from '../retry.js';
import { TroveError, wrapError } from '../errors.js';

export class EmbeddingProvider {
  get dimensions() {
    return 0;
  }
  /** @param {string[]} texts @returns {Promise<number[][]>} */
  async embed(texts) {
    throw TroveError.unsupported('embed not implemented');
  }
  async embedOne(text) {
    return (await this.embed([text]))[0];
  }
}

const STOP = new Set('a an the of to in on for and or is are be as at by with from this that it'.split(' '));

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// FNV-1a → 32-bit, used to bucket features into vector dims.
function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class LocalHashEmbedding extends EmbeddingProvider {
  constructor({ dimensions = 256 } = {}) {
    super();
    this._dim = dimensions;
  }
  get dimensions() {
    return this._dim;
  }
  async embed(texts) {
    return texts.map((t) => this.#vec(t));
  }
  #vec(text) {
    const v = new Float64Array(this._dim);
    const tokens = tokenize(text);
    // Unigrams + bigrams give a little word-order sensitivity.
    const feats = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) feats.push(tokens[i] + '_' + tokens[i + 1]);
    for (const f of feats) {
      const h = fnv(f);
      const idx = h % this._dim;
      const sign = (h >> 31) & 1 ? -1 : 1; // signed hashing reduces collisions
      v[idx] += sign;
    }
    // L2 normalise so dot product == cosine similarity.
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
  }
}

export class HttpEmbedding extends EmbeddingProvider {
  /**
   * @param {object} cfg
   * @param {string} cfg.url        e.g. https://api.openai.com/v1/embeddings
   * @param {string} [cfg.apiKey]
   * @param {string} [cfg.model]    e.g. text-embedding-3-small
   * @param {number} cfg.dimensions the model's output dim (must match your index)
   * @param {number} [cfg.batchSize]
   */
  constructor(cfg) {
    super();
    if (!cfg?.url || !cfg?.dimensions) throw TroveError.invalid('HttpEmbedding requires url and dimensions');
    this.cfg = cfg;
  }
  get dimensions() {
    return this.cfg.dimensions;
  }
  async embed(texts) {
    const batchSize = this.cfg.batchSize ?? 64;
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      out.push(...(await this.#embedBatch(batch)));
    }
    return out;
  }
  async #embedBatch(batch) {
    return withRetry(async () => {
      let res;
      try {
        res = await fetch(this.cfg.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.cfg.model, input: batch }),
        });
      } catch (err) {
        throw wrapError(err);
      }
      if (res.status === 429 || res.status >= 500) {
        throw TroveError.transient(`Embedding endpoint ${res.status}`);
      }
      if (!res.ok) throw TroveError.internal(`Embedding endpoint failed: ${res.status}`);
      const json = await res.json();
      // OpenAI shape: { data: [{ embedding: [...] }, ...] }
      const data = json.data ?? json.embeddings ?? [];
      return data.map((d) => d.embedding ?? d);
    });
  }
}

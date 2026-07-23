// IndexerRegistry — server-side indexers that extract searchable content from
// files. An indexer declares which nodes it handles and, for each, produces
// documents (text chunks + fields) and an optional facet (namespaced metadata
// written back onto the node). Everything an indexer writes is namespaced under
// its `id`, so indexers never clobber one another.
//
// This complements *plugin* indexers, which run in the browser sandbox and push
// their documents through the API under their own namespace — same document
// shape, same namespacing guarantee, different execution location.
//
// A built-in text/markdown extractor is included as the reference indexer.

import { extname } from '../util.js';

/**
 * @typedef {object} Indexer
 * @property {string} id                 unique namespace
 * @property {string} [displayName]
 * @property {(node: object) => boolean} match
 * @property {(node: object, ctx: IndexContext) => Promise<{documents?: Doc[], facet?: object}>} index
 *
 * @typedef {object} Doc
 * @property {string} [id]   stable per (node, chunk); defaults to `${node.id}:${i}`
 * @property {string} text
 * @property {object} [fields]  e.g. { title, page, chapter }
 *
 * @typedef {object} IndexContext
 * @property {() => Promise<Uint8Array>} readBytes
 * @property {() => Promise<string>} readText
 * @property {number} maxBytes
 */

export class IndexerRegistry {
  constructor() {
    this.indexers = new Map();
  }
  register(indexer) {
    if (!indexer?.id || typeof indexer.index !== 'function') {
      throw new Error('Indexer requires an id and an index() function');
    }
    this.indexers.set(indexer.id, indexer);
    return () => this.indexers.delete(indexer.id);
  }
  unregister(id) {
    this.indexers.delete(id);
  }
  list() {
    return [...this.indexers.values()].map((i) => ({ id: i.id, displayName: i.displayName || i.id }));
  }
  matching(node) {
    return [...this.indexers.values()].filter((i) => {
      try {
        return i.match(node);
      } catch {
        return false;
      }
    });
  }
}

// --- Reference indexer: plain text / markdown / code ------------------------

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.js', '.mjs', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.css', '.html', '.xml', '.sh',
]);

export const textIndexer = {
  id: 'core.text',
  displayName: 'Text & code',
  match(node) {
    if (node.kind !== 'file') return false;
    if (node.contentType?.startsWith('text/')) return true;
    return TEXT_EXTS.has(extname(node.name));
  },
  async index(node, ctx) {
    const text = await ctx.readText();
    if (!text.trim()) return { documents: [] };
    const chunks = chunkText(text, 1200, 200);
    const documents = chunks.map((chunk, i) => ({
      id: `${node.id}:${i}`,
      text: chunk,
      fields: { name: node.name, path: node.path, chunk: i },
    }));
    return {
      documents,
      facet: { chars: text.length, chunks: chunks.length, excerpt: text.slice(0, 280) },
    };
  },
};

/** Split into overlapping windows on sentence/line boundaries where possible. */
export function chunkText(text, size, overlap) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      // Prefer to break at a paragraph/sentence boundary within the last 25%.
      const window = text.slice(i, end);
      const brk = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (brk > size * 0.75) end = i + brk + 1;
    }
    out.push(text.slice(i, end).trim());
    if (end >= text.length) break;
    i = end - overlap;
  }
  return out.filter(Boolean);
}

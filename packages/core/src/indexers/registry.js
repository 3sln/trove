// IndexerRegistry — server-side indexers that extract structured content from
// files. An indexer declares which nodes it handles and, for each, produces a
// *contribution* with up to three scopes:
//   - semanticTexts: text chunks that become embeddings + keyword entries (search)
//   - tags:          filterable key/values (merged into the node's queryable tags)
//   - metadata:      arbitrary structured data (e.g. an audiobook's chapter index)
// Everything is namespaced under the indexer's `id`, so indexers never clobber one
// another and an indexer's whole contribution can be removed independently.
//
// This complements *plugin* indexers, which run in the browser sandbox and push
// the same contribution shape through the API under their own namespace.
//
// Two built-ins ship here: a text/markdown extractor (the reference indexer) and a
// links extractor, which is what makes a drive with no folders navigable.

import { extname } from '../util.js';
import { extractTroveLinks } from '../links.js';
import { LINKS_CONTRIBUTOR, LINKS_KEY } from '../metadata/interface.js';

/**
 * @typedef {object} Indexer
 * @property {string} id                 unique namespace
 * @property {string} [displayName]
 * @property {(node: object) => boolean} match
 * @property {(node: object, ctx: IndexContext) => Promise<Contribution>} index
 *
 * @typedef {object} Contribution
 * @property {Doc[]} [semanticTexts]  text chunks → embeddings + keyword search
 * @property {object} [tags]          filterable key/values, e.g. { language: 'en' }
 * @property {object} [metadata]      arbitrary structured data, e.g. { chapters: [...] }
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
  /** @param {{builtins?: boolean}} [opts] register the reference text indexer (default on) */
  constructor({ builtins = true } = {}) {
    this.indexers = new Map();
    if (builtins) {
      this.register(textIndexer);
      this.register(linksIndexer);
    }
  }
  register(indexer) {
    if (!indexer?.id || typeof indexer.index !== 'function') {
      throw new Error('Indexer requires an id and an index() function');
    }
    this.indexers.set(indexer.id, indexer);
    // Only unregister if THIS registration is still the live one. Indexer ids are
    // contribution URIs, which are account-independent, so a second account installing
    // the same package replaces the first's entry — and the first's stale closure then
    // deleted the second's, taking that account's indexer out of the drive-wide registry
    // and purging its contributions.
    return () => { if (this.indexers.get(indexer.id) === indexer) this.indexers.delete(indexer.id); };
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

function isTexty(node) {
  if (node.contentType?.startsWith('text/')) return true;
  return TEXT_EXTS.has(extname(node.name));
}

export const textIndexer = {
  id: 'core.text',
  displayName: 'Text & code',
  match: isTexty,
  async index(node, ctx) {
    const text = await ctx.readText();
    if (!text.trim()) return { semanticTexts: [] };
    const chunks = chunkText(text, 1200, 200);
    // Fields describe the CHUNK (which chunk it is), not the node. The node's name
    // deliberately isn't copied in: field values are indexed, so a name duplicated
    // across every chunk goes stale the moment the item is renamed — leaving the file
    // findable under a name it no longer has. Name search belongs to the `core.name`
    // index, which is a single document and is refreshed on rename.
    const semanticTexts = chunks.map((chunk, i) => ({
      id: `${node.id}:${i}`,
      text: chunk,
      fields: { chunk: i },
    }));
    return {
      semanticTexts,
      metadata: { chars: text.length, chunks: chunks.length, excerpt: text.slice(0, 280) },
    };
  },
};

// --- Links indexer: what this item points at --------------------------------
//
// With no folder hierarchy, an item's place in the drive is defined by what links to
// it. This indexer records the outbound `trove:` URIs found in an item's text, which
// is what MetadataStore.findLinksTo reads to answer the inverse question — "what
// gathers this up?" — for the backlinks panel.
//
// It stores the links as `metadata`, not `semanticTexts`: a URI is an edge, not prose,
// and embedding it would only pollute semantic results. `links` is also surfaced as a
// tag count so `#links > 0` finds the documents that act as indexes.

export const linksIndexer = {
  id: LINKS_CONTRIBUTOR,
  displayName: 'Links',
  match: isTexty,
  async index(node, ctx) {
    const text = await ctx.readText();
    const links = extractTroveLinks(text).map((l) => l.uri);
    return {
      metadata: { [LINKS_KEY]: links },
      tags: { links: links.length },
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

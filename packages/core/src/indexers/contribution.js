// What a *contribution* is, and how big it may be.
//
// A contribution is the one shape everything that enriches an item produces — the
// built-in indexers, a plugin's server indexer running in the isolate, and a sandboxed
// plugin pushing through the API. It has up to three scopes:
//
//   semanticTexts  text chunks → embeddings + keyword search
//   tags           filterable key/values, merged into the item's queryable tags
//   metadata       arbitrary structured data (an audiobook's chapter index, …)
//
// TWO SENSES OF "CONTRIBUTION", and this is the other one. Here it is per-node ENRICHMENT
// produced at runtime and addressed by `contributorId`. The first sense lives in
// core/src/plugins/contributions.js: an EXTENSION POINT declared in a manifest and
// addressed by URI. A plugin declares an `indexer` contribution (that sense) which at
// runtime produces contributions (this one).
//
// The rule: that sense is DECLARED, static, and named by URI; this one is PRODUCED, per
// node, and named by contributor.
//
// `clampContribution` does the whole contract in one pass: it accepts the legacy
// `{ documents, facet }` spelling, decides the canonical shape, and applies the caps. It
// was two functions, and the second — `normalizeContribution` — had grown its own copy of
// the legacy mapping, so both halves of a contract that exists here BECAUSE it must not
// drift had drifted into both. At its only call site it could never see a legacy key,
// because clamp had already mapped it; all it contributed was three defaults.
//
// The caps used to live in the plugin isolate runtime, which meant they applied to one of
// the three producers. They are a property of the contribution, not of whoever made it.

/** Output caps applied to every contribution, whatever produced it. */
export const DEFAULT_CAPS = {
  maxSemanticTexts: 500, // number of chunks
  maxTextChars: 100_000, // per chunk
  maxSemanticChars: 2_000_000, // total across chunks
  maxTags: 100, // number of tag entries
  maxTagKeyChars: 128,
  maxTagValueChars: 2_048,
  maxMetadataBytes: 256 * 1024, // JSON-serialized metadata
};

/**
 * Clamp a contribution to `caps`, dropping (not erroring on) whatever exceeds them.
 *
 * Truncating rather than rejecting is deliberate: the input is a *derived* artifact of
 * a file someone uploaded, so an oversized contribution usually means an unusual file
 * rather than an attack, and losing the tail of an index is much better than losing the
 * item's indexing entirely. What it must never do is let the size of one item's
 * contribution be chosen by whoever wrote the file.
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
      // BYTES, as the cap's name says. `json.length` counts UTF-16 code units, so
      // non-ASCII metadata could run to roughly three times the advertised limit.
      if (json && new TextEncoder().encode(json).length <= c.maxMetadataBytes) {
        out.metadata = JSON.parse(json);
      }
    } catch { /* non-serializable metadata is dropped */ }
  }

  return out;
}

/**
 * A tag value must be a filterable scalar. Objects and arrays are dropped — they can't
 * be compared by a `#key:>=value` filter, so storing them would only bloat the row.
 * `null` survives: it is the documented "this tag is removed" sentinel that
 * mergeContributionTags reads, so clamping it away would make a contribution unable to
 * retract a tag it previously set.
 */
export function clampTagValue(v, maxChars) {
  if (typeof v === 'string') return v.length > maxChars ? v.slice(0, maxChars) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined; // NaN/∞ don't compare
  if (typeof v === 'boolean' || v === null) return v;
  return undefined;
}

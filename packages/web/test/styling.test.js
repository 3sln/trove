// `$styling` keys are CSS property names, not JS identifiers.
//
// dodo writes them into the style attribute verbatim, so `{ marginTop: '10px' }` becomes
// `style="marginTop: 10px"` — which the CSS parser discards. No error, no warning, no
// console noise: the declaration simply does nothing, and it looks exactly like code
// that works. Thirty-four of them had accumulated across the workbench, which is how a
// details panel ends up with a button flush against the line above it.
//
// A source scan is the only place to catch this. There is no runtime moment where the
// mistake is visible — by the time the DOM has it, the information is gone.

import { test, expect } from './testkit.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Every `$styling: { … }` object in the tree, with its file and the keys it declares. */
function stylingBlocks() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      let i = 0;
      for (;;) {
        const start = src.indexOf('$styling: {', i);
        if (start === -1) break;
        let depth = 0;
        let end = src.indexOf('{', start);
        for (; end < src.length; end++) {
          if (src[end] === '{') depth++;
          else if (src[end] === '}' && --depth === 0) break;
        }
        out.push({ file: path.relative(SRC, p), block: src.slice(start, end + 1) });
        i = end + 1;
      }
    }
  };
  walk(SRC);
  return out;
}

test('no $styling key is written in camelCase', () => {
  const blocks = stylingBlocks();
  expect(blocks.length).toBeGreaterThan(10); // the scan found the source, not an empty tree

  // A bare (unquoted) identifier key with an interior capital. Quoted kebab keys and
  // string VALUES like 'var(--text-dim)' are untouched.
  const camelKey = /(?<![\w'"-])([a-z]+(?:[A-Z][a-zA-Z0-9]*)+)\s*:/g;
  const offenders = [];
  for (const { file, block } of blocks) {
    for (const m of block.matchAll(camelKey)) offenders.push(`${file}: ${m[1]}`);
  }
  expect(offenders).toEqual([]);
});

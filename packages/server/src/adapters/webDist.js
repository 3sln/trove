// Where the built web app is.
//
// This used to be one line in each of the Node and Bun adapters:
//
//   path.resolve(__dirname, '../../../web/dist')
//
// which is a guess about the shape of the tree three levels above the file doing the
// guessing. Inside this repo it lands on `packages/web/dist` and is right. Installed as
// a package it lands on `node_modules/@trove/web/dist` and is *also* right — but by
// coincidence, not because anything arranged it: it holds only while `@trove/server`
// and `@trove/web` are siblings under the same `@trove/` directory, which is a fact
// about a particular installer's layout rather than anything either package promises.
// Nest the install, vendor one of them, or hoist differently and the drive silently
// serves no web app, with a 404 on `/` as the only clue.
//
// Module resolution answers the same question without guessing, and answers it in both
// worlds at once — in a workspace `node_modules/@trove/web` is a symlink to
// `packages/web`, so the resolver finds the same directory the relative path did.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Locate the built web assets, or null when the app has not been built.
 *
 * Order matters: an explicit setting is never second-guessed, and if it points
 * somewhere empty that is reported rather than quietly worked around — an operator who
 * set TROVE_WEB_DIST wants to know it was wrong, not to be silently given a different
 * directory that happened to exist.
 *
 * @param {string} [envDist] the value of TROVE_WEB_DIST
 * @returns {{dir: string|null, source: string}} where it looked and how it decided
 */
export function findWebDist(envDist = process.env.TROVE_WEB_DIST) {
  if (envDist) {
    const dir = path.resolve(envDist);
    return existsSync(dir)
      ? { dir, source: 'TROVE_WEB_DIST' }
      : { dir: null, source: `TROVE_WEB_DIST=${envDist} (no such directory)` };
  }

  // The package, wherever the resolver says it is. `@trove/web` declares no `exports`,
  // so a deep path to its manifest resolves; if that ever changes this throws and we
  // fall through, which is why it is wrapped rather than trusted.
  try {
    const require = createRequire(import.meta.url);
    const dir = path.join(path.dirname(require.resolve('@trove/web/package.json')), 'dist');
    if (existsSync(dir)) return { dir, source: '@trove/web' };
  } catch { /* not installed, or not resolvable from here */ }

  // Last resort, and the only one that works when this file has been copied out of a
  // package tree entirely — a vendored checkout, a bundler that flattened everything.
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  if (existsSync(dir)) return { dir, source: 'relative to this file' };

  return { dir: null, source: 'not built' };
}

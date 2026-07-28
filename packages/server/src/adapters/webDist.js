// Where the built web app is.
//
// This was once a guess about the shape of the tree three levels above the file doing
// the guessing:
//
//   path.resolve(__dirname, '../../../web/dist')
//
// It was right inside the repo and right again when installed, but only while
// `@trove/server` and `@trove/web` happened to land as siblings under one `@trove/`
// directory — a fact about a particular installer's layout rather than anything either
// package promised. Nest the install, vendor one of them, or hoist differently and the
// drive silently served no web app, with a 404 on `/` as the only clue.
//
// Trove now ships as a single package with the built app inside it, which retires the
// problem rather than working around it: server and web are no longer two things an
// installer arranges relative to each other, they are two directories in one tarball,
// and their arrangement is fixed by the package that contains both. So the relative
// path below is no longer a guess — it is the layout this package's own `files` field
// guarantees.
//
// Resolution is still tried first, because it is the one that keeps working when this
// file is *not* where it thinks it is: a bundler that flattened the tree, or a copy
// vendored somewhere else. The two answers agree whenever both are available, and each
// covers the other's failure mode.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const WEB_DIST_IN_PACKAGE = 'packages/web/dist';

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

  // The package root, wherever the resolver says it is. A package can reference itself
  // by name, so this resolves both from a checkout and from inside `node_modules` —
  // and it reaches the manifest because `./package.json` is one of the subpaths
  // `exports` names. If that ever stops being true this throws rather than returning
  // something wrong, which is why it is wrapped.
  try {
    const require = createRequire(import.meta.url);
    const root = path.dirname(require.resolve('@3sln/trove/package.json'));
    const dir = path.join(root, WEB_DIST_IN_PACKAGE);
    if (existsSync(dir)) return { dir, source: '@3sln/trove' };
  } catch { /* not resolvable from here — fall through to the layout we ship */ }

  // Four levels up from packages/server/src/adapters/ is the package root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '../../../..', WEB_DIST_IN_PACKAGE);
  if (existsSync(dir)) return { dir, source: 'relative to this file' };

  return { dir: null, source: 'not built' };
}

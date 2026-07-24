// A @web/dev-server / @web/test-runner plugin that makes
//   import SRC from './thing.js' with { type: 'text' }
// work in a browser. Browsers only implement `type: 'json'` (and css), so an
// unbundled dev server can't hand the attribute straight to the browser — the
// module would be rejected. bun build and esbuild >=0.25 inline text imports
// natively for the bundled prod/test paths; this plugin covers the *unbundled*
// dev path the same way Vite's `?raw` did.
//
// It rewrites each `... with { type: 'text' }` import to a normal import of a
// synthetic `/__trove_text/<abs-path>` URL (attribute stripped, so the browser is
// happy), and serves that URL as `export default "<file source>"`.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PREFIX = '/__trove_text/';
// import <binding> from '<spec>' with { type: 'text' }
const TEXT_IMPORT = /import\s+([\w$]+)\s+from\s*(['"])([^'"]+)\2\s*with\s*\{\s*type\s*:\s*(['"])text\4\s*\}\s*;?/g;

function encode(absPath) {
  return PREFIX + encodeURIComponent(absPath);
}
function decode(urlPath) {
  return decodeURIComponent(urlPath.slice(PREFIX.length));
}

export function textModulePlugin({ rootDir } = {}) {
  const root = rootDir || process.cwd();
  return {
    name: 'trove-text-module',

    // Serve the synthetic text modules.
    serve(context) {
      if (!context.path.startsWith(PREFIX)) return;
      const abs = decode(context.path);
      const source = readFileSync(abs, 'utf8');
      return { body: `export default ${JSON.stringify(source)};`, type: 'js' };
    },

    // Rewrite `with { type: 'text' }` imports in every served JS module.
    transform(context) {
      const type = context.response.is('js');
      if (!type) return;
      const body = typeof context.body === 'string' ? context.body : null;
      if (!body || !body.includes("type: 'text'") && !body.includes('type: "text"')) return;

      const importerAbs = path.join(root, context.path.split('?')[0]);
      const require = createRequire(importerAbs);
      const rewritten = body.replace(TEXT_IMPORT, (_m, binding, _q, spec) => {
        const abs = require.resolve(spec);
        return `import ${binding} from ${JSON.stringify(encode(abs))};`;
      });
      if (rewritten !== body) return { body: rewritten };
    },
  };
}

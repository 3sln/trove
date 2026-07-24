// Serve sql.js's wasm at /sql-wasm.wasm for the dev server and test runner (the
// production build copies it into dist/ instead). The client-side plugin store
// loads it lazily from that URL.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function sqlWasmMiddleware() {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  return async (ctx, next) => {
    if (ctx.path !== '/sql-wasm.wasm') return next();
    ctx.type = 'application/wasm';
    ctx.body = await readFile(wasmPath);
  };
}

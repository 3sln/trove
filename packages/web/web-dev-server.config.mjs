// Dev server (replaces `vite`): serves the app as unbundled native ESM with HMR,
// resolves bare specifiers from node_modules, proxies /api to the Trove backend so
// the SPA and API share an origin (matching production), and inlines
// `with { type: 'text' }` imports via the shared text-module plugin.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { textModulePlugin } from './tooling/textModulePlugin.mjs';
import { sqlWasmMiddleware } from './tooling/sqlWasmMiddleware.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const API_TARGET = process.env.TROVE_API || 'http://localhost:8787';

export default {
  rootDir,
  port: Number(process.env.PORT) || 5173,
  nodeResolve: true,
  appIndex: 'index.html', // SPA fallback for client-side routes
  watch: true,
  plugins: [textModulePlugin({ rootDir })],
  middleware: [
    sqlWasmMiddleware(),
    // Minimal proxy to the backend (dev only; prod serves both from one origin).
    //
    // The manifest goes through too, even though it is not under /api: it is generated
    // from the operator's configuration rather than served from a file, so there is
    // nothing in public/ for the dev server to hand back. Proxying it is what keeps one
    // document rather than a static development copy that drifts from the real one.
    async (ctx, next) => {
      if (!ctx.path.startsWith('/api') && ctx.path !== '/manifest.webmanifest') return next();
      const hasBody = ctx.method !== 'GET' && ctx.method !== 'HEAD';
      const res = await fetch(API_TARGET + ctx.url, {
        method: ctx.method,
        headers: { ...ctx.headers, host: undefined },
        body: hasBody ? ctx.req : undefined,
        duplex: 'half',
        redirect: 'manual',
      });
      ctx.status = res.status;
      res.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'content-length') ctx.set(k, v); });
      ctx.body = Buffer.from(await res.arrayBuffer());
    },
  ],
};

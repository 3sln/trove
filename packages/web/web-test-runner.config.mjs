// Browser test runner (@web/test-runner): runs the web package's browser-targeted
// unit suites in real Chromium — so signing (Web Crypto), the ESM module graph
// (es-module-lexer/wasm), and zip handling are exercised on the actual platform
// they ship to. The same files also run under `bun test` via test/testkit.js.
//
// Node-level suites (core/server/plugin-sdk) stay on `bun test` — they exercise
// Node adapters/sqlite, not the browser.

import { chromeLauncher } from '@web/test-runner-chrome';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { textModulePlugin } from './tooling/textModulePlugin.mjs';
import { sqlWasmMiddleware } from './tooling/sqlWasmMiddleware.mjs';
import { resolveChromium } from './tooling/chromium.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  rootDir,
  // sanitize.browser.js is browser-ONLY (it parses into a real inert <template>),
  // which is why it isn't named *.test.js — `bun test` must not pick it up.
  // boot.browser.js is the breadth check: it assembles the real platform, builds the real
  // engine and renders the real shell. Every other suite here tests something in isolation,
  // which is exactly how four ReferenceErrors reached a browser past a green `bun test` and
  // a clean build.
  // ABSOLUTE, via rootDir. `files` globs resolve against the working directory, not
  // against the config — so `web-test-runner --config packages/web/…` from the repo root,
  // which is exactly what `npm run test:browser` does, matched nothing and reported "Could
  // not find any test files" rather than a failure anyone would chase.
  files: [
    'test/plugins.test.js', 'test/contributions.test.js', 'test/views.test.js',
    'test/sanitize.browser.js', 'test/markdown.browser.js', 'test/boot.browser.js',
  ].map((f) => path.join(rootDir, f)),
  nodeResolve: true,
  middleware: [sqlWasmMiddleware()],
  plugins: [textModulePlugin({ rootDir })],
  browsers: [
    chromeLauncher({
      launchOptions: {
        // Resolved rather than hardcoded — see tooling/chromium.mjs. It was one CI image's
        // path, so everywhere else these suites refused to launch instead of running.
        executablePath: resolveChromium(),
        // For a container running as root, where Chrome's own sandbox cannot start. Inert
        // on a developer's machine, and these suites load only local files.
        args: ['--no-sandbox'],
      },
    }),
  ],
  testFramework: { config: { timeout: '10000' } },
};

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

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  rootDir,
  // sanitize.browser.js is browser-ONLY (it parses into a real inert <template>),
  // which is why it isn't named *.test.js — `bun test` must not pick it up.
  files: ['test/plugins.test.js', 'test/mp4.test.js', 'test/contributions.test.js', 'test/sanitize.browser.js', 'test/markdown.browser.js'],
  nodeResolve: true,
  middleware: [sqlWasmMiddleware()],
  plugins: [textModulePlugin({ rootDir })],
  browsers: [
    chromeLauncher({
      launchOptions: {
        executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        args: ['--no-sandbox'],
      },
    }),
  ],
  testFramework: { config: { timeout: '10000' } },
};

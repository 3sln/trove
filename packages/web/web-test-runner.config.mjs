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

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default {
  rootDir,
  files: ['test/plugins.test.js', 'test/mp4.test.js'],
  nodeResolve: true,
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

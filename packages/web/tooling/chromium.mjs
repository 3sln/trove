// Finding a Chromium to run the browser suites in.
//
// This existed as one hardcoded string — `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
// — which is a path inside one CI image. Everywhere else that file does not exist, so the
// suites did not fail, they refused to launch: "Browser was not found at the configured
// executablePath". A test that cannot start on a developer's machine is a test that only
// CI reads, and these are the ones that catch what `bun test` structurally cannot — real
// Web Crypto, the real ESM graph, and `boot.browser.js`, which assembles the whole shell.
//
// So: ask in order, take the first that exists, and say what was tried if none do.

import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

/** Where Playwright puts what it downloads, per platform. */
function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = homedir();
  if (platform() === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform() === 'win32') return path.join(home, 'AppData', 'Local', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/**
 * Any chromium build Playwright has already downloaded.
 *
 * Scanned rather than asked for by name, because `playwright-core`'s own
 * `chromium.executablePath()` answers with the build IT was published against — which is
 * routinely not the build sitting in the cache, and it answers with that path whether or
 * not anything is there. A directory listing cannot be wrong about what exists.
 */
function fromPlaywrightCache() {
  const root = playwrightCache();
  if (!existsSync(root)) return null;
  const builds = readdirSync(root)
    .filter((d) => d.startsWith('chromium-'))
    // Highest build number first: the newest one is the one a recent Playwright installed.
    .sort((a, b) => Number(b.split('-')[1] || 0) - Number(a.split('-')[1] || 0));
  const suffixes = [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-linux', 'chrome'],
    ['chrome-win', 'chrome.exe'],
  ];
  for (const build of builds) {
    for (const parts of suffixes) {
      const p = path.join(root, build, ...parts);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** A Chrome the person already has. Last resort, and fine — these suites are not pixel tests. */
function systemChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }[platform()] || [];
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * @returns {string|undefined} an executable path, or undefined to let the launcher look
 *   for itself — which is the right answer when we have nothing better, rather than
 *   handing it a path we know is wrong.
 */
export function resolveChromium() {
  // Explicit wins, and stays unchecked: an operator naming a path is telling us something
  // we cannot verify better than they can, and a CI image pins its browser this way.
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const found = fromPlaywrightCache() || systemChrome();
  if (found) return found;
  console.warn(
    '[trove] No Chromium found for the browser suites — tried CHROMIUM_PATH, the Playwright '
    + `cache (${playwrightCache()}), and the usual system paths. Letting the launcher try. `
    + 'Install one with `npx playwright install chromium`, or set CHROMIUM_PATH.',
  );
  return undefined;
}

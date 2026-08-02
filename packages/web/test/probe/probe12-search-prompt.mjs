// Probe: the search box says what THIS deployment's search actually accepts.
//
// The failure being guarded against is a quiet one. A client that hardcodes
// "# filter by tag" keeps looking fine after someone configures a different
// transformer — it just instructs everyone to type a grammar the server no longer
// parses. They type it, get nothing back, and learn that search doesn't work.
//
// So: the prompt comes from the server, it changes when the transformer changes, and
// the syntax help appears at the one moment it is useful (a search that found nothing)
// rather than sitting permanently above an empty drive.

import { boot, checker } from './harness.mjs';
import { SearchTransformer } from '../../../core/src/search/transformer.js';

const { check, done } = checker();

// A transformer with its own grammar, standing in for anything a deployment might plug
// in. It answers describe() differently, which is the entire contract under test.
class ColonTransformer extends SearchTransformer {
  async transform(raw) {
    return { semanticText: String(raw || '').replace(/\bfind:/g, '').trim(), tagFilters: [], source: 'colon' };
  }
  describe() {
    return {
      placeholder: 'find: something',
      short: 'find:',
      hint: 'This drive uses find: prefixes rather than hashes.',
      examples: [{ query: 'find: sailing', label: 'the house grammar' }],
    };
  }
}

const seed = async (vfs) => {
  await vfs.writeFile('sailing.txt', 'a note about sailing', { contentType: 'text/plain' });
};

// --- 1. The default deployment ------------------------------------------------
let h = await boot({ seed });
await h.goto();
await h.page.waitForSelector('.launch-item', { timeout: 5000 });

const placeholder = () => h.page.getAttribute('.launch-input', 'placeholder');
const count = (sel) => h.page.locator(sel).count();

const def = await placeholder();
check('the default box advertises the #tag grammar it really parses', /#/.test(def), def);
check('and it comes from the server, not the bundle',
  await h.page.evaluate(() => !!window.__trove.platform.capabilities?.searchPrompt), def);

// --- 2. Help appears only when a search found nothing --------------------------
check('no syntax help above an untouched drive', (await count('.launch-help')) === 0);

await h.page.fill('.launch-input', 'sailing');
await h.page.waitForFunction(() => window.__trove.app.search.get().ran, null, { timeout: 5000 });
await h.page.waitForTimeout(200);
check('a search that FOUND something gets results, not a lecture',
  (await count('.launch-item')) > 0 && (await count('.launch-help')) === 0);

// A tag nothing carries is the reliable way to get a genuinely empty result — semantic
// search returns the nearest thing to any query, so "gibberish" still matches something.
await h.page.fill('.launch-input', '#zzznosuchtag');
await h.page.waitForFunction(
  () => window.__trove.app.search.get().ran && !window.__trove.app.search.get().loading
    && window.__trove.app.search.get().results.length === 0,
  null, { timeout: 6000 });
await h.page.waitForTimeout(200);
check('a search that found NOTHING explains the syntax', (await count('.launch-help')) === 1);
const helpText = await h.page.locator('.launch-help').innerText();
check('and the explanation is the server\'s, matching the grammar in the box',
  /#tag|#key/.test(helpText), helpText.replace(/\n/g, ' | '));

// The examples are offered as one-click searches — reading syntax is worse than
// running it.
const before = await h.page.inputValue('.launch-input');
await h.page.click('.lh-example');
await h.page.waitForTimeout(300);
const after = await h.page.inputValue('.launch-input');
check('clicking an example runs it', after !== before && after.length > 0, `${before} → ${after}`);

await h.page.screenshot({ path: new URL('../screens/23-search-help.png', import.meta.url).pathname });
const errs = h.errors.filter((e) => !e.includes('net::ERR_ABORTED'));
await h.close({ exit: false });

// --- 3. The same client, a different transformer -------------------------------
// Nothing about the web app changed between these two boots. If the box still says
// "#tag" here, the prompt was baked into the bundle and the whole exercise failed.
h = await boot({ seed, serverConfig: { searchTransformer: new ColonTransformer() } });
await h.goto();
await h.page.waitForSelector('.launch-item', { timeout: 5000 });

const custom = await placeholder();
// The client still appends its own "! run a command" — that clause is a client
// convention the server knows nothing about, so it survives any transformer.
check('a different transformer changes the prompt', custom.startsWith('find: something'), custom);
check('and it no longer advertises a grammar this server does not parse', !/#/.test(custom), custom);

// A tag nothing carries is the reliable way to get a genuinely empty result — semantic
// search returns the nearest thing to any query, so "gibberish" still matches something.
await h.page.fill('.launch-input', '#zzznosuchtag');
await h.page.waitForFunction(
  () => window.__trove.app.search.get().ran && !window.__trove.app.search.get().loading
    && window.__trove.app.search.get().results.length === 0,
  null, { timeout: 6000 });
await h.page.waitForTimeout(200);
const customHelp = await h.page.locator('.launch-help').innerText();
check('the help follows the transformer too', /find:/.test(customHelp) && !/#tag/.test(customHelp),
  customHelp.replace(/\n/g, ' | '));

// --- 4. A phone gets the short form --------------------------------------------
await h.page.setViewportSize({ width: 390, height: 844 });
await h.page.waitForTimeout(200);
const shortForm = await placeholder();
check('a narrow box gets the short prompt rather than an ellipsis', shortForm === 'find:', shortForm);

errs.push(...h.errors.filter((e) => !e.includes('net::ERR_ABORTED')));
check('no uncaught errors along the way', errs.length === 0, errs.slice(0, 4).join(' | '));
done();
await h.close();

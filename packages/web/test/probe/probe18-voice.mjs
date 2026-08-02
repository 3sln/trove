// Probe: speak to search.
//
// The remote's mic button is not ours on any TV platform — webOS exposes no API for the
// Magic Remote's microphone, Tizen's voice control does not exist for a page in the TV
// browser, and Android TV's button raises Assistant. No key event reaches the document.
//
// So the feature is not "capture the mic button". It is "never let the mic have nowhere
// to land": a remote dictates into whatever text field the platform keyboard is attached
// to, so `search.voice` opens the search surface and focuses its input. THAT is what is
// checked here, because it is the half that works on every TV with no API at all — and
// it is exactly the half that would rot silently, since nothing else in the app depends
// on the search field being focusable on demand.
//
// The transcription half is gated on `SpeechRecognition.available`, the on-device
// entry point. Headless Chromium has no such thing, which is the point: the check is
// that we OFFER NOTHING rather than falling back to recognition that ships audio off
// the machine.

import { boot, checker } from './harness.mjs';

const { check, done } = checker();

const { page, close, goto, errors } = await boot({
  seed: async (vfs) => {
    await vfs.writeFile('sailing.txt', 'Trimming the mainsail at dawn.', { contentType: 'text/plain' });
    await vfs.writeFile('cooking.txt', 'Braising short ribs.', { contentType: 'text/plain' });
  },
});
await goto();
await page.waitForSelector('.launch-item', { timeout: 8000 });

const focused = () => page.evaluate(() => document.activeElement?.className || '(none)');

// --- 1. From the launcher, with focus parked somewhere else --------------------
await page.evaluate(() => document.querySelector('.activitybar .item')?.focus());
check('focus starts away from the search field', !(await focused()).includes('launch-input'), await focused());

await page.evaluate(() => window.__trove.platform.commands.execute('search.voice'));
await page.waitForTimeout(500);
check('search.voice puts the caret in the search field', (await focused()).includes('launch-input'), await focused());

// --- 2. From another view entirely ---------------------------------------------
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.openSettings'));
await page.waitForSelector('.settings', { timeout: 4000 });
await page.evaluate(() => window.__trove.platform.commands.execute('search.voice'));
await page.waitForTimeout(600);
check('from Settings it opens the modal search rather than doing nothing',
  await page.evaluate(() => !!document.querySelector('.search-modal')));
check('and focuses the modal\'s own input, not the one behind it',
  await page.evaluate(() => document.activeElement === document.querySelector('.search-modal .launch-input')));

// --- 3. With a file open over the launcher --------------------------------------
await page.evaluate(() => window.__trove.platform.commands.execute('workbench.closeOverlays'));
await page.evaluate(() => {
  const t = window.__trove;
  t.test.open(t.app.explorer.get().items.find((i) => i.name === 'sailing.txt'), 'core/text');
});
await page.waitForTimeout(600);
await page.evaluate(() => window.__trove.platform.commands.execute('search.voice'));
await page.waitForTimeout(600);
check('with a file open it still reaches a search field',
  (await focused()).includes('launch-input'), await focused());

// --- 4. Dictated text drives a real search --------------------------------------
// Stand in for the platform's own dictation: text arriving in the field as ordinary
// input, which is exactly what a TV remote's mic produces.
await page.evaluate(() => {
  const el = document.querySelector('.search-modal .launch-input') || document.querySelector('.launch-input');
  el.focus();
  el.value = 'sailing';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1200);
const names = await page.$$eval('.launch-item .name', (els) => els.map((e) => e.textContent));
check('text dictated into the focused field searches the drive', names.includes('sailing.txt'), names.join(', '));

// --- 5. No microphone is offered without on-device recognition -------------------
const offered = await page.evaluate(() => ({
  hasButton: !!document.querySelector('.launch-mic'),
  supported: window.__trove.platform.voice.get().supported,
  canListen: window.__trove.platform.voice.canListen(),
  // The gate: the on-device entry point, not merely the constructor.
  ctor: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  onDevice: typeof (window.SpeechRecognition || window.webkitSpeechRecognition)?.available === 'function',
}));
check('a browser with no on-device recognition is treated as unsupported',
  offered.supported === offered.onDevice, JSON.stringify(offered));
check('and no microphone button is offered there', offered.canListen || !offered.hasButton, JSON.stringify(offered));
// The trap this guards: `webkitSpeechRecognition` exists in plenty of browsers that
// would happily stream audio to a vendor's servers. Detecting it alone is the bug.
check('the constructor alone is never taken as permission to listen',
  !(offered.ctor && !offered.onDevice && offered.canListen), JSON.stringify(offered));

// --- 6. The transcription plumbing, against a stand-in recogniser ----------------
// Headless Chromium has no on-device language pack, so the real recogniser cannot run
// here. What CAN be checked is the REAL service against a stand-in: that it asks for
// on-device processing, that interim and settled transcripts both reach the query, and
// that a settled one runs a search.
const dictated = await page.evaluate(async () => {
  const t = window.__trove;
  const asked = [];
  class FakeRecognition {
    static available() { return Promise.resolve('available'); }
    static install() { return Promise.resolve(true); }
    start() {
      asked.push({ options: this.options, processLocally: this.processLocally });
      setTimeout(() => this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'brai' }], { isFinal: false })] }), 10);
      setTimeout(() => this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'braising ribs' }], { isFinal: true })] }), 40);
      setTimeout(() => this.onend?.(), 70);
    }
    stop() { this.onend?.(); }
  }
  const real = { s: window.SpeechRecognition, w: window.webkitSpeechRecognition };
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  const seen = [];
  await t.platform.voice.refresh();
  const offered = t.platform.voice.canListen();
  await new Promise((resolve) => {
    t.platform.voice.toggle({ onText: (text, { final }) => seen.push([text, final]) });
    const iv = setInterval(() => { if (!t.platform.voice.state.listening) { clearInterval(iv); resolve(); } }, 20);
  });

  window.SpeechRecognition = real.s;
  window.webkitSpeechRecognition = real.w;
  await t.platform.voice.refresh(); // put the real status back
  return { seen, asked, offered };
});
check('a ready recogniser makes the microphone available', dictated.offered === true, JSON.stringify(dictated.offered));
check('it asks for on-device processing, every time it starts',
  dictated.asked.length > 0 && dictated.asked.every((a) => a.processLocally === true && a.options?.processLocally === true),
  JSON.stringify(dictated.asked));
check('interim and settled transcripts both reach the query',
  dictated.seen.length === 2 && dictated.seen[0][1] === false
  && dictated.seen[1][0] === 'braising ribs' && dictated.seen[1][1] === true,
  JSON.stringify(dictated.seen));

// --- 7. The listening state is legible -------------------------------------------
// `.launch-box svg` used to force one colour on every icon in the box, so the
// microphone's listening state rendered as a blue block with an invisible grey mic in
// it — and the clear button's hover never lit its glyph either. A button owns the
// colour of its own icon.
const legible = await page.evaluate(async () => {
  class Fake {
    static available() { return Promise.resolve('available'); }
    static install() { return Promise.resolve(true); }
    start() {} stop() { this.onend?.(); }
  }
  const real = { s: window.SpeechRecognition, w: window.webkitSpeechRecognition };
  window.SpeechRecognition = Fake; window.webkitSpeechRecognition = Fake;
  const t = window.__trove;
  await t.platform.voice.refresh();
  await new Promise((r) => setTimeout(r, 200));
  t.platform.voice.toggle({ onText: () => {} });
  await new Promise((r) => setTimeout(r, 250));
  const btn = document.querySelector('.launch-mic');
  const path = btn?.querySelector('svg path');
  const out = {
    found: !!btn,
    listening: btn?.classList.contains('on') || false,
    button: btn && getComputedStyle(btn).color,
    glyph: path && getComputedStyle(path).stroke,
  };
  t.platform.voice.stop();
  window.SpeechRecognition = real.s; window.webkitSpeechRecognition = real.w;
  await t.platform.voice.refresh();
  return out;
});
check('the microphone appears once a recogniser is ready', legible.found && legible.listening, JSON.stringify(legible));
check('and its glyph takes the button\'s colour, so the listening state is visible',
  legible.glyph === legible.button, JSON.stringify(legible));

// --- 8. It is reachable, not just registered ------------------------------------
const inPalette = await page.evaluate(() => window.__trove.platform.contributions
  .ofType('command').some((c) => c.id === 'search.voice'));
check('the command is registered and reachable from the palette', inPalette);

const real = errors.filter((e) => !e.includes('net::ERR_ABORTED'));
check('no uncaught errors along the way', real.length === 0, real.slice(0, 4).join(' | '));
done();
await close();

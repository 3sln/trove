// What kind of screen is this, and how is it being driven?
//
// The drive runs on three shapes of device that want genuinely different chrome: a
// desktop with a mouse and a left rail, a phone held in one hand, and a TV across the
// room driven by a d-pad. This is the one place that decides which, so components ask
// `state.vp.mode` instead of each inventing its own breakpoint — and so a single
// override flips the whole shell at once.
//
// Detection is a guess, and guesses about TVs are especially bad (a browser on a set-top
// box reports a large screen and, often, a mouse it does not have). So the guess is only
// the default: `?ui=phone` in the URL, or the `workbench.layout` setting, wins outright.
// Someone whose TV we mis-detect can fix it in Settings rather than living with it.

import { cell, effect } from '../runtime.js';

export const LAYOUTS = ['auto', 'desktop', 'phone', 'tv'];

// Below this, the left rail plus a panel leaves nothing for the panel.
const PHONE_MAX = 720;
// A TV is a big screen you sit far away from. Only consulted alongside a UA hint —
// width alone would call every large monitor a television.
const TV_MIN = 1100;
const TV_UA = /\b(smart-?tv|smarttv|appletv|googletv|android\s*tv|hbbtv|netcast|web0s|webos|tizen|viera|bravia|aquos|crkey|nettv|dtv|philipstv|roku|aft[a-z]{1,3})\b/i;

/** Does the user agent say, unprompted, that it is a television? */
export function looksLikeTv(ua = '', width = 0) {
  if (!ua) return false;
  return TV_UA.test(ua) && width >= TV_MIN;
}

export class ViewportService {
  /**
   * @param {object} [deps]
   * @param {Window} [deps.window] the window to measure and listen to
   * @param {import('./settings.js').SettingsService} [deps.settings]
   */
  constructor({ window: win = globalThis, settings = null } = {}) {
    this.window = win;
    this.settings = settings;
    // A URL override outranks the setting: it is how someone checks the phone layout on
    // a laptop, and how the e2e suite drives each shell without a device farm.
    this.urlOverride = readUrlOverride(win);
    this.state = this.#measure();
    this.cell = cell(this.state);
    this._onResize = () => this.refresh();
  }

  observe() {
    return this.cell;
  }

  /** Start listening. Separate from the constructor so tests can measure without hooks. */
  install() {
    this.window.addEventListener?.('resize', this._onResize);
    this.window.addEventListener?.('orientationchange', this._onResize);
    // `effect` runs now and on every change. The old form was
     // `settings.observe().subscribe?.(…)` — optional-chained, so when `observe()`
     // stopped returning something with `.subscribe` it would have become a silent
     // no-op and the viewport would have stopped following its own setting.
    if (this.settings) effect(this.settings.observe(), () => this.refresh());
    this.#publish(this.state);
    return this;
  }

  dispose() {
    this.window.removeEventListener?.('resize', this._onResize);
    this.window.removeEventListener?.('orientationchange', this._onResize);
  }

  refresh() {
    const next = this.#measure();
    const same = next.mode === this.state.mode && next.width === this.state.width
      && next.height === this.state.height && next.coarse === this.state.coarse;
    if (same) return;
    this.state = next;
    this.#publish(next);
    this.cell.setValue(next);
  }

  #publish(vp) {
    // Context keys so plugin `when` clauses and keybindings can target a form factor
    // the same way they target a view.
    // The root element carries it too, so CSS can respond without every rule needing a
    // media query that would disagree with the JS branch above it.
    const el = this.window.document?.documentElement;
    if (el) el.dataset.layout = vp.mode;
  }

  #measure() {
    const win = this.window;
    const width = win.innerWidth || 1280;
    const height = win.innerHeight || 800;
    const coarse = matches(win, '(pointer: coarse)');
    const ua = win.navigator?.userAgent || '';
    const forced = this.urlOverride || this.settings?.get?.('workbench.layout') || 'auto';
    const mode = forced !== 'auto' && LAYOUTS.includes(forced) ? forced : detect({ width, coarse, ua });
    return { mode, width, height, coarse, forced: forced !== 'auto' };
  }
}

function detect({ width, coarse, ua }) {
  if (looksLikeTv(ua, width)) return 'tv';
  // Narrow is a phone whether or not the pointer is coarse — a desktop window dragged
  // small has the same problem a phone does, and the layout that fits one fits the other.
  if (width <= PHONE_MAX) return 'phone';
  return 'desktop';
}

function matches(win, query) {
  try { return !!win.matchMedia?.(query)?.matches; } catch { return false; }
}

function readUrlOverride(win) {
  try {
    const value = new URL(win.location.href).searchParams.get('ui');
    return value && LAYOUTS.includes(value) ? value : null;
  } catch { return null; }
}

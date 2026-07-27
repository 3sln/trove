// Driving the drive with a remote control.
//
// A TV has four arrows, an OK button, and a Back button. It has no pointer and no Tab
// key, so a layout that is perfectly usable with a mouse can be completely unreachable
// from a sofa: focus lands somewhere, the arrows do nothing, and there is no way out.
//
// This maps the arrows onto GEOMETRY rather than DOM order. Pressing right should move
// to the thing that is visually to the right, which is what someone holding a remote
// expects and what tab order — written for reading order — does not give. Two rules keep
// it from fighting the rest of the app:
//
//   1. If something already handled the key (the launcher's own list navigation, a text
//      field's caret), it is left alone. `defaultPrevented` is the contract.
//   2. Anything the app made clickable is reachable, whether or not the browser thinks
//      it is focusable. A div with a click handler is a destination on a TV; the
//      alternative is a list of files that cannot be opened.
//
// Only installed when the layout is 'tv'. On a desktop the pointer and Tab already work,
// and remapping the arrow keys there would break scrolling.

// Natively focusable, plus the app's own clickable rows. Keeping this list explicit
// (rather than "anything with a click handler", which the DOM cannot tell us) means a
// new clickable component is opted in deliberately.
import { effect } from '../runtime.js';

const NATIVE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
// `.setting-row` used to be listed here and has never existed — the rendered class is
// `.setting`, and it isn't clickable anyway (its control is). Every entry below is
// checked by probe15-tv-reach, so a renamed class fails a test instead of silently
// dropping a destination.
const APP_CLICKABLE = '.launch-item, .sheet-row, .inbox-item, .plugin-card, .act-task, .act-issue, .chapter';
const SELECTOR = `${NATIVE}, ${APP_CLICKABLE}`;

// Keys a television sends for "back". The named ones are the web standard; the numbers
// are Tizen (Samsung) and webOS (LG), which predate it and still ship.
const BACK_KEYS = new Set(['BrowserBack', 'GoBack', 'Backspace']);
const BACK_CODES = new Set([10009, 461]);

const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
// Elements the browser already fires a click on when Enter is pressed.
const ACTIVATES_ITSELF = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

export class SpatialNavigationService {
  /**
   * @param {object} deps
   * @param {import('./workbench.js').WorkbenchService} deps.workbench
   * @param {import('./viewport.js').ViewportService} deps.viewport
   * @param {Window} [deps.window]
   */
  constructor({ workbench, viewport, window: win = globalThis }) {
    this.workbench = workbench;
    this.viewport = viewport;
    this.window = win;
    this.active = false;
    this._onKey = (e) => this.handleKey(e);
    this._observer = null;
    this._pending = 0;
    this._bootstrapped = false;
  }

  /** Follow the viewport: arrows are remapped only while the TV layout is showing. */
  install() {
    if (this.viewport) effect(this.viewport.observe(), (vp) => this.setActive(vp.mode === 'tv'));
    this.setActive(this.viewport?.state?.mode === 'tv');
    return this;
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    // Bubble phase, so a component that wants the key gets it first and this only sees
    // what nothing else claimed.
    if (on) {
      this.window.addEventListener?.('keydown', this._onKey);
      this.#watchDom();
      // The first frame may not have rendered yet; a TV with nothing focused is a TV
      // where the first arrow press has no origin and appears to do nothing at all.
      this.prime();
      this.window.setTimeout?.(() => this.prime(), 60);
    } else {
      this.window.removeEventListener?.('keydown', this._onKey);
      this._observer?.disconnect();
      this._observer = null;
      this._bootstrapped = false;
    }
  }

  /**
   * Make everything clickable focusable, and make sure something IS focused.
   *
   * Both halves matter. A div with a click handler is a destination on a TV but the
   * browser will not focus it without a tabindex, and the app re-renders constantly, so
   * this has to run again after every render rather than once at startup.
   */
  prime() {
    this.candidates(); // stamps tabindex as a side effect
    this.focusFirst();
  }

  #watchDom() {
    const Obs = this.window.MutationObserver;
    if (!Obs || this._observer) return;
    // Coalesced to one pass per frame: the workbench replaces whole subtrees on a
    // re-render, and stamping per mutation would be thousands of calls per second.
    this._observer = new Obs(() => {
      if (this._pending) return;
      this._pending = this.window.requestAnimationFrame?.(() => {
        this._pending = 0;
        if (this.active) this.prime();
      }) || 0;
    });
    this._observer.observe(this.window.document.body, { childList: true, subtree: true });
  }

  handleKey(e) {
    if (!this.active || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const doc = this.window.document;
    const from = doc.activeElement;

    if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) {
      // Backspace with something to delete is a backspace. Getting this wrong throws
      // away what someone typed on an on-screen keyboard. But an EMPTY field has nothing
      // to delete, and a remote whose only Back button silently does nothing while a
      // search box happens to hold focus is a remote that can't leave the screen.
      if (e.key === 'Backspace' && isTextEntry(from) && (from.value ?? '').length > 0) return;
      e.preventDefault();
      this.goBack();
      return;
    }

    const dir = DIRS[e.key];
    if (!dir) {
      // Enter on a real button already activates it. Enter on one of the app's clickable
      // divs does nothing at all unless we say so — and note the test is the TAG, not
      // "is it focusable": we stamped a tabindex on those divs ourselves, so asking
      // whether they look focusable would answer yes for every one of them and OK would
      // silently do nothing on every file in the list.
      if (e.key === 'Enter' && from && !ACTIVATES_ITSELF.has(from.tagName) && from.matches(APP_CLICKABLE)) {
        e.preventDefault();
        from.click();
      }
      return;
    }
    // Inside a text field, left and right move the caret — until the caret runs out of
    // text. Then the next press leaves the field. Without the second half the search box
    // is a trap: focus goes in and the only way out is a key a remote doesn't have.
    if ((dir === 'left' || dir === 'right') && isTextEntry(from) && !atTextEdge(from, dir)) return;

    // A re-render can drop the focused node, leaving focus on <body> with no origin to
    // navigate from. Any arrow press should recover rather than appear to do nothing.
    const origin = from && from !== doc.body ? from : null;
    const next = this.find(dir, origin);
    if (!next) return;
    e.preventDefault();
    focusIt(next);
  }

  goBack() {
    // An open overlay is what "back" means while one is open. Only past that does back
    // mean the viewer stack, and only past THAT does it mean the browser.
    if (this.workbench?.closeOverlays()) return;
    this.window.history?.back?.();
  }

  /** Every candidate currently on screen, in whatever order the DOM gives them. */
  candidates() {
    const doc = this.window.document;
    const out = [];
    for (const el of doc.querySelectorAll(SELECTOR)) {
      if (el.getAttribute?.('aria-hidden') === 'true' || el.hasAttribute?.('disabled')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // Off-screen is not a destination — a remote can't scroll to something it can't
      // move to, so anything outside the viewport is skipped until it scrolls in.
      if (r.bottom < 0 || r.top > this.window.innerHeight || r.right < 0 || r.left > this.window.innerWidth) continue;
      // The app's clickable rows aren't focusable until we make them so. Doing it here,
      // lazily, keeps tabindex out of every component for a mode most users never see.
      if (!el.matches(NATIVE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      out.push({ el, rect: r });
    }
    return out;
  }

  /** The best thing to move to from `from` in `dir`, or null if there isn't one. */
  find(dir, from) {
    const all = this.candidates();
    if (!all.length) return null;
    const origin = from && from.getBoundingClientRect && from.getBoundingClientRect().width
      ? from.getBoundingClientRect()
      : null;
    if (!origin) return all[0].el;

    let best = null;
    let bestScore = Infinity;
    for (const { el, rect } of all) {
      if (el === from) continue;
      const score = scoreCandidate(origin, rect, dir);
      if (score == null || score >= bestScore) continue;
      bestScore = score;
      best = el;
    }
    return best;
  }

  /**
   * Put focus somewhere sensible, once.
   *
   * Deliberately only ONCE. Every re-render replaces DOM nodes and drops focus to
   * <body>, and re-running this each time would repeatedly yank the selection back to
   * the top of the screen while someone is halfway down a list. Recovering from lost
   * focus is the arrow handler's job instead — it navigates from the first candidate
   * when there is no origin, so a press always does something.
   */
  focusFirst() {
    if (this._bootstrapped) return;
    const doc = this.window.document;
    if (doc?.activeElement && doc.activeElement !== doc.body) return;
    const all = this.candidates();
    if (!all.length) return;
    // Search is what the drive is for, so that is where a remote should start.
    const target = all.find((c) => c.el.classList?.contains('launch-input')) || all[0];
    focusIt(target.el);
    this._bootstrapped = true;
  }
}

/** Is the caret already at the end it would be moving toward? */
function atTextEdge(el, dir) {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  // contenteditable and some input types report nothing; treat "can't tell" as at the
  // edge, since being unable to leave is the worse failure.
  if (start == null || end == null) return true;
  if (start !== end) return false; // a selection: the arrow collapses it
  return dir === 'left' ? start === 0 : end >= (el.value ?? '').length;
}

function isTextEntry(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes(el.type);
}

function focusIt(el) {
  el.focus?.({ preventScroll: true });
  // A TV screen is mostly not where your eye is; scrolling the target to the middle is
  // what makes a long list navigable without the selection hugging an edge.
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/**
 * How good a move is, lower being better — or null if the candidate isn't in that
 * direction at all.
 *
 * Two distances matter and they are not equal. How far it is ALONG the direction of
 * travel is the honest cost. How far it is OFF to the side is worse than it looks: a
 * candidate that is 10px further right but 400px down is not "to the right" in any sense
 * that matters to someone pressing right, so the sideways distance is weighted heavily.
 */
function scoreCandidate(from, to, dir) {
  const vertical = dir === 'up' || dir === 'down';
  // Near edges along the axis of travel.
  const [fromNear, toNear] = vertical
    ? (dir === 'down' ? [from.bottom, to.top] : [from.top, to.bottom])
    : (dir === 'right' ? [from.right, to.left] : [from.left, to.right]);
  const forward = dir === 'down' || dir === 'right';
  const along = forward ? toNear - fromNear : fromNear - toNear;
  // A tolerance, so items in the same row that overlap by a pixel or two still count.
  if (along < -2) return null;

  // Overlap on the cross axis is what makes something feel "in line". Where they overlap
  // the sideways cost is zero; where they don't, it is the gap between them.
  const [fs, fe, ts, te] = vertical
    ? [from.left, from.right, to.left, to.right]
    : [from.top, from.bottom, to.top, to.bottom];
  const aside = Math.max(0, Math.max(fs, ts) - Math.min(fe, te));
  // Also break ties by centre alignment, so a wide row doesn't beat the one directly
  // under the cursor just because they both overlap.
  const centerGap = Math.abs((fs + fe) / 2 - (ts + te) / 2);
  return Math.max(0, along) + aside * 3 + centerGap * 0.2;
}

export { scoreCandidate };

// The status-bar HTML sanitizer. Browser-only (it parses into a real inert
// <template>), so this suite runs under web-test-runner rather than `bun test` —
// a JSDOM-ish stand-in would test a different parser than the one that ships.

import { test, expect } from './testkit.js';
import { sanitizeFragment, htmlToText, sanitizedVNodes } from '../src/ui/sanitize.js';

const html = (s) => {
  const d = document.createElement('div');
  d.appendChild(sanitizeFragment(s));
  return d.innerHTML;
};

test('inline formatting on the allowlist survives', () => {
  expect(html('<b>3</b> queued')).toBe('<b>3</b> queued');
  expect(html('<span class="hot" title="tip">x</span>')).toBe('<span class="hot" title="tip">x</span>');
  expect(html('a<br>b')).toBe('a<br>b');
  expect(html('<em><code>go</code></em>')).toBe('<em><code>go</code></em>');
  expect(html('plain text')).toBe('plain text');
  expect(html('')).toBe('');
  expect(html(null)).toBe('');
});

test('anything that could execute, load, or navigate is dropped', () => {
  // Scripts: the element goes, and its text does not leak back in as content.
  expect(html('<script>alert(1)</script>')).toBe('');
  expect(html('ok<script>alert(1)</script>')).toBe('ok');
  // Event handlers are not on the attribute allowlist.
  expect(html('<span onclick="alert(1)">x</span>')).toBe('<span>x</span>');
  expect(html('<b onmouseover=alert(1)>x</b>')).toBe('<b>x</b>');
  // Resource-loading and navigating elements aren't on the tag allowlist at all.
  expect(html('<img src=x onerror=alert(1)>')).toBe('');
  // A tag that isn't on the list is dropped WITH its contents. Unwrapping it would
  // mean guessing that its text was meant to be shown — a guess that is catastrophic
  // for <script>/<style>/<template>, so the rule is uniform: not listed, not rendered.
  expect(html('<a href="javascript:alert(1)">go</a>')).toBe('');
  expect(html('<iframe src="https://evil.example"></iframe>')).toBe('');
  expect(html('<svg><use href="#x"/></svg>')).toBe('');
  // `style` can exfiltrate via url(), so it's dropped even on an allowed tag.
  expect(html('<span style="background:url(https://evil.example)">x</span>')).toBe('<span>x</span>');
  // Comments and unknown attributes go too.
  expect(html('<!-- hi --><b data-x="1" id="y">z</b>')).toBe('<b>z</b>');
});

test('output is bounded, so a runaway plugin can\'t wedge the shell', () => {
  const huge = 'x'.repeat(50_000);
  expect(html(huge).length).toBeLessThan(5000);
  const deep = '<b>'.repeat(500) + 'x' + '</b>'.repeat(500);
  expect(() => html(deep)).not.toThrow();
  const many = '<b>x</b>'.repeat(1000);
  const d = document.createElement('div');
  d.appendChild(sanitizeFragment(many));
  expect(d.querySelectorAll('b').length).toBeLessThanOrEqual(200);
});

test('htmlToText yields the plain text, for attribute contexts like tooltips', () => {
  expect(htmlToText('<b>3</b> queued')).toBe('3 queued');
  expect(htmlToText('<script>alert(1)</script>hi')).toBe('hi');
  expect(htmlToText('')).toBe('');
});

test('sanitizedVNodes produces renderer nodes, not an innerHTML island', () => {
  const dd = {
    span: (props, ...kids) => ({ tag: 'span', props, kids }),
    b: (props, ...kids) => ({ tag: 'b', props, kids }),
  };
  const nodes = sanitizedVNodes('<b>3</b> queued', dd);
  expect(nodes.length).toBe(2);
  expect(nodes[0].tag).toBe('b');
  expect(nodes[0].kids).toEqual(['3']);
  expect(nodes[1]).toBe(' queued');

  // Attributes that survived sanitizing are carried onto the vnode.
  const [withProps] = sanitizedVNodes('<span class="hot" title="tip">x</span>', dd);
  expect(withProps.props).toEqual({ className: 'hot', title: 'tip' });

  // A tag the renderer doesn't model degrades to its text rather than vanishing.
  expect(sanitizedVNodes('<code>go</code>', dd)).toEqual(['go']);
  expect(sanitizedVNodes('<script>alert(1)</script>', dd)).toEqual([]);
});

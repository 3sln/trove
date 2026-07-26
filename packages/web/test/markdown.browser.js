// The markdown renderer. Browser-only: it builds real DOM through the VDOM, and the
// point of several of these cases is what the browser does with an attribute.
//
// Markdown is load-bearing now — a document that links its sources is what grouping
// looks like without folders — and it is also untrusted content that anyone who can
// write to the drive can author. So link handling is a security boundary, not styling.

import { test, expect } from './testkit.js';
import { dd } from '../src/runtime.js';
import { renderMarkdown } from '../src/ui/components/openers/markdown.js';

const ui = { platform: { notifications: {} }, go() {} };
const node = { id: 'itm_1', name: 'doc.md', collectionId: 'default' };

function render(md) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  dd.reconcile(host, [dd.div({}, ...renderMarkdown(md, node, ui))]);
  dd.flush?.();
  return host;
}
const html = (md) => render(md).innerHTML;
const text = (md) => render(md).textContent;

test('block structure: headings, lists, quotes, rules, paragraphs', () => {
  expect(html('# Title')).toContain('<h1');
  expect(html('### Deep')).toContain('<h3');
  expect(render('- a\n- b').querySelectorAll('li').length).toBe(2);
  expect(render('1. a\n2. b').querySelector('ol')).toBeTruthy();
  expect(render('> quoted').querySelector('blockquote')).toBeTruthy();
  expect(render('---').querySelector('hr')).toBeTruthy();
  // Consecutive lines are one paragraph with a soft break, not two paragraphs.
  const p = render('one\ntwo');
  expect(p.querySelectorAll('p').length).toBe(1);
  expect(p.querySelectorAll('br').length).toBe(1);
});

test('fenced code is verbatim — markdown inside it is not markdown', () => {
  const el = render('```\n# not a heading\n**not bold**\n```');
  expect(el.querySelector('pre code').textContent).toBe('# not a heading\n**not bold**');
  expect(el.querySelector('h1')).toBe(null);
  expect(el.querySelector('strong')).toBe(null);
  // An unterminated fence still renders rather than swallowing the document.
  expect(render('```\ndangling').querySelector('pre')).toBeTruthy();
});

test('inline: code wins over emphasis, so backticks are literal', () => {
  expect(render('**bold**').querySelector('strong')?.textContent).toBe('bold');
  expect(render('_em_').querySelector('em')?.textContent).toBe('em');
  expect(render('`a*b*c`').querySelector('code')?.textContent).toBe('a*b*c');
  expect(render('`a*b*c`').querySelector('em')).toBe(null);
});

test('a trove: link is in-app and carries no href to navigate to', () => {
  const a = render('[notes](trove:default/sailing.txt)').querySelector('a.md-trove');
  expect(a).toBeTruthy();
  expect(a.textContent).toBe('notes');
  expect(a.getAttribute('title')).toBe('trove:default/sailing.txt');
  // Following it is a click handler, not an href — the browser must never try to
  // resolve `trove:` itself, which would leave the app.
  expect(a.getAttribute('href')).toBe('#');

  // A bare reference is a link too, so a pasted URI works without link syntax.
  expect(render('see trove:default?name=a.md here').querySelector('a.md-trove')).toBeTruthy();
  // …and sentence punctuation isn't part of the target.
  expect(render('see trove:default/a.md.').querySelector('a.md-trove').getAttribute('title')).toBe('trove:default/a.md');
});

test('an external link opens away from the app, without handing it our tab', () => {
  const a = render('[docs](https://example.com/x)').querySelector('a');
  expect(a.getAttribute('href')).toBe('https://example.com/x');
  expect(a.getAttribute('target')).toBe('_blank');
  // Without noopener the opened page can navigate ours via window.opener.
  expect(a.getAttribute('rel')).toBe('noopener noreferrer');
});

test('any other scheme is inert text — a document is untrusted content', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd']) {
    const el = render(`[click me](${bad})`);
    expect(el.querySelector('a')).toBe(null);
    expect(el.querySelector('.md-deadlink')?.textContent).toBe('click me');
  }
  // Raw HTML in the source is text, not markup — there is no HTML passthrough at all.
  const raw = render('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
  expect(raw.querySelector('img')).toBe(null);
  expect(raw.querySelector('script')).toBe(null);
  expect(raw.textContent).toContain('<img src=x onerror=alert(1)>');
});

test('empty and degenerate input renders nothing rather than throwing', () => {
  expect(text('')).toBe('');
  expect(text('   \n\n  ')).toBe('');
  expect(() => render('[unclosed](')).not.toThrow();
  expect(() => render('***')).not.toThrow();
  expect(() => render('#'.repeat(50))).not.toThrow();
});

test('a hostile document is bounded, not fatal — it must never take the viewer down', () => {
  // The failure this replaces: one recursion per inline span overflowed the stack
  // mid-render, and the viewer sat on its loading spinner forever saying nothing.
  const manySpans = '*a* '.repeat(30000);
  let el;
  expect(() => { el = render(manySpans); }).not.toThrow();
  expect(el.querySelectorAll('em').length).toBeGreaterThan(0);

  // Deeply nested markers recurse on CONTENTS only, and stop at a fixed depth.
  const deep = '*'.repeat(400) + 'x' + '*'.repeat(400);
  expect(() => render(deep)).not.toThrow();

  // Long single lines and huge documents are truncated with a visible notice — a
  // silently-cut document reads as "the rest isn't there".
  const huge = '# H\n\n' + 'lorem ipsum dolor sit amet. '.repeat(40000);
  const big = render(huge);
  expect(big.querySelector('.md-truncated')).toBeTruthy();

  // Many blocks are capped the same way.
  const blocks = render('- x\n\n'.repeat(9000));
  expect(blocks.querySelector('.md-truncated')).toBeTruthy();
});

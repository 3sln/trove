// The markdown opener. Markdown is load-bearing now: with no folder hierarchy, a
// document that links its sources IS the grouping, so these files have to render as
// documents with working links rather than as a wall of `<pre>`.
//
// A `trove:` link navigates in-app (see ../../../bl/links.js for resolution); an http(s)
// link opens in a new tab with `rel="noopener noreferrer"`; anything else — `javascript:`,
// `data:` — is rendered as inert text, because a document is untrusted content that any
// user of the drive can write.
//
// The parser is deliberately small: headings, lists, block quotes, fenced code, inline
// code/emphasis/links, and paragraphs. It builds VDOM nodes directly and never produces
// an HTML string, so there is no innerHTML to get wrong.
//
// It is also BOUNDED. The input is a file someone uploaded, so its size and shape are
// not ours to choose: a document with tens of thousands of emphasis spans used to
// recurse once per span and overflow the stack mid-render, which left the viewer on a
// spinner forever with nothing said. Inline scanning is now iterative, and both the
// document length and the node count are capped — a truncated document with a visible
// notice beats a hung one.

import { dd, mapCell } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { parseTroveUri } from '@3sln/trove/core/links.js';
import { OpenTroveLinkAction } from '../../../bl/links.js';
import { FileText } from '../../../bl/queries.js';
import { watchQuery } from '../../../bl/watchQuery.js';

const { div, span, h1, h2, h3, p, ul, ol, li, pre, code, a, em, strong, blockquote, hr, br } = dd;

export function markdownOpener(node, ui) {
  // Bounded at the TRANSFER, not just the render: MAX_CHARS below stops us laying out a
  // huge document, but without this the whole file is still pulled into the tab first.
  const src = mapCell(watchQuery(ui.engine, FileText.of(node.id, MAX_CHARS, node.size)), (r) => r.text);
  return dd.alias(() =>
    ui.watch(
      src,
      // A throw in here is NOT covered by the `error:` handler below — that one is for
      // the observable failing, not for the mapper. Rendering untrusted content is
      // exactly where a throw is plausible, and an uncaught one leaves the placeholder
      // on screen forever, so it is caught where it happens.
      (text) => {
        try {
          return div({ className: 'viewer markdown' }, div({ className: 'md' }, ...renderMarkdown(text, node, ui)));
        } catch (err) {
          console.error('markdown render failed', err);
          return errorView(`This document couldn’t be displayed: ${err.message}`);
        }
      },
      {
        placeholder: () => div({ className: 'viewer' }, div({ className: 'loading' }, div({ className: 'spinner' }), span('Loading…'))),
        error: (e) => errorView(e.message),
      },
    ),
  )();
}

function errorView(message) {
  return div({ className: 'viewer' }, div({ className: 'fallback' }, icon('warn', { size: 40 }), span(message)));
}

// Bounds. A document past these renders as much as fits, with a notice — the parse is
// linear, so these are about the size of the resulting DOM, not about parse time.
const MAX_CHARS = 512 * 1024;
const MAX_BLOCKS = 5_000;
const MAX_INLINE_NODES = 2_000; // per block

// --- block level -------------------------------------------------------------

export function renderMarkdown(text, node, ui) {
  const raw = String(text ?? '');
  const truncated = raw.length > MAX_CHARS;
  const lines = (truncated ? raw.slice(0, MAX_CHARS) : raw).split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    if (out.length >= MAX_BLOCKS) return [...out, tooLarge()];
    const line = lines[i];

    // Fenced code — taken verbatim, including any markdown inside it.
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence (or EOF — an unterminated fence still renders)
      out.push(pre({ className: 'md-code' }, code(body.join('\n'))));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const factory = level === 1 ? h1 : level === 2 ? h2 : h3;
      out.push(factory({ className: `md-h md-h${level}` }, ...inline(heading[2], node, ui)));
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(hr({ className: 'md-hr' })); i++; continue; }

    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(blockquote({ className: 'md-quote' }, ...renderMarkdown(body.join('\n'), node, ui)));
      continue;
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(li({ className: 'md-li' }, ...inline(m[2], node, ui)));
        i++;
      }
      out.push((ordered ? ol : ul)({ className: 'md-list' }, ...items));
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start another block.
    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    const joined = para.join('\n');
    const kids = [];
    joined.split('\n').forEach((l, n) => {
      if (n) kids.push(br());
      kids.push(...inline(l, node, ui));
    });
    out.push(p({ className: 'md-p' }, ...kids));
  }
  return truncated ? [...out, tooLarge()] : out;
}

// Say what happened, rather than silently rendering a prefix as if it were the whole
// document — a reader who can't tell it was cut off will believe the rest isn't there.
function tooLarge() {
  return p({ className: 'md-truncated' },
    'This document is too large to display in full. Download it to read the rest.');
}

function startsBlock(line) {
  return /^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s|\s*(```|~~~))/.test(line)
    || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

// --- inline level ------------------------------------------------------------

// Ordered by precedence: code spans win over emphasis (so `*` inside backticks is
// literal), and explicit links win over bare autolinks.
const INLINE = [
  { re: /`([^`]+)`/, node: (m) => code({ className: 'md-inline-code' }, m[1]) },
  { re: /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, node: (m, node, ui) => link(m[2], m[1] || m[2], node, ui) },
  { re: /(\*\*|__)(.+?)\1/, node: (m, node, ui, d) => strong(...inline(m[2], node, ui, d + 1)) },
  { re: /(\*|_)(.+?)\1/, node: (m, node, ui, d) => em(...inline(m[2], node, ui, d + 1)) },
  // Bare URLs, so a pasted trove: reference is clickable without link syntax.
  { re: /(trove:[^\s<>"'`)\]}]+|https?:\/\/[^\s<>"'`)\]}]+)/, node: (m, node, ui) => link(trimTrailing(m[1]), trimTrailing(m[1]), node, ui) },
];

/**
 * Scan one line into inline nodes. Iterative on purpose: the obvious recursive form
 * (split on the first match, recurse on both sides) descends once per span, so a line
 * with thousands of them overflows the stack — and the input is a file someone
 * uploaded, so "thousands of them" is their choice, not ours.
 *
 * Emphasis still nests, via a bounded recursion on the span's *contents* only. That
 * depth is limited by how deeply markers are nested rather than by how many spans a
 * line contains, so it stays shallow for anything a person would write, and `depth`
 * stops a pathological document regardless.
 */
function inline(text, node, ui, depth = 0) {
  if (!text) return [];
  if (depth > 12) return [text]; // deeper than any real markup; render it literally
  const out = [];
  let rest = text;
  while (rest) {
    if (out.length >= MAX_INLINE_NODES) { out.push(rest); break; }
    let best = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) { out.push(rest); break; }
    const { m, rule } = best;
    if (m.index) out.push(rest.slice(0, m.index));
    out.push(rule.node(m, node, ui, depth));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function trimTrailing(url) {
  return url.replace(/[.,;:!?]+$/, '');
}

/**
 * One link. A `trove:` reference navigates inside the app and is resolved lazily on
 * click — resolving every link up front would mean a request per link on every render,
 * and a link's target can appear or disappear between renders anyway.
 *
 * Only trove: and http(s) are rendered as links at all. A `javascript:` or `data:` URL
 * is shown as plain text: markdown here is untrusted content written by whoever can
 * write to the drive, and an allowlist is the only way to be sure about a scheme.
 */
function link(href, label, node, ui) {
  const trove = parseTroveUri(href);
  if (trove) {
    return a({ className: 'md-link md-trove', href: '#', title: href }, label).on({
      click: (e) => {
        e.preventDefault();
        ui.engine.dispatch(new OpenTroveLinkAction(href, node));
      },
    });
  }
  if (/^https?:\/\//i.test(href)) {
    return a({ className: 'md-link', href, target: '_blank', rel: 'noopener noreferrer', title: href }, label);
  }
  return span({ className: 'md-deadlink', title: `Unsupported link: ${href}` }, label);
}

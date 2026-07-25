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

import { dd, Observable } from '../../../runtime.js';
import { icon } from '../../icon.js';
import { parseTroveUri } from '@trove/core/links.js';
import { openTroveLink } from '../../../bl/links.js';

const { div, span, h1, h2, h3, p, ul, ol, li, pre, code, a, em, strong, blockquote, hr, br } = dd;

export function markdownOpener(node, ui) {
  const src = Observable.fromAsync(() => ui.platform.api.readText(node.id));
  return dd.alias(() =>
    ui.platform.reactive.watch(
      src,
      (text) => div({ className: 'viewer markdown' }, div({ className: 'md' }, ...renderMarkdown(text, node, ui))),
      {
        placeholder: () => div({ className: 'viewer' }, div({ className: 'loading' }, div({ className: 'spinner' }), span('Loading…'))),
        error: (e) => div({ className: 'viewer' }, div({ className: 'fallback' }, icon('warn', { size: 40 }), span(e.message))),
      },
    ),
  )();
}

// --- block level -------------------------------------------------------------

export function renderMarkdown(text, node, ui) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
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
  return out;
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
  { re: /(\*\*|__)(.+?)\1/, node: (m, node, ui) => strong(...inline(m[2], node, ui)) },
  { re: /(\*|_)(.+?)\1/, node: (m, node, ui) => em(...inline(m[2], node, ui)) },
  // Bare URLs, so a pasted trove: reference is clickable without link syntax.
  { re: /(trove:[^\s<>"'`)\]}]+|https?:\/\/[^\s<>"'`)\]}]+)/, node: (m, node, ui) => link(trimTrailing(m[1]), trimTrailing(m[1]), node, ui) },
];

function inline(text, node, ui) {
  if (!text) return [];
  let best = null;
  for (const rule of INLINE) {
    const m = rule.re.exec(text);
    if (m && (best === null || m.index < best.m.index)) best = { m, rule };
  }
  if (!best) return [text];
  const { m, rule } = best;
  return [
    ...inline(text.slice(0, m.index), node, ui),
    rule.node(m, node, ui),
    ...inline(text.slice(m.index + m[0].length), node, ui),
  ];
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
        openTroveLink(ui, href, { from: node });
      },
    });
  }
  if (/^https?:\/\//i.test(href)) {
    return a({ className: 'md-link', href, target: '_blank', rel: 'noopener noreferrer', title: href }, label);
  }
  return span({ className: 'md-deadlink', title: `Unsupported link: ${href}` }, label);
}

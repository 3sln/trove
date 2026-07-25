// A small, allowlist-only HTML sanitizer for content a PLUGIN produces (status bar
// items today). Plugin code runs on an opaque origin with no reach into the host DOM;
// anything it hands us to render is untrusted string data and must not be able to
// become script, load a resource, or navigate.
//
// Allowlist, not denylist: parse into an inert document, then rebuild only the nodes
// and attributes named below. Anything unrecognised — an element, an attribute, a
// URL scheme — is dropped rather than "cleaned", so a novel injection has nothing to
// slip through. `template` parsing is inert: no scripts execute and no images load
// while we walk it.

const ALLOWED_TAGS = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'CODE', 'SMALL', 'BR', 'S', 'U']);
const ALLOWED_ATTRS = new Set(['class', 'title']);
// Cap the output so a runaway plugin can't wedge the shell with a megabyte of markup.
const MAX_LENGTH = 4096;
const MAX_NODES = 200;

/**
 * Sanitize `html` into a DocumentFragment safe to insert into the host DOM.
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function sanitizeFragment(html) {
  const out = document.createDocumentFragment();
  if (typeof html !== 'string' || !html) return out;
  const tpl = document.createElement('template');
  tpl.innerHTML = html.slice(0, MAX_LENGTH);
  const budget = { nodes: MAX_NODES };
  for (const child of tpl.content.childNodes) {
    const clean = clone(child, budget);
    if (clean) out.appendChild(clean);
  }
  return out;
}

/** Sanitize `html` and set it as the only content of `el`. */
export function setSanitizedHtml(el, html) {
  el.replaceChildren(sanitizeFragment(html));
}

/** The plain-text content of `html`, for tooltips and other attribute contexts. */
export function htmlToText(html) {
  const frag = sanitizeFragment(html);
  return (frag.textContent || '').trim();
}

/**
 * Sanitize `html` into VDOM nodes, so plugin content reconciles like everything else
 * instead of being an opaque innerHTML island the renderer can't see into.
 * @param {string} html
 * @param {Record<string, Function>} dd  the element factories (dodo's `dd`)
 */
export function sanitizedVNodes(html, dd) {
  return [...sanitizeFragment(html).childNodes].map((n) => toVNode(n, dd)).filter((n) => n != null);
}

function toVNode(node, dd) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  const factory = dd[node.tagName.toLowerCase()];
  if (!factory) return node.textContent; // allowed tag the renderer doesn't model
  const props = {};
  if (node.className) props.className = node.className;
  if (node.title) props.title = node.title;
  return factory(props, ...[...node.childNodes].map((c) => toVNode(c, dd)).filter((n) => n != null));
}

function clone(node, budget) {
  if (budget.nodes-- <= 0) return null;
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return null; // comments, CDATA, …
  if (!ALLOWED_TAGS.has(node.tagName)) return null;

  const el = document.createElement(node.tagName.toLowerCase());
  for (const attr of node.attributes) {
    const name = attr.name.toLowerCase();
    // `on*` handlers never reach here (not in the allowlist), but be explicit: no
    // event handler, no `style` (CSS can exfiltrate via url()), no URL attributes.
    if (!ALLOWED_ATTRS.has(name)) continue;
    el.setAttribute(name, attr.value.slice(0, 200));
  }
  for (const child of node.childNodes) {
    const clean = clone(child, budget);
    if (clean) el.appendChild(clean);
  }
  return el;
}

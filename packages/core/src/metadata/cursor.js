// Page cursors for listing a collection.
//
// An OFFSET cursor is wrong for a live drive. `nextCursor = offset + limit` assumes the
// rows before the cut don't move, and in a shared collection they do: delete or rename
// an item that sorts early, or let someone else's upload land there, and the next page
// starts one row late — an item is skipped entirely, or served twice. With no folders,
// "load more" is the ONLY way to reach item 501, so a skipped file is invisible until a
// full refresh, and nothing tells the user it happened.
//
// A keyset cursor remembers WHERE the last page ended rather than how many rows it
// counted: "everything after (name, id)". Rows inserted before that point don't shift
// it, and rows removed from before it don't either. `id` is the tiebreaker, so a sort
// column with duplicates (two files the same size) still yields a total order.

/** Encode the last row of a page as the cursor for the next one. */
export function encodeCursor(sort, node) {
  if (!node) return null;
  return base64url(JSON.stringify(['k', sort, node[sort] ?? null, node.id]));
}

/**
 * Decode a cursor into `{ value, id }`, or null.
 *
 * A cursor from a different sort order is discarded rather than misapplied: sorting by
 * name and resuming from a size is a comparison against the wrong axis, which would
 * silently drop most of the collection. Returning null restarts the listing, which is
 * the honest answer to "your bookmark no longer means anything".
 */
export function decodeCursor(sort, cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(unbase64url(String(cursor)));
    if (!Array.isArray(parsed) || parsed[0] !== 'k' || parsed[1] !== sort) return null;
    return { value: parsed[2], id: parsed[3] };
  } catch {
    return null;
  }
}

/** Is `node` strictly after the cursor position, under this sort direction? */
export function afterCursor(node, sort, at, desc) {
  const a = node[sort];
  const b = at.value;
  const cmp = compare(a, b);
  if (cmp !== 0) return desc ? cmp < 0 : cmp > 0;
  return desc ? node.id < at.id : node.id > at.id;
}

function compare(a, b) {
  // Text compares case-insensitively to match the stores' NOCASE ordering; anything
  // else compares naturally.
  if (typeof a === 'string' && typeof b === 'string') {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// base64url without padding, over UTF-8, working in both Node and the browser.
function base64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

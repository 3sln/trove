// Obtaining authorized handles for the duration of one request.
//
// `container.lease()` is the enforcement point — a node or collection handle only
// exists if the principal holds the capability, and the handle's METHODS ARE THE ONES
// that capability permits (see engine/providers/access.js). What a caller needs around
// that is bookkeeping: leases taken during a request, released with it, released even
// when one release throws.
//
// Both request surfaces need it. The HTTP router obviously; MCP just as much, because
// an agent holding Alice's token is Alice and there must be no MCP-shaped way around
// the ACL. Written once so the two cannot drift.
//
// The same goes for WHO IS ASKING and what that subject may reach. Those helpers lived in
// routes.js, and mcp/tools.js grew its own copies — which drifted, in the direction that
// surface makes worst: MCP filtered a named collection out of the readable list, so an
// agent asking about a collection it may not see was told "No files matched… Try different
// words" and burned turns rephrasing a permissions error. mcp/index.js claims "It is not a
// second access-control system to keep in sync with the first"; it was one.

import { TroveError } from '@3sln/trove/core';

/**
 * @param {object|null} container the engine container, or null where there is none
 * @param {object|null} principal who is asking
 * @returns {{access: object|null, release: () => Promise<void>}}
 */
export function leaseScope(container, principal, grant = null) {
  const held = [];
  if (!container) return { access: null, release: async () => {} };

  const obtain = async (name, request) => {
    const lease = await container.lease({ [name]: { principal, grant, ...request } });
    held.push(lease);
    return lease.resources[name];
  };

  return {
    access: {
      /** @param {string} id a node id, a name, or a `trove:` URI */
      node: (id, capability, opts) => obtain('node', { id, capability, ...opts }),
      collection: (id, capability) => obtain('collection', { id, capability }),
      upload: (id) => obtain('upload', { id }),
    },
    // Every lease gets released, including the ones after a release that threw. A
    // sequential `for (…) await l.release()` leaks the rest of the list on the first
    // failure, which is precisely the moment leaking hurts most.
    release: async () => {
      const all = held.splice(0);
      await Promise.allSettled(all.map((l) => l.release()));
    },
  };
}

/**
 * The collections this caller may read, optionally narrowed to one they asked for.
 *
 * Every drive-wide query needs this, and it has to be applied INSIDE the query rather
 * than by filtering results: a LIMIT spent on rows the caller can't see would report
 * "no matches" while matches they can see sit just past the cut.
 *
 * Always a list. It used to answer `undefined` for "don't scope" on a drive with ACLs
 * switched off, and there is no such drive: `collections: false` is refused by
 * `configFromEnv` and again by the provider.
 */
export async function readableCollectionIds(ctx, narrowTo) {
  // A NAMED collection is asserted, not filtered. Filtering an unreadable id out of the
  // list answers "no results" for a collection the caller may not see — indistinguishable
  // from one that is simply empty, so a permissions problem reads as an indexing problem.
  // `access.collection` throws the 403 that says what actually happened.
  if (narrowTo) {
    await ctx.access.collection(narrowTo, 'read');
    return [narrowTo];
  }
  return (await listFor(ctx)).map((c) => c.id);
}

// --- who is asking ------------------------------------------------------------
//
// On a key request `ctx.principal` is NULL and the authority lives on `ctx.grant`, so
// handing the principal to CollectionService asks about the anonymous caller instead of
// about the key. That failed in both directions: on a locked drive a correctly-scoped
// key got `list(null) === []` and 403s from search, tags, backlinks, tasks and issues,
// while on a `defaultOpen` drive the `anyone` grant let a key scoped to one collection
// read and write every one of them through those same routes. engine/providers/access.js
// was the only place that had it right.
//
// One helper per question, so "does this surface understand API keys" has one answer
// rather than one per call site. Never a union of the two: a request bearing a key is
// the key's request, and falling back to whatever session is attached is how a weak
// credential borrows a strong one.

export const listFor = (ctx) =>
  (ctx.grant ? ctx.collections.listForGrant(ctx.grant) : ctx.collections.list(ctx.principal));

export const wholeDriveFor = (ctx) =>
  (ctx.grant ? ctx.collections.grantHasWholeDrive(ctx.grant) : ctx.collections.hasWholeDrive(ctx.principal));

/** Returns the collection record, so a caller that needs it does not assert twice. */
export async function assertCap(ctx, collectionId, capability) {
  return ctx.grant
    ? ctx.collections.assertForGrant(ctx.grant, collectionId, capability)
    : ctx.collections.assert(ctx.principal, collectionId, capability);
}

/** The `describe` that matches whoever asked, so the reported capabilities are theirs. */
export const describeFor = (ctx, c) =>
  (ctx.grant ? ctx.collections.describeForGrant(c, ctx.grant) : ctx.collections.describe(c, ctx.principal));

/**
 * Refuse a request that arrived on an API key.
 *
 * For the collection-ADMINISTRATION verbs, whose authority CollectionService reads from
 * the principal alone. A key request has no principal, so those methods judge it as the
 * anonymous caller — allowing everything on a `defaultOpen` drive and nothing on a locked
 * one. Rather than teach create/update/remove/setGrant about grants, keys stay out: a key
 * that can rewrite a collection's ACL can grant itself whatever it lacks, which is the
 * self-escalation shape `requireHumanAdmin` refuses for the same reason.
 */
export function refuseGrant(ctx, action) {
  if (ctx.grant) throw TroveError.forbidden(`An API key cannot ${action} — sign in instead`);
}

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

/**
 * @param {object|null} container the engine container, or null where there is none
 * @param {object|null} principal who is asking
 * @returns {{access: object|null, release: () => Promise<void>}}
 */
export function leaseScope(container, principal) {
  const held = [];
  if (!container) return { access: null, release: async () => {} };

  const obtain = async (name, request) => {
    const lease = await container.lease({ [name]: { principal, ...request } });
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

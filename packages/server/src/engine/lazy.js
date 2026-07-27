// A provider for a resource that is built once, shared by everyone, and torn
// down only when the container is.
//
// ngin ships three: `fromSingleton` takes a resource that already exists,
// `fromPool` hands out a fixed number, `fromRefCounted` destroys at zero. None
// of them fits the backbone of a server. Almost everything here — the storage
// backend, the metadata store, the search index — is built ONCE, asynchronously
// (`await sqlite.init()`, `await vfs.init()`), and must outlive the work that
// borrows it. `fromSingleton` cannot build it, because building is async and
// ordered; `fromRefCounted` would destroy the whole drive the moment an action
// released its lease and the count touched zero.
//
// So: creation is lazy and memoized, `release` does nothing, and `dispose` is
// the only thing that takes the resource down. Since the container disposes in
// reverse construction order, that is also what makes teardown ordering fall
// out of the dependency graph instead of being maintained by hand.

import { Provider } from '@3sln/ngin';

/**
 * @param {(deps: object) => any} create  gets the dependency PROVIDERS, as ngin's
 *   own factories do — a resource built here outlives the call, so it has to be
 *   able to hold a dependency for its own lifetime.
 * @param {((resource: any, deps: object) => any)|null} [dispose]
 * @param {string[]} [deps]
 */
export function lazySingleton(create, dispose = null, deps = []) {
  return class LazySingletonProvider extends Provider {
    static deps = deps;

    #deps;
    #creation = null;
    #resource = null;
    #disposed = false;

    constructor(injected = {}) {
      super();
      this.#deps = injected;
    }

    async obtain() {
      if (this.#disposed) {
        throw new Error('The provider has been disposed');
      }
      // Memoized on the promise, not the value: two concurrent obtains during a
      // slow `create` must get the same resource, not two of them.
      this.#creation ??= Promise.resolve().then(() => create(this.#deps));
      try {
        this.#resource = await this.#creation;
        return this.#resource;
      } catch (err) {
        // A failed build must not be cached — the next caller should get a fresh
        // attempt and its own error, not this one forever.
        this.#creation = null;
        throw err;
      }
    }

    /** Nothing: a singleton outlives whoever borrowed it. */
    release() {}

    async dispose() {
      if (this.#disposed) {
        return;
      }
      this.#disposed = true;
      if (!this.#creation || !dispose) {
        return;
      }
      // May still be building; tear down whatever it produces rather than
      // leaking a half-created resource.
      const resource = this.#resource ?? (await this.#creation.catch(() => null));
      if (resource != null) {
        await dispose(resource, this.#deps);
      }
    }
  };
}

/**
 * Obtain several dependency providers at once.
 *
 * Not released, deliberately: everything in the core graph is a `lazySingleton`
 * whose `release` is a no-op, and a resource built here holds its dependencies
 * for its own lifetime. Anything pooled or ref-counted must be leased properly
 * instead — see ScanClaimProvider, which does.
 */
export async function need(providers, names) {
  const out = {};
  for (const name of names) {
    out[name] = await providers[name].obtain();
  }
  return out;
}

// Obtaining several backbone resources at once.
//
// The lazy-singleton provider that used to live here is `Provider.fromLazySingleton`
// in ngin now (3sln/ngin#3) — it was the one shape the library was missing, and
// every resource in this drive's graph is that shape.
//
// What is left is Trove's own convenience, and it is only safe because of what
// that shape guarantees.

/**
 * Obtain several dependency providers at once.
 *
 * NOT released, deliberately: everything in the core graph is a lazy singleton
 * whose `release` is a no-op, and a resource built from these holds them for its
 * own lifetime — releasing would be a lie about a lease nobody is keeping.
 * Anything pooled or ref-counted must be leased properly instead, which is why
 * ScanClaimProvider does its own obtain/release rather than coming through here.
 */
export async function need(providers, names) {
  const out = {};
  for (const name of names) {
    out[name] = await providers[name].obtain();
  }
  return out;
}

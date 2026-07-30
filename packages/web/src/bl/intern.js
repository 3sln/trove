// One instance per logical query.
//
// ngin shares a live query realization by INSTANCE identity — its controller map is keyed on
// the object, and neither the class nor the fields are consulted. That is fine for a query
// with no arguments, which can be a module singleton. It is a trap for a parameterised one:
// `new MediaUrl('n1')` in two places is two realizations of the same question, so two minted
// URLs and two leases for one file, and nothing fails to say so.
//
// So a parameterised query is not constructed. It is asked for:
//
//     class MediaUrl extends SharedQuery { ... }
//     MediaUrl.of(nodeId)     // same nodeId, same instance, one realization
//
// `of` rather than an interning constructor because a constructor that hands back somebody
// else's object still allocates the one it discarded, and `new X()` returning a thing that
// is not a fresh X is a trap for whoever reads the call site next. A named factory says what
// it does.

import { Query } from '@3sln/ngin';

/**
 * Class -> (key -> WeakRef<instance>).
 *
 * Keyed on the class OBJECT, not its name: the web app is bundled, and minification can
 * collapse two class names to one identifier — a name-keyed table would then hand one
 * query's realization to a different query.
 *
 * It also cannot live in a `static #table` on the base, because a private static belongs to
 * the class that declares it: `Subclass.of()` reaching for `this.#table` throws. A module
 * table sidesteps that, and `this` inside a static method is the class it was called on, so
 * subclasses get their own row for free.
 */
const tables = new WeakMap();

/**
 * Eviction, without a policy to get wrong.
 *
 * Entries are weak, and a finalizer sweeps the key once the instance is collected. That is
 * sound because LIVENESS PINS THE INSTANCE: ngin's controller map is a plain Map holding the
 * query as a key, deleted only on teardown, so a query with observers is strongly reachable
 * and cannot be collected. An idle one can be, and re-asking simply builds a fresh instance.
 *
 * The alternative — an LRU with a cap — is actively wrong here: evicting a LIVE entry means
 * the next `of()` mints a second instance while the first is still running, which is the
 * exact bug interning exists to prevent, arriving on a timer.
 *
 * (This leans on ngin's default controller map being strong. `hooks.createQueryControllersMap`
 * could replace it with a weak one; we do not, and a weak one would break this.)
 */
const sweeper = new FinalizationRegistry(({ table, key }) => {
  // Only if it is still the dead entry — a fresh instance may have claimed the key already.
  if (table.get(key) && !table.get(key).deref()) table.delete(key);
});

/**
 * Reject anything a canonical key cannot capture.
 *
 * A function stringifies to `undefined` in JSON, so two queries taking different callbacks
 * would key identically and silently share one realization — the very bug this exists to
 * prevent, reintroduced by the fix. Fail at the call site instead.
 */
function assertKeyable(value, path) {
  const t = typeof value;
  if (value === null || t === 'string' || t === 'number' || t === 'boolean') return;
  if (t !== 'object') {
    throw new TypeError(
      `Query argument ${path} is a ${t}, which cannot be part of a sharing key. ` +
      'Pass an id and let the query look the thing up.',
    );
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertKeyable(v, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    return Object.entries(value).forEach(([k, v]) => assertKeyable(v, `${path}.${k}`));
  }
  throw new TypeError(
    `Query argument ${path} is a ${value.constructor?.name ?? 'non-plain object'}, which ` +
    'cannot be part of a sharing key. Pass an id and let the query look the thing up.',
  );
}

/** A canonical string for a value: object keys sorted, so `{a,b}` and `{b,a}` are one key. */
export function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

/** The default: every argument, in order, canonically. Types are part of it, so 1 ≠ '1'. */
export function keyOfArgs(...args) {
  args.forEach((a, i) => assertKeyable(a, `#${i}`));
  return args.map(stableKey).join('|');
}

/**
 * Adds argument-sharing to a query class.
 *
 * A mixin rather than a base class because the queries that need it already have one —
 * `ServiceQuery` and `ViewQuery` — and single inheritance does not let a class have both.
 *
 *     class ContributionsOfType extends shared(ServiceQuery) { ... }
 *     ContributionsOfType.of('statusItem')
 *
 * There is no guard against calling `new` directly. A constructor guard has to be threaded
 * through every subclass constructor, and it composes badly with a mixin whose base takes
 * its own arguments. What actually prevents direct construction is scope: these classes stay
 * module-private in bl/queries.js and only their `of` wrapper is exported, so a component
 * has nothing to call `new` on.
 *
 * A subclass whose arguments are not canonically stringifiable — or which should share more
 * coarsely than its arguments do, say ignoring a display option that changes nothing about
 * what is fetched — overrides `key`:
 *
 *     static key(nodeId, { preview }) { return nodeId; }   // preview does not affect sharing
 *
 * A KEY rather than a hash-plus-comparator on purpose. A comparator only earns its
 * complexity when keys can collide, and a canonical key does not collide; where equality is
 * genuinely semantic, normalising inside `key` says the same thing in one function instead
 * of two that have to agree.
 */
export function shared(Base) {
  return class Shared extends Base {
    /** Canonical sharing key for these arguments. Override to share more coarsely. */
    static key(...args) {
      return keyOfArgs(...args);
    }

    /** The shared instance for these arguments. */
    static of(...args) {
      const key = this.key(...args);
      let table = tables.get(this);
      if (!table) {
        table = new Map();
        tables.set(this, table);
      }
      const existing = table.get(key)?.deref();
      if (existing) return existing;

      const instance = new this(...args);
      table.set(key, new WeakRef(instance));
      sweeper.register(instance, { table, key });
      return instance;
    }
  };
}

/** The common case: a shared query with no other base. */
export const SharedQuery = shared(Query);

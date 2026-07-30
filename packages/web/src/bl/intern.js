// One instance per logical query.
//
// ngin shares a live query realization by INSTANCE identity — its controller map is keyed on
// the object, and neither the class nor the fields are consulted. That is fine for a query
// with no arguments, which can be a module singleton. It is a trap for a parameterised one:
// `new MediaUrl('n1')` in two places is two realizations of the same question, so two minted
// URLs and two leases for one file, and nothing fails to say so.
//
// So a parameterised query declares a shared factory and is asked for, not constructed:
//
//     class MediaUrl extends ViewQuery {
//       static of = queryOf(MediaUrl);
//       constructor(nodeId) { ... }
//     }
//
//     MediaUrl.of('n1')     // same id, same instance, one realization
//
// A field holding a factory rather than a base class or a mixin, which is what makes this
// small: the query keeps whatever base it already had, each factory closes over its own
// table, and there is no name resolved through a prototype chain for anything to shadow.

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
 * exact bug this exists to prevent, arriving on a timer.
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
 * prevent, reintroduced by the fix. Fail at the call site instead. A query with arguments
 * like that passes its own key function and never comes through here.
 */
function assertKeyable(value, path) {
  const t = typeof value;
  if (value === null || t === 'string' || t === 'number' || t === 'boolean') return;
  if (t !== 'object') {
    throw new TypeError(
      `Query argument ${path} is a ${t}, which cannot be part of a sharing key. ` +
      'Pass an id and let the query look the thing up, or give queryOf a key function.',
    );
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertKeyable(v, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    return Object.entries(value).forEach(([k, v]) => assertKeyable(v, `${path}.${k}`));
  }
  throw new TypeError(
    `Query argument ${path} is a ${value.constructor?.name ?? 'non-plain object'}, which ` +
    'cannot be part of a sharing key. Pass an id and let the query look the thing up, ' +
    'or give queryOf a key function.',
  );
}

/** A canonical string for a value: object keys sorted, so `{a,b}` and `{b,a}` are one key. */
export function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

/** The default key: every argument, in order, canonically. Types count, so 1 and '1' differ. */
export function keyOfArgs(...args) {
  args.forEach((a, i) => assertKeyable(a, `#${i}`));
  return args.map(stableKey).join('|');
}

/**
 * A factory returning the shared instance of `Class` for a given argument list.
 *
 *     class Thing extends ViewQuery { static of = queryOf(Thing); }
 *
 * `key` defaults to the arguments, canonically. Pass one to share more coarsely than the
 * arguments do — an option that changes how something is displayed but not what is fetched
 * should not split one realization into two — or to key arguments the default refuses:
 *
 *     static of = queryOf(Thing, (nodeId, opts) => nodeId);
 *
 * A key rather than a hash plus a comparator: a comparator only earns its complexity when
 * keys can collide, and a canonical key does not collide.
 *
 * The class is captured, so a subclass inheriting this field would build the PARENT —
 * `Sub.of('x')` returning a `Base` is the sort of wrong that reads as right. The factory is
 * a plain function rather than an arrow so that `this` is the class it was reached through,
 * and it refuses to run when that is not the class it was built for. A subclass that wants
 * sharing declares its own `static of`.
 *
 * A detached call — `const of = Thing.of; of('x')` — has no receiver at all, and in a module
 * `this` is `undefined` rather than the global. That is the ordinary way to pass the factory
 * around, so it is allowed; only a DIFFERENT class is an error.
 *
 * @param {Function} Class the query class, referenced from inside its own body
 * @param {(...args: any[]) => string} [key]
 */
export function queryOf(Class, key = keyOfArgs) {
  const table = new Map();
  return function of(...args) {
    if (this !== undefined && this !== Class) {
      throw new TypeError(
        `${this?.name ?? 'A subclass'}.of() would build a ${Class.name}, because \`of\` ` +
        `captures the class it was declared on. Give ${this?.name ?? 'the subclass'} its own ` +
        '`static of = queryOf(...)`, or call it on ' + Class.name + ' directly.',
      );
    }
    const k = key(...args);
    const existing = table.get(k)?.deref();
    if (existing) return existing;
    const instance = new Class(...args);
    table.set(k, new WeakRef(instance));
    sweeper.register(instance, { table, key: k });
    return instance;
  };
}

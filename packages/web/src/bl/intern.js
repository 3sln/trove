// One instance per logical query.
//
// ngin shares a live query realization by INSTANCE identity — its controller map is keyed on
// the object, and neither the class nor the fields are consulted. That is fine for a query
// with no arguments, which can just be a module singleton. It is a trap for a parameterised
// one: `new MediaUrl('n1')` in two places is two realizations of the same question, so two
// minted URLs and two leases for one file, and nothing fails to say so. `watchQuery` keys
// its bridged cells the same way, so it doubles rather than repairs it.
//
// Interning fixes it at the root instead of asking every call site to remember a memo table.
// Same class and same arguments gives back the same instance, so identity means logical
// equality and both caches behave.

/** Class -> (argument key -> instance). Two levels so a bundler mangling class names to the
 *  same short identifier cannot collide two different queries into one. */
const byClass = new Map();

/**
 * Reject anything whose identity a string key cannot capture.
 *
 * A function stringifies to `undefined` in JSON, so two queries taking different callbacks
 * would key identically and silently share one realization — the exact bug this exists to
 * prevent, reintroduced by the fix. Better to fail at the call site.
 */
function assertKeyable(value, path) {
  const t = typeof value;
  if (value === null || t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
    throw new TypeError(
      `Query argument ${path} is a ${t}, which cannot be part of a sharing key. ` +
      'Pass an id and let the query look the thing up.',
    );
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertKeyable(v, `${path}[${i}]`));
  if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    return Object.entries(value).forEach(([k, v]) => assertKeyable(v, `${path}.${k}`));
  }
  throw new TypeError(
    `Query argument ${path} is a ${value.constructor?.name ?? 'non-plain object'}, which ` +
    'cannot be part of a sharing key. Pass an id and let the query look the thing up.',
  );
}

/** Object keys in a stable order, so `{a,b}` and `{b,a}` are one key rather than two. */
function stableKey(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
}

/**
 * The shared instance of `Class` for these arguments.
 *
 * Instances are retained for the life of the page. They are small and inert — ngin evicts
 * the controller when the last observer leaves, releasing the lease and whatever the query
 * held — so what is kept is the argument-sized object, not the realization. Worth revisiting
 * if a query is ever keyed by something unbounded and long-lived.
 *
 * @param {Function} Class a Query subclass
 * @param {...any} args must be primitives, or plain objects/arrays of them
 */
export function queryFor(Class, ...args) {
  args.forEach((a, i) => assertKeyable(a, `#${i}`));
  let forClass = byClass.get(Class);
  if (!forClass) {
    forClass = new Map();
    byClass.set(Class, forClass);
  }
  const key = args.map(stableKey).join('|');
  let instance = forClass.get(key);
  if (!instance) {
    instance = new Class(...args);
    forClass.set(key, instance);
  }
  return instance;
}

# 009 — The web layer should go through the engine, not around it

The browser has two systems. There is the ngin engine — actions, queries, providers,
leases — and beside it a hand-built layer of services holding cells, a `platform` bag of
subsystems, an `app` bag of reactive stores, and one derived snapshot threaded through
every component. The second was written around the first.

This is not a style objection. The first concrete cost was found and fixed already: `exec`
called the command service directly, so every command a user ran from the UI went AROUND
the engine, invisible to interceptors and hooks. That was one symptom of the arrangement,
not an isolated bug.

## What ngin already provides

Read `node_modules/@3sln/ngin/src/queries.js` before starting. Everything the sidecar layer
implements by hand is there:

- **`QueryController`** — "one live realization of a query instance, shared by all of its
  observers", with an observer set and `notify(nextValue)`. That is the cell layer.
- **`boot()` / `kill()`** — a query starts producing when its first observer arrives and
  tears down when the last leaves. That is the lifecycle a minted media URL wants: acquire
  while someone is looking, release when nobody is.
- **`#lease`** — a query holds provider resources for its life and releases them on kill.
- **`fetch()`** — a one-shot fallback, so a consumer subscribes without knowing whether the
  query is live or a single read.

And the bridge to the render layer exists: `runtime.js` exports `fromObservable`, which
adapts `subscribe({next, error, complete})` — exactly what `engine.query()` returns — into
dodo's Cell protocol, which is what `watch` takes.

## The rule: a query emits a view, an action carries an id

Stated after phase 1, because the first cut got it half right and the distinction is the
whole design.

A query emits a **view**: plain data, every decision already made, nothing callable. The
palette's command list is a list of *descriptions* — id, title, keybinding label, whether it
is enabled right now — not the command objects, and never a `handler`. The plugin list is
records, not plugin handles.

Interaction goes back the other way: an **action carrying the thing's id**.
`ExecCommandAction('explorer.upload')`, `UninstallPluginAction(id)`. A component renders
what it was given and dispatches an id.

The test is mechanical, and there is one in the suite that applies it: walk the emitted
value, and if anything in it is a function, the query has handed out a handle. A component
holding a handle is reaching around the engine again — which is the thing this ticket
exists to stop.

### Identity, and why instances are interned

ngin shares a live realization by INSTANCE identity: `#controllers` is a Map keyed on the
object, and neither the class nor the fields are consulted. `watchQuery` keys its bridged
cells the same way.

For a parameterless query that is fine — export a singleton. For a parameterised one it is a
trap: `new MediaUrl('n1')` in two places is two realizations of the same question, so two
minted URLs and two leases for one file, and nothing fails to say so. "Remember to memoise
at each call site" is not a defence, because forgetting is silent and it is exactly the
parameterised queries that are worth sharing.

So a parameterised query is not constructed, it is asked for: `SomeQuery.of(...args)` gives
back the same instance for the same arguments, which makes identity mean logical equality and
lets both caches behave.

`of` rather than an interning constructor: a constructor that hands back somebody else's
object still allocates the one it discarded, and `new X()` returning a thing that is not a
fresh X is a trap for whoever reads the call site next.

A mixin, `shared(Base)`, rather than a base class — the queries that need it already extend
`ServiceQuery` or `ViewQuery`, and single inheritance does not allow two bases. The table is
keyed on the class OBJECT rather than its name, since minification can collapse two class
names to one identifier; it also cannot be a `static #table` on the base, because a private
static belongs to the class that declares it and `Subclass.of()` reaching for it throws.

**`key` is static, and that is forced.** The key is needed BEFORE there is an instance —
that is what makes the lookup worth doing. `get key()` would mean constructing to find out
whether construction was necessary: the interning constructor again, discarding the object on
every cache hit and re-running whatever the constructor does.

Writing it as `get key()` anyway is silently wrong rather than broken — the inherited static
wins, the getter is never consulted, and two instances share one realization with nothing to
show for it. `of` refuses a `key` found on the prototype for that reason.

**`normalize`, because a key from raw arguments can lie.** A constructor that fills in a
default makes `of('x')` and `of('x', {limit: 20})` two keys for one query — a false split,
which is the bug interning exists to prevent, reachable through the defaulting the
constructor was going to do anyway. Normalising inside `key` would fix it and reintroduce
"two functions that have to agree", which is the objection to a comparator restated. So
`static normalize(...args)` runs once and feeds both the key and the constructor, and the
instance's state matches its key by construction.

**A key, not a hash plus a comparator.** A comparator only earns its complexity when keys can
collide, and a canonical key does not collide. Where equality is genuinely semantic — an
argument that changes how something is displayed but not what is fetched — `static key()` is
overridden to normalise, which says it in one function rather than two that have to agree.
Default arguments must be primitives or plain objects/arrays of them: a function stringifies
to `undefined` in JSON, so accepting one would key two different queries identically, which
is the original bug reintroduced by the fix. It throws instead. A custom `key` sidesteps the
check, because it never stringifies the argument.

**Eviction: weak, swept by a finalizer.** Entries are `WeakRef`s and a `FinalizationRegistry`
removes the key once the instance is collected. That is sound because LIVENESS PINS THE
INSTANCE — ngin's controller map is a plain `Map` holding the query as a key, deleted only on
teardown, so a query with observers is strongly reachable and cannot be collected. An idle
one can be, and re-asking simply builds a fresh instance.

An LRU with a cap would be actively wrong: evicting a *live* entry means the next `of()`
mints a second instance while the first is still running — the exact bug interning exists to
prevent, arriving on a timer. (This does lean on ngin's default controller map being strong.
`hooks.createQueryControllersMap` could replace it with a weak one; we do not, and a weak one
would break this.)

There is no guard against calling `new` directly. Threading one through every subclass
constructor composes badly with a mixin whose base takes its own arguments, and scope already
does the job: the classes stay private to `bl/queries.js` and only instances leave it.

ngin also exposes `hooks.createQueryControllersMap` for custom keying, which is where this
could live instead. Interning was chosen because it is the layer where the problem actually
is: two instances are two realizations no matter what the layer above does.

`watchQuery`'s cache was originally justified as preventing this, and that was wrong.
Measured: two independent bridges over one instance boot the query once and kill it once,
because ngin shares by instance and does not care how many observers arrive. The cache buys
idempotence — so calling `watchQuery` in a render does not make `watch` resubscribe every
pass — and one invalidation fan-out per change instead of one per bridge. Both are
worthwhile; neither is correctness, and the safeguard against duplicate realizations is
interning.

What this buys, concretely: the status bar used to call `context.evaluate(item.when)` and
`plugins.isAvailable(item)` per item, mid-render. Those are view decisions, so they moved
into the `statusItems` query, and the component stopped needing `platform` at all. That is
the general shape of how `platform` leaves the components — not by being passed differently,
but by the decisions it was consulted for moving to the query side.

Two things a view query has to get right:

- **Depend on more than it reads.** `enabled` is decided from the context keys, so a
  command view that only watched the contribution registry would go stale the moment a
  selection changed — still showing a command as available after the thing it acts on was
  deselected. `ViewQuery` takes its sources and its projection separately for that reason.
- **Plain is not the same as safe.** A status item's `html` is untrusted plugin markup. It
  is still sanitised where it becomes nodes.


## Where everything goes

| today | becomes |
|---|---|
| `app.explorer`, `app.search`, `app.transfers`, `app.activity`, `app.social`, `app.offline`, `app.apiKeys` | live **queries** |
| `platform.settings`, `platform.contributions`, `platform.keybindings`, `platform.context`, `platform.capabilities`, the plugin list | **queries** |
| `platform.workbench.showDialog()`, `notifications.error()`, plugin install/uninstall, `openPluginPanel` | **actions** |
| `platform.mediaUrls` | a **query** that mints on boot and releases on kill |
| `platform.api` | a provider — the thing queries and actions are built from, not something a component holds |
| `platform.reactive` | stays, and moves to `ui` — genuinely neither |
| the 18-cell `derive` snapshot, `state` threaded through every component | **gone**: each component subscribes to what it reads |

## What this subsumes

**003 phase 3.** The single snapshot is why any change rebuilds the whole tree. Per-component
subscription is not a separate optimisation afterwards; it is what this leaves behind.

**The factory-closure decision in 003.** `component(ui) => (state) => vnode` assumes a
snapshot handed in. A component that subscribes to its own queries has a different shape, so
converting 20 components to factories first would be work thrown away. Do not start it.

## One constraint that shapes the code

`#controllers` is keyed by **query instance identity**, so `new Explorer()` twice is two
realizations and no sharing. Parameterless queries want module-level singletons;
parameterised ones want memoising by their arguments. Getting this wrong does not fail — it
quietly boots a second copy of everything.

## Phases

Strangler-fig, because a single change here is not reviewable and not revertible.

1. **The query layer alongside.** Query classes over the existing services, singleton
   instances, and a `watchQuery` helper bridging to dodo. Nothing in the UI changes; the
   suite stays green. Provable by tests that a query is live, is shared between subscribers,
   and tears down on the last unsubscribe.
2. **Convert components region by region.** Each region stops taking `state` and subscribes
   to the queries it reads. The snapshot shrinks as regions leave it.
3. **Actions for the imperative surface.** `showDialog`, notifications, plugin management.
4. **Delete the services** once nothing reads them, and with them `app`, most of `platform`,
   `go`, `exec`, and the snapshot.

## Notes

- Verify in a **visible** browser tab; a hidden one throttles rAF and a stalled render looks
  exactly like a broken one.
- `platform.capabilities` is assigned after boot and is not reactive today — as a query that
  problem disappears, along with `workbench.touch()`.
- Each phase commits on its own. If phase 2 stalls halfway, a half-converted tree still runs.

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

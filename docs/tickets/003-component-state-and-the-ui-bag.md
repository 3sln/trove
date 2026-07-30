# 003 — Component state, render granularity, and the `ui` bag

> **Phases 1 and 2 are done.** `ui.rerender`, the `bump` cell, the shallow-equality
> exception, `ui.engine` and `ui.uninstallPlugin` are all gone; component-local state lives
> in `ui/localState.js`. What is left is the open decision below and phase 3.

Three findings that look like three problems and are mostly one: state the workbench needs
lives outside the reactive graph, and the machinery built to compensate is what the `ui` bag
mostly carries.

Take them in the order below. The first deletes machinery, the second relocates it, and the
third is a different scale of change that only becomes tractable once the first two are done.

---

## The shape today

Every component in the workbench is a pure function of `(state, ui)`. `ui` is assembled once
in `ui/compositions/workbench.js` and threaded as an explicit argument through 14 modules —
not a factory closure, not per-instance state; a parameter, passed on every call of every
component on every render.

```js
const ui = {
  engine, app, platform,
  go: (action) => engine.dispatch(action),
  exec: (id, ...args) => platform.commands.execute(id, ...args),
  rerender: () => bump.update((n) => n + 1),
  uninstallPlugin: (id) => plugins?.uninstall(id),
};
```

What is actually used, across `packages/web/src/ui/`:

| member | uses | notes |
|---|---|---|
| `ui.platform` | 81 | |
| `ui.exec` | 46 | |
| `ui.app` | 32 | |
| `ui.go` | 12 | |
| `ui.rerender` | 5 | in **3** of the 14 modules |
| `ui.uninstallPlugin` | 1 | one call site, carried through all 14 |
| `ui.engine` | **0** | passed everywhere, referenced nowhere |

---

## Done: phases 1 and 2

`ui/localState.js` holds state a component owns that still has to reach the render — the
keybinding mid-capture, the unsubmitted collection form, the ticked plugin capabilities.
Each was a module-level `let` mutated in place, which is why a `rerender()` hook had to be
threaded through fourteen modules: the leaf that changed something had nothing to
invalidate, so it poked the root through a function passed as an argument.

With those in a cell, the write invalidates, the snapshot recomputes, and the render happens
for the same reason every other render happens. That deleted `rerender` from the bag, the
`bump` cell, and the exception in the snapshot that existed purely so `watch`'s
shallow-equality check would not discard a forced render as "nothing changed".

`ui.engine` is gone — it reached fourteen modules and was read by none. `uninstallPlugin`
is an action; it had one call site and was carried the whole way down to reach it. The
`plugins` shim that existed only to build it went with it.

One thing worth keeping in mind for anything similar: the plugin review's ticked
capabilities were a `Set` mutated in place, and writing a mutated object back to a cell is
a no-op — a cell compares with `Object.is` and correctly drops a write of what it already
holds. It is an array now, replaced rather than mutated. The old design needed `rerender`
partly *because* it mutated; fixing one without the other would have looked like the
reactivity was broken.

## Still open: what `ui` should be

`ui` now carries `app`, `platform`, `go` and `exec`. `go` and `exec` are how a component
asks for something to happen; `app` and `platform` are how it reaches the services it
renders from — 81 and 32 uses respectively.

Three shapes, and this is a judgement call rather than a defect:

1. **Keep the parameter.** It is now honest: four members, all used, none of them a
   workaround. Smallest thing that could be right.
2. **Factory per component**, the way dodo builds a `special()`: `const bar = activityBar(ui)`
   once at composition, `bar(state)` per render. Components close over what they need and
   stop taking a second parameter. The shape the rest of the stack already uses.
3. **Context** — dodo has one. Least ceremony at call sites, most indirection.

`exec` has 46 call sites, so 2 and 3 are real diffs. Worth deciding deliberately rather than
drifting into one.

## Phase 3 — Render granularity

The workbench is **one** `watch` over a `derive` of 18 cells: workbench, overlay, nav,
explorer, search, apiKeys, transfers, notifications, context, settings, plugins, statusItems,
social, offline, activity, viewport, voice, and `bump`. Any change to any of them rebuilds
the entire workbench VDOM — activity bar, status bar, launcher, every overlay, the transfer
tray, all of it.

Confirmed by inspection rather than inference: walking the live DOM for dodo's watch symbol
finds exactly one element carrying it. The only other watches are inside openers
(`openers/index.js`, `openers/markdown.js`), which are correctly isolated per opener.

The DOM update is not wasteful — dodo reconciles, so a progress tick patches one text node.
The **rebuild** is: on a 500-item list, every upload progress tick reconstructs 500 rows to
change one number. Three things soften it — `derive` coalesces many invalidations in a frame
into one render, `watch` skips shallow-equal snapshots, reconcile diffs the DOM — so this is
not pathological. But nothing lets a component subscribe to only what it reads.

Worth measuring before rebuilding. The candidates are per-region watches (the file list, the
transfer tray and the status bar as separate subscriptions) rather than one snapshot of
everything. This is a materially larger change than phases 1 and 2 and could reasonably
become its own ticket if it grows.

---

## Notes

- Verify in a **visible** browser tab. A hidden tab throttles `requestAnimationFrame`, so
  dodo's scheduler queue never drains — which presents exactly like a frozen render tree
  with correct state and no console error. This cost real time once already.
- A component that throws during reconcile can leave the tree stale with no error surfaced,
  so a render refactor wants clicking through, not just a green suite.

## Done when

`ui.rerender` and the `bump` cell no longer exist, command execution and plugin management
are reachable from the engine, `ui.engine` is gone, and there is a decision recorded on
whether the remaining `platform`/`app` access stays a parameter, becomes a factory, or
becomes a context.

# 003 — Component state, render granularity, and the `ui` bag

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

## Phase 1 — Delete `rerender` by putting the state in cells

All five `rerender` call sites are the same bug, not five different needs. Each is
component-local state deliberately held outside the reactive system, mutated in place, then
needing a manual nudge:

- `ui/components/overlays.js:110` — `colState.form`, a plain object mutated by the collection
  dialog's field handlers; nudged when the storage driver changes because that changes which
  fields render
- `ui/components/settingsView.js:401,431,448` — `capturing`, a bare variable tracking which
  keybinding is mid-capture
- `ui/components/pluginReview.js:23` — `sel.grants`, a `Set` mutated in place as capabilities
  are ticked

`platform.workbench.touch()` is the same shape one level up: `platform.capabilities` is
assigned onto a plain object when it arrives after boot, so nothing invalidates, and the
status bar reads it.

### Why this is the root and not a detail

Rendering happens in exactly one place (see phase 3). A leaf that mutates state outside the
graph has no way to reach that place, because there is nothing to invalidate — so it reaches
up through a manually threaded callback instead. Data flows down and invalidation flows *out
of band*, which is the inversion the reactive layer exists to prevent.

The tell is in the composition. `bump` is a cell whose only purpose is to make manual
re-renders work, and it is deliberately smuggled into the derived snapshot:

> `_bump` is IN the snapshot, unlike before. `watch` skips a render whose value is
> shallow-equal to the last one, so a forced re-render that left no trace in the object
> would be discarded as "nothing changed" — which is the opposite of what asking for one
> means.

That is a counter added to the state snapshot to defeat an optimisation designed to skip
unnecessary renders. The design is working around itself.

### The change

Put those three pieces of state in cells. Then:

- `rerender` leaves the bag
- the `bump` cell goes
- the exception in the shallow-equality check goes
- the single render point does not move; the trigger simply travels as data

Deletes machinery rather than relocating it, and is provable by the suite staying green.

---

## Phase 2 — Move dispatch onto the engine

`exec`, `go` and `uninstallPlugin` are not render concerns. Running a command and
uninstalling a plugin are the engine's business and reachable from anywhere holding it;
threading them through the render tree means every component that wants to run a command
takes a parameter it passes to children that pass it to theirs. `uninstallPlugin` is the
clearest case — one call site, carried through fourteen modules.

`eng.dispatch(new ExecCommand(id, ...args))` is the right shape. One caveat: `execute` is
`async` and returns the handler's value, so dispatch has to preserve that or callers that
await a result break.

**`RenderApp` as an action is the wrong shape**, for two reasons. Rendering is not domain
logic, so dispatching it makes the business layer know about presentation. More importantly
it would give the workaround a nicer address instead of removing the need for it — after
phase 1 there is nothing left to dispatch. A `RenderApp` action would be a permanent home
for a temporary problem.

Drop `ui.engine` at the same time; nothing reads it.

That leaves `platform` (81) and `app` (32), which are how a component reaches the services it
renders from. Three options, and this is the real decision:

1. **Keep the parameter, shrunk** to `{ platform, app, rerender? }`. Smallest diff.
2. **Factory per component**, the way dodo builds a `special()`: `const bar = activityBar(ui)`
   once at composition, `bar(state)` per render. Components close over what they need and
   stop taking a second parameter. The shape the rest of the stack already uses.
3. **Context** — dodo has one. Least ceremony at call sites, most indirection.

---

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

- No behaviour change in phases 1 and 2, so both should be provable by the suite staying
  green rather than by inspection.
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

# 003 — Move dispatch out of the render bag

Every component in the workbench is a pure function of `(state, ui)`, and `ui` is a bag
assembled once in `ui/compositions/workbench.js`:

```js
const ui = {
  engine, app, platform,
  go: (action) => engine.dispatch(action),
  exec: (id, ...args) => platform.commands.execute(id, ...args),
  rerender: () => bump.update((n) => n + 1),
  uninstallPlugin: (id) => plugins?.uninstall(id),
};
```

It is built once and then threaded as an explicit argument through 14 modules of render
code. Not a factory closure, not per-instance state — a parameter, passed on every call of
every component on every render.

## What is actually in it

| member | uses in `ui/` |
|---|---|
| `ui.platform` | 81 |
| `ui.exec` | 46 |
| `ui.app` | 32 |
| `ui.go` | 12 |
| `ui.rerender` | 5 |
| `ui.uninstallPlugin` | 1 |
| `ui.engine` | **0** |

`ui.engine` is carried everywhere and referenced by nothing. That alone says the bag grew
by accretion rather than by design.

## The split worth making

Two different things are in here and only one of them has anything to do with rendering.

**Dispatch** — `exec`, `go`, `uninstallPlugin`. Running a command and uninstalling a plugin
are not render concerns; they are the engine's, and they are reachable from anywhere that
holds the engine. Threading them through the render tree means every component that wants
to run a command takes a parameter it passes to children that pass it to their children.
Plugin management is the clearest case: one call site, carried through fourteen modules.

**Render** — `rerender`, and direct access to state the components read. These genuinely
belong close to the tree: `rerender` exists because some state lives outside a cell
(`platform.capabilities` is read by the status bar and arrives after boot), and a component
needs a way to say "this changed under you". That is a render-layer concern and should stay
one.

`platform` and `app` are the awkward middle: they are read constantly, and they are how a
component reaches the services it renders from. Worth deciding whether those stay in the bag
or become a context (dodo has one) rather than a parameter.

## Options

1. **Keep the parameter, shrink it.** Drop `engine`, move `exec`/`go`/`uninstallPlugin` onto
   the engine and reach them from there. Smallest change; the bag survives.
2. **Factory per component**, the way dodo builds a `special()`: `const bar = activityBar(ui)`
   once at composition, then `bar(state)` per render. Components close over what they need
   and stop taking a second parameter. Bigger diff, and the shape the rest of the stack
   already uses.
3. **Context.** dodo has one; components pull what they need rather than being handed it.
   Least ceremony at the call sites, most indirection.

Worth doing 1 regardless, since it is nearly free and removes dead surface. 2 and 3 are the
real decision.

## Notes

- This is a refactor of render plumbing with no behaviour change, so it should be provable
  by the suite staying green rather than by inspection.
- Watch the render-freeze class of bug while doing it: a component that throws during a
  reconcile can leave the tree stale with correct state and no console error. Verify in a
  **visible** browser tab — a hidden one throttles `requestAnimationFrame` and the
  scheduler queue never drains, which looks exactly like a frozen render.

## Done when

`ui` carries only what the render layer needs, command execution and plugin management are
reachable from the engine, and `ui.engine` is gone.

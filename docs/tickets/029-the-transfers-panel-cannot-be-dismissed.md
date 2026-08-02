# 029 — the transfers panel cannot be dismissed while it is doing something

`transferTray` (`ui/components/overlays.js:373`) opens on `state.tr.items.length` and has
no close: the only control is "Clear finished", which by definition cannot remove a
transfer that is still running. So the panel sits over the drive for the whole of a large
upload, which is exactly when someone wants to keep using the drive.

There is a second, smaller thing — a status-bar affordance that toggles while uploads are
in progress — so the two need to be told apart and made consistent.

## What to do

1. **The tray can be closed**, running transfers or not. Closing it stops nothing: it is a
   view of the work, not the work.
2. **It can be reopened**, from the status bar. That affordance should be present whenever
   there is anything to look at, not only while something is active — a failed upload from
   two minutes ago is the case where someone most wants the panel back.
3. **A command toggles it**, so it is reachable from the palette and bindable.

## Notes

- Decide what a *new* transfer does to a closed tray. Re-opening it on every upload undoes
  the dismissal the user just made; never re-opening loses the only signal that something
  started. The status-bar affordance changing state is probably the right middle, and is
  the thing to get right rather than the panel itself.
- Dismissal should not survive a reload as a permanent preference — it is about the
  transfers on screen now.

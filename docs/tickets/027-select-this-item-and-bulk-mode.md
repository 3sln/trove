# 027 — "Select this item", and a bulk mode worth having

There is a `selection` in state (`bl/state.js:51`, plus `selectionNodes`) and actions that
act on it, but no way to *build* one from a single item — so the selection exists mainly
as a thing other code reads, not a thing a person makes.

## What to add

Each item's context menu gets **Select this item**. Choosing it:

1. Puts the view into **selection mode**, and
2. Selects that item.

In selection mode each row/tile's `⋯` affordance **is replaced by its checkbox**, so the
thing under the cursor is the thing being toggled — rather than a checkbox appearing
somewhere else while `⋯` stays put and means something different now.

The per-item action menu moves to **the top of the list** as a bar over the selection: the
actions there apply to everything selected, which is a different verb from "act on this
one" and should not live in the same place.

## Notes

- Leaving the mode should be obvious and cheap — an explicit Done/×, and Escape. A mode
  you cannot see the edges of is worse than no mode.
- The bar's actions are the ones that make sense over many items (download, delete, tag,
  keep offline). Anything single-item — rename, open with — should not appear there rather
  than appearing and being disabled.
- Empty selection is a state to design, not an accident: selecting nothing and then
  pressing Delete must do nothing visible, and the bar should say what is selected.
- Check what already reads `selection`/`selectionNodes` before adding a second concept.
  `selectedNodesOf` is the existing read path and the mode should feed it, not shadow it.

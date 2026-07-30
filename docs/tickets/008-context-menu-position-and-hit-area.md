# 008 — Context menu jumps on open, and its rows do not fill the menu

Two independent defects in the same component (`ui/components/overlays.js`, `contextMenu`).

---

## 1. The menu appears, then snaps to the right

Not a missing transition. One animation hardcodes a *positioning* offset into its end state,
so every element using it must coincidentally need that exact offset — and only one does.

`styles.css`:

```css
@keyframes pop { from { opacity: 0; transform: translate(-50%, -6px) scale(.98); }
                 to   { opacity: 1; transform: translate(-50%, 0) scale(1); } }
```

The `-50%` is the command palette's horizontal centring, which it needs because it sits at
`left: 50%`. `animation-fill-mode` is the default `none`, so when the animation ends the
transform reverts to the element's own — and anything whose own transform is not exactly
`translate(-50%, 0)` jumps by the difference.

Five elements use it. Four are wrong:

| element | its own transform | what happens |
|---|---|---|
| `.palette` | `translateX(-50%)` | correct — the only one that matches |
| `.dialog` | `translate(-50%, -50%)` | **jumps down** by half its height (the keyframe drops the Y centring) |
| `.menu` | none | **jumps right** by half its width — the reported bug |
| `.plugin-panel` | none | jumps right |
| `.inbox` | none (`left: calc(…)`) | jumps right |

So the context menu is the one that was noticed, and the dialog has been dropping half its
own height on every open the whole time.

### Fix

Make the animation transform-neutral and stop it carrying anyone's layout:

```css
@keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.98); }
                 to   { opacity: 1; transform: none; } }
```

Then the centred elements need their centring back, and the clean way is the standalone
`translate` property rather than `transform` — the two compose independently, so layout
offset and animation stop fighting over one slot:

```css
.palette { left: 50%; translate: -50% 0; }
.dialog  { left: 50%; top: 50%; translate: -50% -50%; }
```

That removes the whole class rather than patching the one instance, which matters because
the next element to reuse `pop` would inherit the same bug.

## 2. Rows size to their content instead of filling the menu

`.menu .mi` is a `<button>` with `display: flex` and no width. Form controls compute
`width: auto` as fit-content rather than stretching the way a block does, so each row is
only as wide as its icon and label — and `.mi:hover` paints that shrunken box, so the hover
target visibly hugs the text instead of spanning the menu.

The intent is already recorded elsewhere in the same rules:

```css
.menu .mi .kbd { margin-left: auto; }
```

Pushing the shortcut to the far right can only work on a full-width row, so that is broken
too and by the same cause.

### Fix

```css
.menu .mi { width: 100%; box-sizing: border-box; }
```

### The rule worth writing down

A vertically flowing list item should fill its container horizontally — the hit area is the
row, not the words in it. Items laid out **horizontally** (a row of icon buttons; none exist
today) may size to content. This applies to the command palette's `.opt` and anything else
built the same way, so it is worth checking rather than fixing one instance.

---

## Notes

- Both are CSS-only; no component logic changes.
- Four elements move as part of this, so it wants clicking through all five — palette,
  dialog, context menu, plugin panel, inbox — rather than just the menu that was reported.
- Verify in a **visible** browser tab. A hidden one throttles `requestAnimationFrame`, which
  will make an animation look broken in ways that have nothing to do with this.
- Worth an eye on the position clamp while in here: `x` is clamped against a hard-coded
  `window.innerWidth - 220` while `.menu` only sets `min-width: 200px`, so a menu with long
  labels can still overhang the right edge. Separate defect, same component.

## Done when

The menu appears where it will stay, the dialog stops dropping half its height, and a row's
hover area spans the menu.

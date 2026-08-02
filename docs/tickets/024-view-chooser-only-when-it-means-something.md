# 024 — the view chooser should only appear when it means something

The grid/list toggle in the search bar is drawn unconditionally. It should be drawn when
switching views is a choice someone actually has, and not otherwise.

## Two conditions, both required

1. **More than one view can render this result set.** Views are contributed (built-in and
   plugin alike) and each carries a selector, so "which views can draw these results" is
   already an answerable question — `views` in the workbench composition resolves them.
   One view means no choice, and a control with one option is furniture.

2. **The results are items.** The launcher is one input over several kinds of search:
   `!` runs a command, `#` filters by tag, plain text searches files. A grid/list toggle
   over a list of *commands* is meaningless — there is no second way to draw them, and
   offering one implies the results are something they are not.

## Where it lives

- `packages/web/src/ui/components/views/` — the view registry and the built-ins.
- The chooser is rendered from the search bar; `workbench.js` already watches
  `q.views`, so the count is in scope where the decision belongs.
- `bl/openers.js` has the shape to copy: `openersFor(openers, node)` filters contributed
  things by selector against what is actually being shown, and the opener chooser only
  asks when more than one matches. Same rule, different registry.

## Notes

- Hiding it must not lose the user's preference. Someone who chose grid, then runs a
  command search, should still be in grid when they go back to files — the control
  disappearing is not the same as the setting resetting.
- Worth checking what the toggle does today when a plugin contributes a third view: if the
  control is a two-state switch rather than a picker, it is already wrong for that case,
  and this ticket is the moment to find out.

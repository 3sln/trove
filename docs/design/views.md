# Views, and why plugins cannot contribute one

A `view` decides how a *list* of items is drawn — rows, a gallery, a map. An opener
renders one file; a view renders the results.

Views are a **host-side** extension point: the built-ins, plus whatever a build passes to
`createWorkbench({ views })`. A manifest that declares `"type": "view"` does not install.
This records why, so the question doesn't get re-opened from scratch — and what would
have to be true to change the answer.

## The contract is a vnode, and that is fine *because* it is host-only

```
render({ groups, index, handlers, state, ui }) -> vnode
```

A dodo vnode is not serializable, so this contract cannot cross a frame boundary. That
would be a problem if plugins were the audience. They are not: a view is in-process code
either way, so a serializable contract would buy a portability nobody could use and cost
the group headers their host-owned buttons (below). The two decisions hold each other up
— if plugin views ever happen, they get a *different* protocol, not this one bent into
shape.

## What made plugin views the wrong trade

Not the sandbox mechanics. Those are already solved: a plugin opener runs in a
host-owned `position: fixed` iframe that tracks a host element's box
(`pluginOpenerView` → `mountViewer`), so "fill the results area and scroll yourself" is
the same machinery with `overflow: hidden` on the container instead of `auto`. The frame
has no inherent height and doesn't need one — it is given the host's box.

The problems are what the results area *is*:

**1. It contains the host's own controls.** A group header carries `group.action`:
Upload, Empty trash, Retry, and the "Show more" row. Those are host vnodes bound to host
commands. Across a frame they can only be described, not handed over — so the plugin
decides where the Upload button goes, whether it is there at all, and what it is called.
On a phone and a TV, the header is the *only* route to upload. A view that omits it
takes a working feature off the screen, and nothing about the page looks broken.

**2. It is where the selection comes from.** Moving the highlight is selecting
(`syncSelection`), and `explorer.delete` acts on the selection. If a view reports what is
selected, a buggy or hostile one can arrange for the user's next Delete keystroke to hit
files they never picked. The confirm dialog is host-drawn and names real files, which is
a genuine backstop — but an opener has nothing comparable to abuse, because it only ever
holds one file that the user opened on purpose.

**3. The content problem is unsolved.** A gallery needs pixels for hundreds of files. A
plugin has no network egress and gets package resources as opaque handles, so every
thumbnail would have to be brokered over a `MessagePort`. There is no thumbnail service
yet, so that is hundreds of full-size originals through a message channel.

**4. Nobody has asked.** No plugin wants this. The cost above is being paid against a
hypothetical.

### HTML instead of a frame?

Considered and rejected. Sanitized HTML is what a `statusItem` gets, and it works there
because a status item is a label. A view is interactive: hover, select, activate, a
context menu per row, scroll-into-view for the highlight. Sanitized HTML is either inert
— in which case it cannot be a view — or it carries script, in which case it is an
unsandboxed frame with extra steps.

## What would have to be true to revisit

Roughly, in this order:

1. **Group headers move to the host.** The host draws the header and its actions; the
   view draws only the items of each group, in a box the host gives it. That alone kills
   problem 1, and it is a change worth making even for host-side views.
2. **The host validates selection.** A view reports selection as ids, and the host
   accepts only ids it handed to that view in the current render. Turns problem 2 from a
   trust question into an arithmetic one.
3. **A thumbnail service.** Views ask for `thumbnail(nodeId, size)` and get a small
   image; the same endpoint the built-in grid should be using anyway (it currently leans
   on `loading="lazy"` and full-size originals, which is honest but not free).
4. **A real asker.** A plugin that wants a view badly enough to describe what it needs.

Until (4), the rest is speculative work.

## Enforcement

Two checks, guarding different doors, both derived from one list
(`TYPES[t].hostOnly` in `@trove/core/plugins/contributions.js`):

- `declaredContributions` throws `INVALID` on a host-only type, so a package that
  declares a view **fails to install** rather than installing with the view ignored.
- `ContributionRegistry.register` refuses a host-only type that carries a `pluginId` or
  sits outside the reserved `core` domain — the registry being what the launcher reads.

The second is not redundant. The first is about packages; the second is about anything
at all that reaches the registry.

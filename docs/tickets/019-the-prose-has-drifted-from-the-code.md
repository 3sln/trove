# 019 — The prose has drifted from the code

The audit's most striking observation, and the reason it was possible at all:

> *"in roughly a dozen cases the codebase has already convicted itself in writing and then
> left the defendant in place."*

The comments here are unusually good and were trusted accordingly — eight lenses spent most
of their effort being talked out of findings by comments that had already answered them.
That is exactly why a stale one is expensive: a wrong comment in this codebase is believed.

## The findings

### The API-keys settings section dispatches from inside a render behind a latched module flag

`web/src/ui/components/settingsView.js:186` · high

Three independent lenses landed on this, and the codebase already convicted it in prose: bl/queries.js:174 names it by name — 'the alternative, which the API-keys section still does, is to dispatch from inside a render behind a module-level "have I asked yet" flag, which is a render with a side effect.' The flag is module state outside the engine's reach and nothing resets it. Two real consequences the lenses each half-found: `LoadApiKeysAction`'s catch sets `loaded: true` with `error` set and empty keys, and line 201 returns null when `!keys.loaded`, so one transient failure renders the section blank with no message and no retry (`keys.load` is `palette: false`, so it is not user-reachable either); and a second `createWorkbench` on the page — a documented embedding entry point — finds `keysRequested === true` against a fresh slice and never loads at all.

**Fix** — Give the apiKeys query a `bootAction = new LoadApiKeysAction()` exactly as `RotationView` does at queries.js:190, hold the lease at the settings region rather than the workbench root, and delete `keysRequested` and the dispatch block. Separately stop setting `loaded: true` in the catch — `loaded` and `error` are different facts.

### The encryption comments describe a removed design — a passphrase, KDF material in describe(), and a key handed to the client

`core/src/collections/index.js:226` · medium

This is the finding the audit rules make hardest to dismiss, because the standing rule is that a stated reason wins — and here five stated reasons describe a system that no longer exists, in the subsystem where being wrong is most expensive. `describeEncryption` returns `{ enabled, fingerprint, rules }` — no salt, no KDF params — while the comment above it explains why the salt and KDF parameters are safe to hand out. Four more comments (policy.js:22, :100, collections/index.js:120, keys.js:6) say the key reaches a client with a transfer plan; uploads.js:322 records that trade being taken off and `#planEncryption` returns `sealedBy: 'server'`. Every `dataKeyFor` call site is server-side. The real invariant — its result must never be serialised — is unstated and actively contradicted.

**Fix** — Rewrite the describe() comment to say what is actually returned and why it is safe (a fingerprint names a key without being it). Rewrite the describeEncryption/dataKeyFor docstrings and the keys.js header to match `#planEncryption`. State once, next to `dataKeyFor`, that its result must never reach a response.

### 'Contribution' names two unrelated first-class concepts, both on the plugin SDK surface

`core/src/indexers/contribution.js:3` · medium

Sense A is an extension point declared in a manifest and addressed by URI (core/src/plugins/contributions.js, web/src/platform/contributions.js). Sense B is per-node enrichment addressed by contributorId (core/src/indexers/contribution.js, metadata/interface.js:20). A plugin declares an `indexer` contribution (A) which at runtime produces contributions (B), and nothing distinguishes them. They land in the same file 130 lines apart in plugin-sdk/src/browser.js and in the same route family in server/src/routes.js. Both words are public API and a reader has no rule to tell them apart.

**Fix** — Rename the enrichment side — it has the weaker claim on the word — to `enrichment` or `annotation`: indexers/contribution.js, indexing.js's `indexContributions`/`removeContributions`/`#applyContribution`, MetadataStore's `setContribution`/`clearContribution`/`contributions`, and plugin-sdk's `index()` docs. Judgement call: it is a wire rename on `node.contributions` and `/api/index/:indexerId`, so it needs a dual-read window like `rawFacetsFromNode` already provides for the legacy shape. Nothing structural is load-bearing — decide whether the churn is worth the clarity.

### Two headers describe designs that no longer exist: bl/index.js's `app` provider and queries.js's 'step one' migration

`web/src/bl/index.js:3` · low

Grouping two convergent findings. bl/index.js:3 says 'The engine holds a single `app` singleton provider' and index.js:55, fifty lines below, says '`app` is gone… Every lease now names what it touches' — the provider map has no `app` key. queries.js:10 says 'This is step one of moving onto it… The services are deleted in a later phase', while bl/state.js:3 records that phase as done; nine of ~19 `ServiceQuery` instances now view slices and one views a bare cell, so the class name tells a reader its dep is a service when usually it is not. In a codebase whose entire review standard is 'read the comment, it says why', a false header is worse than no header. Loose end from the same conversion: `installDragAndDrop(engine, app)` never references `app`.

**Fix** — Rewrite both headers to describe what is built. Rename `ServiceQuery` to `CellQuery` (one cell, viewed), leaving `ViewQuery` as the compose-several-cells case — ~25 mechanical call sites in one file. Drop the `app` parameter from `installDragAndDrop`. Do not merge the two query classes.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.

# 013 — API-key grants are invisible to three authorization helpers

`engine/providers/access.js` resolves API-key grants correctly — the audit calls it *"the one
place in the codebase that gets API-key grants completely right"*. Three helpers in
`routes.js` do not consult it: they pass `ctx.principal` to `CollectionService`, and on a
key-authenticated request that is null while the scopes live on `ctx.grant`.

It fails in both directions, which is what makes it more than a bug — a correctly-scoped key
is refused on a locked drive, and on a `defaultOpen` drive a narrowly-scoped key silently
reads and writes through those same routes. Nothing tests it.

## The findings

### API-key grants are invisible to three `ctx.collections` helpers, so key requests are evaluated as the anonymous principal

`server/src/routes.js:1130` · high

Two authorization systems in one file and only `access.js` knows what an API key is. On a key request `ctx.principal` is null and the scopes live on `ctx.grant`; `readableCollectionIds`, `assertCap` and `requireWholeDrive` all pass `ctx.principal` straight to CollectionService. Both directions fail: on a locked drive a correctly-scoped key gets `list(null) === []` and 403s from search/query/tags/backlinks/tasks/issues; on any drive with an `anyone` grant (the zero-config `defaultOpen` shape) a key scoped to one collection silently reads and writes that one through those same routes. index.js:392 explicitly names this confusion class ('a weak key and a strong session would get the union'); here the key borrows the anonymous session instead. No test covers it.

**Fix** — Route all three through `ctx.access.collection` — the one place grants are already resolved correctly — or branch on `ctx.grant` and use `grantedCapabilities`. `assertCap` and the issue/task asserts first: they gate mutation.

## Done when

Every finding above is fixed, or struck from this ticket with the reason it was wrong.

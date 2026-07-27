# Spike: the backend as an ngin engine

One route — the collection scan — rewritten as a provider graph and an action,
to find out whether the backend reads better this way before forty of them are
touched. **Not merged into the architecture yet**: `createServer` still builds
everything else by hand.

## The check that makes it worth attempting

`beginScan` keeps the signature it always had, so `createServer` stays a facade
and every existing test drives HTTP exactly as before. 409 tests passed before
the rewrite and 409 passed after, which is the only useful definition of "this
changed no behaviour". A migration that cannot be verified that way should not
be started.

## What it replaced

78 lines inside `createServer`, which had accreted three things:

| Hand-rolled | What it actually was |
| --- | --- |
| `{ task, alreadyRunning, done }` | a feed — `started` now, `result` later |
| `task.progress()` + clients polling `/api/tasks` | a feed, with a second mechanism bolted on |
| a `try/finally` releasing the scan claim | a resource lifetime — and it released too early the first time it was written |

## What came out better

**Dependencies are declared.** `ScanCollection.deps` is `['vfs', 'tasks',
'lifecycle']` plus a `claim` carrying its collection. Today every route receives
one 18-key context object, which is a service locator: nothing records what a
route uses, so nothing stops it reaching for more. A declared list is checkable,
and `engine-scan.test.js` checks it.

**The claim is a resource, not a discipline.** `ScanClaimProvider.obtain` takes
the lease, `release` gives it back, and the container calls `release` whether the
action returns, throws, or is aborted. Two of those paths are tested; before,
they were a `finally` block that had already been written wrong once.

**Cancellation has one shape.** `signal.aborted` (the caller gave up),
`handle.cancelled` (someone clicked Cancel) and `lifecycle.closing` (the server
is going down) are three different events that all mean stop, and they now read
as three lines in one place. The caller-gave-up case did not exist before.

**Shutdown stopped being a closure variable.** `lifecycle` is a dependency, so an
action that must stop when the server is going down has to say so.

## What it cost, and what to watch

**A dispatch costs a turn of the event loop.** `dispatch()` returns
synchronously and the action runs on a later macrotask, so `beginScan` awaits a
`started` event rather than having the task record in hand. Microseconds — but
it moved a real boundary. The `alreadyRunning` answer used to be decided before
`beginScan` returned; now the claim is taken one turn later. Two scan requests
arriving in the same tick can therefore both run, back to back, instead of the
second being turned away. That is wasteful, not incorrect — the claim still
guarantees they never overlap, which is the property that protects the resume
cursor — but two tests were asserting the old timing and had to be given a
storage backend that genuinely blocks so the overlap is real.

**`next()` semantics need care at the seam.** `done` was first written as
`feed.next(['result'])`, which the abort contract correctly pre-empts — aborting
rejects anything waiting. But `done` is the work's own completion, not a caller
who gave up, and an aborted scan still produces a partial result with
`stopped: true` that a resumable scan needs to report. Naming `abort` in the wait
opts out of the pre-emption. Worth knowing before forty routes are written
against it.

**Half the graph is still singletons.** `vfs`, `tasks` and `kv` are wrapped
instances rather than providers that build their own resources. That is the
honest first step — the graph moves under the container a piece at a time — but
it means this spike does not yet demonstrate the container's teardown ordering
or lazy initialisation, which is where the remaining value of `createServer`'s
474 lines actually is.

## Not done here

- The two-domain split (request vs background) as a first-class idea rather than
  a Workers concession.
- `backgroundWork` as a provider with local and Durable Object implementations.
  The seam exists already as `config.background`; it has not been renamed.
- Anything about queries. One-shot HTTP reads through a boot/kill subscription
  store is the wrong shape; inside the Durable Object it is the right one.

## Running it

The spike needs ngin with `DispatchFeed.next`/`abort`
([3sln/ngin#2](https://github.com/3sln/ngin/pull/2)), which is unpublished. Until
it lands, `node_modules/@3sln/ngin` must point at a checkout of that branch.

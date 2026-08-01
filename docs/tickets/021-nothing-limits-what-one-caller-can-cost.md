# 021 — Nothing limits what one caller can cost

There is no rate limiting anywhere in the drive. A single API key, a single signed-in
person, or on an open drive a single stranger, can issue requests as fast as they can open
sockets, and every one of them is served.

That is survivable while the only user is the person who deployed it. It stops being
survivable the moment a key is handed to a script someone else wrote, or a collection is
shared, or the drive is put somewhere reachable.

## What makes this more than "add a counter"

Requests here are not equal, and a limit that treats them as equal is either useless
against the expensive ones or absurd against the cheap ones. Roughly in order of what a
single call can cost someone:

- **Search with embeddings** — `/api/search`, `/api/collections/:c/search`. On a deployment
  with `TROVE_EMBEDDINGS_URL` set, every query is a paid call to a third party. This is the
  one where an attacker spends the operator's money rather than their CPU.
- **Uploads** — bytes through the drive, and now more of them: encrypted collections proxy
  BOTH directions since the drive seals. `maxUploadBytes` caps a single file and nothing
  caps the rate, so a thousand small uploads cost as much as the limit was meant to prevent.
- **Server-side jobs** — `/scan`, reindex, `/rotate`. Each schedules real work over an
  entire collection, and they are admin-gated but not rate-limited, so an admin key that
  leaks is a way to make the drive scan forever.
- **Plugin installs** — unzip, verify, store.
- **`/api/access/evaluate`** — deliberately unauthenticated, so it is the one endpoint a
  stranger can reach without any credential at all. Each call does a JWKS fetch or cache
  read and an RSA verify. It refuses to ANSWER an unattributable caller, which is the right
  security property and does nothing about the cost of asking.

## The two subjects, and the third

Both credentials are already resolved in exactly one place — `server/src/index.js`, where a
grant is resolved first and an identity only if there is no grant. That is the natural
attachment point, and it means a limiter does not have to re-derive who is calling:

- **API key** — `ctx.grant`. Has a stable id. The easy case.
- **Identity** — `ctx.principal`. Also stable.
- **Neither** — an open drive (`defaultOpen`), or the public access endpoint. This is the
  case that needs a decision rather than a default: limiting by IP is the obvious answer and
  is wrong behind a proxy unless the proxy's forwarded header is trusted, and trusting a
  header that a client can set is worse than not limiting at all.

## What already exists to build on

- `ErrorCode.QUOTA` maps to **429** and is already in `RETRYABLE`, so
  `core/retry.js` backs off on it without changes. The wire vocabulary is done.
- The comment at `errors.js:61` already anticipates this: *"QUOTA covers two failures that
  deserve different statuses. A rate limit is 429 …"*
- `Retry-After` is not set anywhere yet, and a 429 without one makes every client guess.

## Where the counters live

The hard part, and the reason this is a ticket rather than a patch. A per-process counter is
correct on a single Bun or Node instance and is a lie everywhere else: on Workers each
isolate has its own memory, so a limit of 60/minute becomes 60 per isolate per minute, which
is not a limit. Options, roughly in increasing order of cost:

- **Cloudflare's own rate limiting**, configured outside the app. Free, effective, invisible
  to the code — and unavailable to a self-hosted Bun/Node drive, so it cannot be the only
  answer.
- **The KV store**, which is already the shared, cross-instance thing (`resolveUrlSecret`
  uses it for exactly this reason). Read-modify-write per request is a real cost.
- **The TroveTasks Durable Object**, which already exists and already serialises. Natural on
  Workers, absent elsewhere.

Whatever is chosen has to degrade honestly on a runtime that cannot support it, and say so,
rather than appearing to limit and not limiting.

## Configurable, with defaults that are not theatre

Limits belong in `configFromEnv` beside the other operational knobs, per-subject-kind and
per-class-of-work rather than one global number. Defaults should be generous enough that a
person using the drive normally never sees a 429, and tight enough that a loop notices.
"Reasonable" for a personal drive is not the same as for a shared one, which is the argument
for configuring rather than guessing.

## Done when

One caller — key, person, or stranger on the public endpoint — cannot make the drive spend
unbounded CPU, bandwidth, or third-party API credit; the limits are configurable; a limited
caller gets a 429 with `Retry-After`; and a runtime that cannot enforce them says so instead
of pretending.

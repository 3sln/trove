# 026 — plugin storage on Workers must be a Durable Object, not D1

`D1SqliteProvider` should not be what backs plugin storage. It cannot be, correctly, and
the code already says so — it is a workaround that shipped and stayed.

## What is there now

`SqliteProvider` (`packages/core/src/sqlite.js`) is a keyed pool: `obtain({ key })`. Two
implementations exist.

- `LocalSqliteProvider` — **one file per scope**. Real isolation. Node and Bun only.
- `D1SqliteProvider` — one binding for *everything*, because of the constraint its own
  comment states (`sqlite-d1.js:113`):

  > A plugin scope key embeds the runtime principal … so it can never be pre-bound, and
  > **D1 cannot create a database on demand** — without this, plugin storage simply
  > doesn't exist on Workers.

So a deployment nominates a single `PLUGIN_DB` to hold every plugin's tables, for every
user, side by side. The comment is candid that this is *"weaker isolation than the local
provider's file-per-scope"* and kept only because it is *"the strongest thing D1's model"*
allows. It is not the model the rest of the system promises: a scope key is
`pstore:<principal>:plg:<pluginId>`, and the whole point of that key is that scopes do not
see each other.

## What it should be

A **Durable Object per scope.** A DO is addressable by name, so `obtain({ key })` becomes
a lookup — `env.PLUGIN_STORE.get(idFromName(key))` — and the object is *created on demand*,
which is exactly the thing D1 cannot do. Each DO carries its own SQLite storage, so the
isolation is structural rather than a naming convention inside a shared database.

Nothing about the `SqliteProvider` interface changes. This is a third sibling next to the
two that exist, and the wiring in `providers/core.js` picks it when the binding is present.

Two facts that make this cheaper than it sounds: a drive **already runs a Durable Object**
(`TroveTasks`), and the generated `wrangler.toml` already declares
`new_sqlite_classes = ["TroveTasks"]`, so DO-backed SQLite is enabled on the account. What
is needed is a second class, a binding, and a migration entry.

## Scope

1. `DurableObjectSqliteProvider` in core, implementing `obtain({ key })` against a
   `DurableObjectNamespace`, with the same `SqliteDatabase` surface the other two return.
2. The DO class itself — thin: it owns `state.storage.sql` and answers the same
   `exec/run/get/all` verbs over its fetch (or RPC) surface.
3. Wire it in `providers/core.js` ahead of the D1 fallback, and in `configFromEnv` by
   binding discovery, the way the Worker Loader is discovered.
4. `create-trove` emits the binding and the migration entry.
5. **Retire D1 for plugin scopes.** Once the DO path exists, `D1SqliteProvider` keeps the
   core keys (metadata, kv, installs, search) and refuses plugin scopes rather than
   quietly co-locating them — a shared table pretending to be an isolated store is worse
   than an honest `unsupported`.

## Notes

- A DO is single-threaded and lives in one place, so every query for a scope routes there.
  For per-user plugin state that is ideal; for something read from everywhere at once it
  would be a bottleneck, and this ticket is not the place to solve that.
- Per-item plugin KV (see the sidecar work) rides on this once it exists, but does not
  block on it: that path merges local edits with the server opportunistically and its
  server half can start on whatever provider a deployment has.

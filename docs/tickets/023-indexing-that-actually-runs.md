# 023 — indexing that actually runs

Three defects found by opening one audiobook on a real drive and asking why it looked
like nothing had happened. Two are fixed; the rest of this ticket is what is left.

## What was wrong

**a. The viewer never ran.** `plugins/audiobook/manifest.json` declared a `player` opener
and did not declare the `opener` capability. `pluginHost.js` registers an opener only when
the grant is present, so the contribution was dropped silently and the built-in `<audio>`
element won by default. It had never worked, since the commit that created the plugin.
✅ Fixed — plus a test asserting every gated contribution type has its enabling capability,
mutation-checked by removing the capability and watching it fail.

**b. Plugin indexers cannot run on Workers at all.** `InProcessIndexerRuntime` loads an
entry by `import()`ing a `data:` URL. workerd refuses:

```
indexer trove+contrib:3sln.com/audiobook/book failed on probe-book.m4b:
  No such module "data:text/javascript;base64,..."
```

✅ Fixed — `WorkerLoaderIndexerRuntime` (the Cloudflare arm of the §7 provider matrix,
step 4 of §11), plus `IndexerRuntime.probe()` so a deployment that cannot run indexers
skips them and says why on the install record instead of failing once per file forever.

**c. Upload-time indexing was fire-and-forget.** `vfs.js`:

```js
this.indexing.indexNode(node).catch((e) => console.error('index error', e));
```

Not awaited, not in `waitUntil`. On a long-lived Node server the event loop finishes it;
on Workers the request ends and the work is cut off. This is why the book on
trove.raystubbs.me had `contributions: {}` with no issue recorded — nothing failed,
nothing ran.
✅ Fixed — awaited, like the small-write path. Bounded rather than open-ended: an indexer
reads through `readRange`, capped at `maxIndexBytes`, so it costs a couple of megabytes of
reads whether the file is 400 KB or 400 MB. Measured at 19 ms for a complete upload that
runs an indexer in a sandbox.

## Verified end to end

Local `wrangler dev` with a real `worker_loaders` binding, the audiobook plugin installed,
a purpose-built m4b uploaded through the ordinary upload flow:

```
complete in 19 ms
CONTRIBUTIONS: {"trove+contrib:3sln.com/audiobook/book":{
  "tags":{"author":"A. Author","narrator":"N. Narrator","series":"Probe Series"},
  "metadata":{"book":{…,"part":3},"chapters":[{"time":0,"title":"One"},…]}}}
```

Two bugs that only this caught, both invisible to a fake-loader unit test:
the shim's nested template literal was mis-escaped, so every sandbox died with
`Failed to start Worker:` and no location; and `wrangler dev` does not reload on a
`node_modules` change, which made a stale bundle look like a live failure. The shim is now
parsed by a test that actually imports it.

## What is left

1. **Schedule a backfill when a plugin adds indexers.** `PluginIndexers.activate()` already
   backfills inline and `await`s it inside the install request, which is the same mistake
   at a different scale — on a drive of any size that request cannot finish. It should
   enqueue a task in the DO, scoped to the newly-registered indexer ids, resumable the way
   a scan is.

2. **Surface `indexersSkipped` in the plugins UI.** The install record now carries the
   reason; nothing draws it. A drive whose indexers are all skipped currently looks
   identical to one with nothing to index.

## Notes

- Worker Loaders: local `wrangler dev` works now; running dynamic Workers **on Cloudflare**
  needs the closed beta. The scaffolder asks and defaults to off, saying what is lost.
- The sandbox reaches its bytes through a presigned URL (§8) rather than RPC, because an
  indexer reads adaptively and a conversation across an isolate boundary is either RPC
  plumbing on every deployment or one `fetch`. A backend that cannot presign therefore
  cannot host server indexers on Workers, and says so rather than contributing nothing.

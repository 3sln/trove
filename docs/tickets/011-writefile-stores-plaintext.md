# 011 — `vfs.writeFile` stores plaintext into an encrypted collection

`writeFile(name, body, { collectionId })` puts the bytes straight to storage and records the
item with no `encryption` field:

```js
const info = await storage.put(storageKey, body, { contentType: ct, signal });
const node = await this.#upsertItem({ collectionId, name, storageKey, size: info.size, … });
```

It never asks whether the collection encrypts. On a collection someone set up to be
encrypted, that writes the file to the bucket in the clear — which is the one thing the
feature exists to prevent — and stamps the item as unencrypted, so the read path returns it
happily and nothing ever reports a problem.

## Why it matters more than it did

It used to be one of two ways unsealed bytes could reach an encrypted bucket. The other was
a client that ignored `plan.encryption` and sent raw bytes, and that was caught at
completion and refused.

The drive seals now, so the upload path cannot produce an unsealed object at all. This is
the only remaining way, which makes it worth closing rather than noting.

## What reaches it

Not the browser upload path, which goes through `createUpload`/`uploadPart`/`completeUpload`
and is sealed. `writeFile` is the server-side convenience write:

- tests, heavily
- anything in-process that wants to put a file somewhere without negotiating an upload

The exposure is small today and the failure is silent, which is the bad combination: nothing
surfaces until someone reads the bucket and finds a readable file in a collection whose
settings say otherwise.

## The shape of the fix

`writeFile` should do what `uploadPart` now does — consult `encryptionFor(collectionId)`,
seal when the policy says to, and record the fingerprint and chunk size on the item. The
sealing helper already exists (`UploadManager#sealPart`, which is a single whole-object seal
when the part is both first and last), so the work is mostly deciding where that helper
should live so both callers can reach it without one importing the other.

Worth checking while there: `shouldEncrypt` takes the name and content type, so a
collection with per-item rules must be asked the same question here as an upload asks.

## Done when

There is no way to put a plaintext object into an encrypted collection through the drive's
own API, and a test says so by writing through `writeFile` and asserting the bucket holds an
envelope.

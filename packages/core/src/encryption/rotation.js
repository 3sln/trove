// Moving a collection's objects onto a new key, a slice at a time.
//
// Rotation is the one operation here that cannot be atomic. A collection can hold hundreds
// of thousands of objects and every one has to be read, decrypted, re-encrypted and
// written back — far more than fits in a request, a Worker invocation, or anyone's
// patience. So it is a long job that runs in pieces, and the design follows from what
// happens when a piece does not finish.
//
// TWO KEYS ARE LIVE THROUGHOUT. `beginRotation` mints the new key and makes it current
// immediately, so everything uploaded from that moment is already correct and the job only
// ever has to deal with a shrinking set. Everything not yet moved still opens with the old
// key, because its envelope names it. Nothing is unreadable at any point, including
// halfway through, including after a crash.
//
// THE CURSOR IS PERSISTED, NOT HELD. The process doing the work can vanish between slices
// — an evicted isolate, a redeploy, a laptop closing. Progress lives in the KeyValueStore
// with the rest of the drive's durable state, so the next slice picks up where the last
// one stopped rather than starting again. Re-running a slice that already ran is harmless:
// an object already on the current key is skipped, so the work is idempotent by
// construction rather than by bookkeeping.
//
// IT FINISHES BY OBSERVATION. The old key is retired when a full pass finds nothing left
// on it — not when a counter says the job is done. A count can be wrong; a pass that finds
// nothing cannot be. That also handles the awkward case of an object uploaded onto the old
// key by a request that was in flight when the rotation started.
//
// WHICH IS ONLY SOUND IF THE PASS SEES EVERYTHING THE KEY OPENS. The trash keeps its
// bytes, so a soft-deleted object is still sealed and still needs its key on the day
// someone restores it. The walk therefore sources from `listSealed`, which spans live and
// trashed, and not from `listItems`, which is live-only by design. Retiring on a pass over
// a subset is not observation, it is a guess — and the guess destroys data silently.

import { TroveError } from '../errors.js';
import { encryptStream, decodeHeader, HEADER_BYTES } from './envelope.js';
import { fromHex, fingerprint, toHex } from './keys.js';

const NS = 'rotations';

/** How long one slice may run before yielding, so a cron firing stays inside its budget. */
const DEFAULT_BUDGET_MS = 15_000;

/**
 * How much sealed output to gather before sending a part.
 *
 * Above S3's 5 MiB floor for non-final parts, and small enough that peak memory during a
 * rotation is a few megabytes rather than a function of the file.
 */
const PART_TARGET_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {object} RotationState
 * @property {string} collectionId
 * @property {string} to        fingerprint of the key being moved onto
 * @property {string[]} from    fingerprints being moved off
 * @property {string|null} cursor  where the last slice stopped
 * @property {number} moved
 * @property {number} failed
 * @property {number} startedAt
 * @property {'running'|'done'} status
 */

/**
 * The storage key a rotation writes to.
 *
 * Based on the key with any previous rotation suffix STRIPPED. Appending to
 * `node.storageKey` instead compounds: a collection rotated twice held
 * `obj_x.rotms9gq8j2.rotms9grnhf`, and a key grew by ~11 characters on every rotation for
 * the life of the drive. S3 stops accepting a key at 1024 bytes, so a drive rotated on a
 * schedule would eventually fail to rotate at all — years out, silently, and only for the
 * objects with the longest names.
 */
export function rotatedKey(storageKey) {
  return `${storageKey.replace(/(\.rot[0-9a-z]+)+$/, '')}.rot${Date.now().toString(36)}`;
}

export class RotationService {
  /**
   * @param {object} deps
   * @param {import('../kv.js').KeyValueStore} deps.kv     where progress survives
   * @param {import('../vfs.js').Vfs} deps.vfs
   * @param {import('../collections/index.js').CollectionService} deps.collections
   */
  constructor({ kv, vfs, collections }) {
    if (!kv || !vfs || !collections) throw TroveError.invalid('RotationService needs kv, vfs and collections');
    this.kv = kv;
    this.vfs = vfs;
    this.collections = collections;
  }

  async state(collectionId) {
    return this.kv.get(NS, collectionId);
  }

  /**
   * Start moving a collection onto a fresh key.
   *
   * The new key becomes current here, before any object moves, so every upload from now on
   * is already on it. Refuses to start a second rotation over an unfinished one — two
   * walkers on one collection would fight over the cursor and neither would know what the
   * other had done.
   */
  async begin(collectionId, principal) {
    const running = await this.state(collectionId);
    if (running && running.status === 'running') {
      throw TroveError.invalid('A key rotation is already running on this collection');
    }
    // A finished-but-abandoned rotation can still be holding an open multipart. Starting a
    // new one is the last moment anything knows it exists.
    if (running?.inflight) await this.#discard(collectionId, running.inflight);
    const { fingerprint: to, previous } = await this.collections.beginRotation(collectionId, principal);
    const state = {
      collectionId,
      to,
      // Everything currently live except the new key. Usually one, but a rotation started
      // over an unfinished one would leave more, and dropping any of them would strand
      // whatever is still sealed with it.
      from: (await this.collections.keyRingFor(collectionId))
        .map((k) => k.fingerprint)
        .filter((fp) => fp !== to),
      cursor: null,
      // The object part-way through, when a slice ran out of budget inside one. See
      // #moveSlice — this is what lets an object larger than a slice be rotated at all.
      inflight: null,
      moved: 0,
      failed: 0,
      startedAt: Date.now(),
      status: 'running',
      previous,
    };
    await this.kv.set(NS, collectionId, state);
    return state;
  }

  /**
   * Do a slice of the work.
   *
   * Bounded by time rather than by count, because objects vary from bytes to gigabytes and
   * a count is not a budget. Returns the state, so a caller can loop until `done`.
   */
  async step(collectionId, { budgetMs = DEFAULT_BUDGET_MS, now = () => Date.now() } = {}) {
    const state = await this.state(collectionId);
    if (!state || state.status !== 'running') return state;

    // One walker at a time, claimed the way a scan claims its collection.
    //
    // Two slices running together — a cron overlapping a manual run, or two cron firings on
    // a slow collection — can both pick up the same object. Each writes a new object and
    // points the item at it, and then each deletes the object IT replaced: the second
    // delete removes the object the item is now pointing at. With the old key still in the
    // ring nothing reports an error, and the file is simply gone.
    //
    // A lease rather than a flag, because the holder can die mid-slice and a lock that
    // outlives its holder stops the rotation permanently with nobody left to notice.
    const claim = await this.kv.acquire('rotation', collectionId, Math.max(30_000, budgetMs * 3));
    if (!claim) return state;
    try {
      return await this.#slice(collectionId, state, { budgetMs, now });
    } finally {
      await this.kv.release('rotation', collectionId, claim).catch(() => {});
    }
  }

  async #slice(collectionId, state, { budgetMs, now }) {

    const deadline = now() + budgetMs;
    const key = await this.collections.dataKeyFor(collectionId, state.to);
    if (!key) throw TroveError.invalid('The key this rotation is moving onto is gone');
    const fp = await fingerprint(key);

    let cursor = state.cursor;
    let moved = state.moved;
    let failed = state.failed;
    let sawStragglers = false;
    let inflight = state.inflight || null;

    // Finish what the last slice started before looking for more. An object part-way
    // through is the one thing that MUST be dealt with first: its multipart is open and
    // billed, and the walk would otherwise pick it up again from the beginning.
    if (inflight) {
      const node = await this.vfs.metadata.getById(inflight.nodeId).catch(() => null);
      // Deleted, or already moved by something else, while we were away. Spend the upload
      // rather than leaving it open forever.
      if (!node || !node.encryption || node.encryption.fingerprint === state.to) {
        await this.#discard(collectionId, inflight);
        inflight = null;
      } else {
        sawStragglers = true;
        try {
          const r = await this.#moveSlice(node, key, fp, inflight, { deadline, now });
          inflight = r.inflight;
          if (r.done) moved++;
        } catch (err) {
          failed++;
          await this.#discard(collectionId, inflight);
          inflight = null;
          console.error(`[trove] resuming ${node.name} failed:`, err?.message || err);
        }
        // Still not finished, or out of time: persist and let the next slice continue.
        if (inflight || now() >= deadline) {
          return this.#save(collectionId, { ...state, cursor, moved, failed, inflight });
        }
      }
    }

    for (;;) {
      // `listSealed`, NOT `listItems`: the trash keeps its bytes, so a trashed object is
      // still sealed with the old key, and a walk that cannot see it would retire that key
      // out from under every future restore. The store applies the sealed predicate too,
      // so a mostly-plaintext collection is one page rather than hundreds to skip.
      const page = await this.vfs.metadata.listSealed(collectionId, { cursor, limit: 50 });
      const items = page.items || [];
      for (const node of items) {
        // Only items not already on the current key. This is what makes re-running a slice
        // free rather than destructive.
        if (node.encryption.fingerprint === state.to) continue;
        sawStragglers = true;
        try {
          const r = await this.#moveSlice(node, key, fp, null, { deadline, now });
          if (r.done) moved++;
          else {
            // Bigger than the remaining budget. Its parts and its place in the envelope are
            // recorded, and the next slice picks it up where this one stopped instead of
            // starting the object again — which is what used to make a large object
            // unrotatable at all rather than merely slow.
            return this.#save(collectionId, { ...state, cursor, moved, failed, inflight: r.inflight });
          }
        } catch (err) {
          // One unreadable object must not stop the rotation: the rest of the collection
          // still needs to move, and the old key cannot be retired while anything is left
          // on it — which is exactly the signal a failure should produce.
          failed++;
          console.error(`[trove] rotating ${node.name} failed:`, err?.message || err);
        }
        if (now() >= deadline) break;
      }
      cursor = page.nextCursor || null;
      if (!cursor || now() >= deadline) break;
    }

    const finished = !cursor && !sawStragglers;
    const next = {
      ...state,
      inflight: null,
      // A finished pass starts the next one from the beginning, because items added during
      // it may still be behind. Two clean passes in a row is what actually ends the job.
      cursor: finished ? null : cursor,
      moved,
      failed,
      status: finished && failed === 0 ? 'done' : 'running',
      finishedAt: finished && failed === 0 ? now() : undefined,
    };
    await this.kv.set(NS, collectionId, next);

    // Retire by observation: a pass that found nothing left on the old keys is proof, in a
    // way that a counter never is.
    if (next.status === 'done') {
      for (const old of state.from) {
        // System work: it is finishing what an admin authorized when they started the
        // rotation, and there is no user behind a cron firing. A failure here is logged
        // rather than swallowed — the rotation itself succeeded, but a key that should
        // have been retired and was not is worth knowing about.
        await this.collections.retireKey(collectionId, old, null, { system: true })
          .catch((err) => console.error(`[trove] retiring key ${old} failed:`, err?.message || err));
      }
    }
    return next;
  }

  /**
   * Move one object onto the new key, in as many slices as it takes.
   *
   * A rotation slice is bounded by wall-clock time, and until now an object could only be
   * moved whole: one larger than the budget failed its slice, restarted from the beginning
   * on the next, and failed again — forever, with the rotation never completing and the old
   * key never retiring. A collection containing one big video could not be rotated at all.
   *
   * The checkpoint is the multipart part list, which the store is already keeping for us.
   * What has to travel with it is the ENVELOPE's position: a nonce is derived from the
   * chunk index, so a resumed encryption must continue the same sequence under the same
   * prefix. Starting a fresh envelope halfway would reuse nonce/key pairs from the first
   * half — the one thing AES-GCM cannot survive — so the prefix and the next chunk index
   * are persisted alongside the parts.
   *
   * @returns {Promise<{done: boolean, inflight: object|null}>}
   */
  async #moveSlice(node, newKey, newFingerprint, inflight, { deadline, now }) {
    const storage = await this.vfs.storageFor(node.collectionId);
    const { plaintextSize, chunkSize } = await this.#geometryOf(node, storage);

    // A store without multipart is a local one — filesystem, memory — where the whole
    // object is already within reach. There is nothing to check point against, and nothing
    // that needs it: the budget that makes this necessary is a network one.
    if (!storage.capabilities?.multipart) {
      await this.#moveWhole(node, newKey, newFingerprint, storage, { plaintextSize, chunkSize });
      return { done: true, inflight: null };
    }

    // Written to a NEW storage key rather than over the old one. AES-GCM cannot survive a
    // nonce being reused with a key, and rewriting in place invites exactly that on a
    // retry; a new object also means a failure halfway leaves the original intact and
    // readable rather than a half-written file that is neither.
    const nextKey = inflight?.storageKey ?? rotatedKey(node.storageKey);
    const uploadId = inflight?.uploadId ?? await storage.createMultipart(nextKey, { contentType: node.contentType });
    const parts = inflight?.parts ? [...inflight.parts] : [];
    let chunkIndex = inflight?.chunkIndex ?? 0;
    let noncePrefix = inflight?.noncePrefix ? fromHex(inflight.noncePrefix) : null;

    // One part per pass, so the checkpoint lands on a part boundary — which is also a chunk
    // boundary, since a part is a whole number of sealed chunks. Sized to clear S3's 5 MiB
    // floor for every part but the last.
    const chunksPerPart = Math.max(1, Math.ceil(PART_TARGET_BYTES / chunkSize));

    try {
      while (chunkIndex * chunkSize < plaintextSize) {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunksPerPart * chunkSize, plaintextSize) - 1;
        const last = end + 1 >= plaintextSize;

        const read = await this.vfs.readNode(node, { range: { start, end } });
        const sealed = await encryptStream(newKey, read.stream, {
          fingerprint: newFingerprint,
          plaintextSize,
          chunkSize,
          // The first pass mints the prefix and writes the header; every later one continues
          // the same envelope, which is what `resume` means.
          resume: noncePrefix ? { noncePrefix, index: chunkIndex } : null,
          // `partial` says another call will continue this object. Without it a mid-object
          // pass would be sealed as a complete envelope and every later chunk index would be
          // wrong.
          partial: !last,
        });

        const body = new Uint8Array(await new Response(sealed).arrayBuffer());
        // The prefix the first pass generated, read back out of the header it wrote. It is
        // the only place it exists, and every later pass needs it.
        if (!noncePrefix) noncePrefix = decodeHeader(body).noncePrefix;

        const partNumber = parts.length + 1;
        const etag = await storage.putPart(nextKey, uploadId, partNumber, body);
        parts.push({ partNumber, etag: etag?.etag ?? etag });
        chunkIndex += Math.ceil((end + 1 - start) / chunkSize);

        // Out of time, but on a boundary: hand back what has been done so the next slice
        // continues rather than starting over.
        if (!last && now() >= deadline) {
          return {
            done: false,
            inflight: {
              nodeId: node.id,
              storageKey: nextKey,
              uploadId,
              parts,
              chunkIndex,
              noncePrefix: toHex(noncePrefix),
            },
          };
        }
      }

      await storage.completeMultipart(nextKey, uploadId, parts);
    } catch (err) {
      // The parts already sent stay in the bucket, billed, with nothing left able to
      // reclaim them — so a failure aborts rather than leaving them.
      await storage.abortMultipart(nextKey, uploadId).catch(() => {});
      throw err;
    }

    // The item points at the new object before the old one is removed. In the window
    // between, both exist and the item is readable; in the reverse order there is a window
    // where it is readable through neither.
    const oldKey = node.storageKey;
    await this.vfs.metadata.update(node.id, {
      storageKey: nextKey,
      encryption: { fingerprint: toHex(newFingerprint), chunkSize },
    });
    await storage.delete(oldKey).catch(() => {});
    return { done: true, inflight: null };
  }

  /**
   * The geometry of the object as the OBJECT states it.
   *
   * The Vfs already answers the authority question and answers it this way: the item's
   * record says which key sealed it and at what chunk size, and that is what makes a
   * listing cheap — but it is a copy, and a copy can be stale (restored from a backup,
   * adopted by a scan, written by another version).
   *
   * The two arms here disagreed. The multipart arm took `node.size`; the whole-object arm
   * took the envelope's, so which answer a drive got depended on whether its store supports
   * multipart. A stale-LARGE `node.size` makes every slice raise "Expected N bytes…
   * received M", so the rotation can never reach `done` and the old key is never retired; a
   * stale-SMALL one seals a header that decrypts to the wrong length forever.
   *
   * One 44-byte read against a multi-megabyte transfer.
   */
  async #geometryOf(node, storage) {
    const head = await storage.get(node.storageKey, { range: { start: 0, end: HEADER_BYTES - 1 } });
    const header = decodeHeader(new Uint8Array(await new Response(head.stream).arrayBuffer()));
    return {
      plaintextSize: header.plaintextSize ?? node.size,
      chunkSize: header.chunkSize ?? node.encryption.chunkSize,
    };
  }

  /** The whole object in one put, for a store that cannot do multipart. */
  async #moveWhole(node, newKey, newFingerprint, storage, { plaintextSize, chunkSize }) {
    const nextKey = rotatedKey(node.storageKey);
    const read = await this.vfs.readNode(node);
    const sealed = await encryptStream(newKey, read.stream, {
      fingerprint: newFingerprint,
      plaintextSize,
      chunkSize,
    });
    await storage.put(nextKey, new Uint8Array(await new Response(sealed).arrayBuffer()), {
      contentType: node.contentType,
    });
    const oldKey = node.storageKey;
    await this.vfs.metadata.update(node.id, {
      storageKey: nextKey,
      encryption: { fingerprint: toHex(newFingerprint), chunkSize },
    });
    await storage.delete(oldKey).catch(() => {});
  }

  /**
   * Abandon a half-written object.
   *
   * A multipart left open is billed until it is completed or aborted, and nothing else can
   * find it: the storage contract has no way to list them, deliberately, so the only record
   * that it exists is the one we wrote. Cancelling or restarting a rotation has to spend it.
   */
  async #discard(collectionId, inflight) {
    if (!inflight?.uploadId) return;
    try {
      const storage = await this.vfs.storageFor(collectionId);
      await storage.abortMultipart(inflight.storageKey, inflight.uploadId);
    } catch (err) {
      console.error(`[trove] abandoning a rotation upload failed:`, err?.message || err);
    }
  }

  /** Persist progress mid-pass, so the next slice continues from here. */
  async #save(collectionId, next) {
    await this.kv.set(NS, collectionId, next);
    return next;
  }

  /** Abandon a rotation. The new key stays current; what has moved stays moved. */
  async cancel(collectionId) {
    const state = await this.state(collectionId);
    if (!state) return null;
    // The half-written object goes with it. Nothing else can find that multipart — the
    // storage contract cannot list them — so if this does not spend it, nothing will.
    await this.#discard(collectionId, state.inflight);
    const next = { ...state, status: 'done', cancelled: true, inflight: null };
    await this.kv.set(NS, collectionId, next);
    return next;
  }
}

/** Read the fingerprint an object actually carries, for checking rather than trusting. */
export async function fingerprintOf(bytes) {
  return toHex(decodeHeader(bytes).fingerprint);
}

export { fromHex };

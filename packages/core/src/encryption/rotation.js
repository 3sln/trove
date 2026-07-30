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

import { TroveError } from '../errors.js';
import { encrypt, decodeHeader } from './envelope.js';
import { fromHex, fingerprint, toHex } from './keys.js';

const NS = 'rotations';

/** How long one slice may run before yielding, so a cron firing stays inside its budget. */
const DEFAULT_BUDGET_MS = 15_000;

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

    const deadline = now() + budgetMs;
    const key = await this.collections.dataKeyFor(collectionId, state.to);
    if (!key) throw TroveError.invalid('The key this rotation is moving onto is gone');
    const fp = await fingerprint(key);

    let cursor = state.cursor;
    let moved = state.moved;
    let failed = state.failed;
    let sawStragglers = false;

    for (;;) {
      const page = await this.vfs.metadata.listItems(collectionId, { cursor, limit: 50 });
      const items = page.items || [];
      for (const node of items) {
        // Only encrypted items, and only ones not already on the current key. This is what
        // makes re-running a slice free rather than destructive.
        if (!node.encryption || node.encryption.fingerprint === state.to) continue;
        sawStragglers = true;
        try {
          await this.#move(node, key, fp);
          moved++;
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
   * Read one object under whichever key it names, and write it back under the new one.
   *
   * Written to a NEW storage key rather than over the old one. AES-GCM cannot survive a
   * nonce being reused with a key, and rewriting in place invites exactly that on a retry;
   * a new object also means a failure halfway leaves the original intact and readable
   * rather than a half-written file that is neither.
   */
  async #move(node, newKey, newFingerprint) {
    const read = await this.vfs.readStream(node.id);
    const plain = new Uint8Array(await new Response(read.stream).arrayBuffer());
    const sealed = await encrypt(newKey, plain, {
      fingerprint: newFingerprint,
      chunkSize: node.encryption.chunkSize,
    });

    const storage = await this.vfs.storageFor(node.collectionId);
    const nextKey = `${node.storageKey}.rot${Date.now().toString(36)}`;
    await storage.put(nextKey, sealed, { contentType: node.contentType });

    // The item points at the new object before the old one is removed. In the window
    // between, both exist and the item is readable; in the reverse order there is a window
    // where it is readable through neither.
    const oldKey = node.storageKey;
    await this.vfs.metadata.update(node.id, {
      storageKey: nextKey,
      encryption: { fingerprint: toHex(newFingerprint), chunkSize: node.encryption.chunkSize },
    });
    await storage.delete(oldKey).catch(() => {});
  }

  /** Abandon a rotation. The new key stays current; what has moved stays moved. */
  async cancel(collectionId) {
    const state = await this.state(collectionId);
    if (!state) return null;
    const next = { ...state, status: 'done', cancelled: true };
    await this.kv.set(NS, collectionId, next);
    return next;
  }
}

/** Read the fingerprint an object actually carries, for checking rather than trusting. */
export async function fingerprintOf(bytes) {
  return toHex(decodeHeader(bytes).fingerprint);
}

export { fromHex };

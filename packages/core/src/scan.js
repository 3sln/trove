// CollectionScanner — reconcile a collection against the bytes actually in its store.
//
// Trove is not the only thing that can touch a bucket. Another tool writes to it, a
// teammate drags a folder in with the S3 console, a sync client replaces an object in
// place, a lifecycle rule expires something. Every one of those leaves the drive
// describing a world that no longer exists — and because there are no folders here,
// "it isn't in the list" is indistinguishable from "it was never there".
//
// So this walks both sides and names the four things that can be true of an object:
//
//   known & unchanged   nothing to do (the overwhelming majority — keep it cheap)
//   in the store only   ADOPT: create an item for it, named from its key
//   changed in place    REFRESH: same key, different etag/size → re-read and re-index
//   in metadata only    ORPHANED: the bytes are gone. Reported, never auto-deleted.
//
// The asymmetry in that last pair is deliberate. Adopting a file is additive and
// reversible; deleting an item because a LIST call didn't mention it is neither, and
// list calls are exactly the operation that goes wrong in interesting ways — a
// misconfigured prefix, an eventually-consistent replica, a credential scoped to the
// wrong path. Trove will happily invent an item from bytes it can see. It will not
// destroy a record because it briefly couldn't see any.

import { TroveError } from './errors.js';
import { extname } from './util.js';
import { PACKAGE_PREFIX } from './plugins/packageStore.js';

/** Objects Trove wrote itself. Anything else in the store arrived some other way. */
const TROVE_KEY = /^obj_[0-9a-f]+$/i;
/**
 * Keys that are Trove's own bookkeeping, not user data.
 *
 * These MUST match what the writers actually use, and one of them didn't: the package
 * store writes under `_plugins/` (StoragePackageStore's default prefix) while this list
 * said `plugins/`. Since that store wraps the primary backend — which is also the
 * `default` collection's — every account's uploaded plugin zip sat in the default
 * collection's key space as an unreserved object, and a scan adopted it: the package
 * bytes became a file anyone with read on `default` could download, its name leaked the
 * installing account's id (usually an email), its contents went into the shared search
 * index, and because the adopted item's storageKey IS the real blob key, deleting it
 * destroyed the owner's package.
 *
 * `plugins/` and `packages/` are kept as well — they cost nothing and a store
 * constructed with a different prefix should still be skipped.
 */
const RESERVED_PREFIXES = ['sidecars/', PACKAGE_PREFIX, 'packages/', 'plugins/'];

export class CollectionScanner {
  /**
   * @param {object} deps
   * @param {import('./vfs.js').Vfs} deps.vfs
   * @param {import('./issues.js').IssueRegistry} [deps.issues]
   */
  constructor({ vfs, issues = null }) {
    this.vfs = vfs;
    this.issues = issues;
  }

  /**
   * Reconcile one collection.
   *
   * @param {string} collectionId
   * @param {object} [opts]
   * @param {boolean} [opts.adopt]        create items for unknown objects (default true)
   * @param {boolean} [opts.refresh]      re-index items whose bytes changed (default true)
   * @param {number}  [opts.pageSize]
   * @param {(p: object) => void} [opts.onProgress]
   * @param {() => boolean} [opts.shouldStop]
   * @returns {Promise<{scanned, adopted, refreshed, orphaned, skipped, failed, stopped}>}
   */
  async scan(collectionId = 'default', opts = {}) {
    const { adopt = true, refresh = true, pageSize = 500, onProgress, shouldStop } = opts;
    const storage = await this.vfs.storageFor(collectionId);
    if (!storage.capabilities?.list) {
      throw TroveError.unsupported('This collection\'s storage backend cannot list its contents');
    }

    // One pass over metadata first, so the comparison is a map lookup per object rather
    // than a query per object — a bucket scan that did a round trip per key would take
    // hours on a real drive.
    const byKey = new Map();
    for (const node of await this.#allItems(collectionId)) {
      if (node.storageKey) byKey.set(node.storageKey, node);
    }
    // The trash holds rows too, and their bytes are deliberately still in the store —
    // that is what makes a delete undoable. `listItems` is live-only by design, so
    // without this a trashed file's object looks exactly like one that arrived from
    // outside: the scan adopts it AGAIN, resurrecting the deleted file under a new id
    // that shares the original's storage key. Emptying the trash then deletes the live
    // copy's bytes, leaving an item that lists, opens, and 404s forever.
    const trashedKeys = await this.vfs.metadata.trashedStorageKeys?.(collectionId) ?? new Set();

    const result = { scanned: 0, adopted: 0, refreshed: 0, orphaned: 0, skipped: 0, failed: 0, stopped: false, unaddressable: 0 };
    const seen = new Set();
    let cursor = null;

    outer: for (;;) {
      const page = await storage.list({ cursor, limit: pageSize });
      result.unaddressable += page.unaddressable || 0;
      for (const object of page.objects) {
        if (shouldStop?.()) { result.stopped = true; break outer; }
        result.scanned++;
        if (this.#reserved(object.key)) { result.skipped++; continue; }
        seen.add(object.key);
        // Bytes belonging to something in the trash are accounted for. Not adopted (it
        // is already ours), and not orphaned (`seen` covers that below).
        if (trashedKeys.has(object.key)) { result.skipped++; continue; }
        const node = byKey.get(object.key);
        try {
          if (!node) {
            // #adopt declines Trove's own orphaned blobs, so count what it actually did
            // rather than assuming — otherwise a drive full of leftover `obj_` keys
            // would report a large, entirely fictional adoption.
            const created = adopt ? await this.#adopt(collectionId, object) : null;
            if (created) result.adopted++;
            else result.skipped++;
          } else if (refresh && this.#changed(node, object)) {
            await this.#refresh(node, object);
            result.refreshed++;
          }
        } catch (err) {
          result.failed++;
          console.error(`scan failed on ${object.key}:`, err.message);
        }
      }
      onProgress?.({ ...result });
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    // Orphans are only meaningful after a COMPLETE pass. A scan cut short by a cancel
    // or a shutdown has simply not looked at the rest of the bucket, and calling those
    // items orphaned would be a false alarm about data loss — the worst kind.
    if (!result.stopped) {
      for (const [key, node] of byKey) {
        if (!seen.has(key) && !this.#reserved(key)) result.orphaned++;
      }
    }

    await this.#report(collectionId, result);
    return result;
  }

  /** Every item in the collection, paged so a large drive doesn't load at once. */
  async #allItems(collectionId) {
    const items = [];
    let cursor = null;
    for (;;) {
      const page = await this.vfs.metadata.listItems(collectionId, { limit: 500, cursor });
      items.push(...page.items);
      if (!page.nextCursor) return items;
      cursor = page.nextCursor;
    }
  }

  #reserved(key) {
    return RESERVED_PREFIXES.some((p) => key.startsWith(p));
  }

  /**
   * Did the bytes behind an item change without us? ETag first (it is what object
   * stores actually promise), size as the fallback for backends that don't give one.
   * An item we have no etag for is left alone rather than re-indexed on every scan.
   */
  #changed(node, object) {
    if (object.etag && node.etag) return normalizeEtag(object.etag) !== normalizeEtag(node.etag);
    if (typeof object.size === 'number' && typeof node.size === 'number') return object.size !== node.size;
    return false;
  }

  /**
   * Create an item for an object that arrived without us.
   *
   * The key becomes the name, because in a bucket the key IS what a human called the
   * thing — `holiday/2019/beach.jpg` is a name someone chose, and flattening it to
   * `beach.jpg` would collide with every other year's. Trove's own `obj_<hex>` keys are
   * excluded: one of those with no metadata row is a leftover from a failed write, not
   * a file someone put there, and adopting it would surface `obj_9fc0…` as a document.
   */
  async #adopt(collectionId, object) {
    if (TROVE_KEY.test(object.key)) return null; // orphaned blob from an interrupted upload
    const name = await this.#uniqueName(collectionId, object.key);
    const node = await this.vfs.metadata.create({
      collectionId,
      name,
      storageKey: object.key,
      size: object.size ?? 0,
      etag: object.etag ?? null,
      contentType: this.vfs.guessContentType(name),
      meta: { adopted: true, adoptedAt: Date.now() },
    });
    // Adopted files are indexed like any other, so they are findable immediately —
    // an item you can't search for is barely an item in a drive with no folders.
    await this.vfs.indexing.indexNode(node).catch(() => {});
    return node;
  }

  /** Re-read an item whose bytes were replaced in place. */
  async #refresh(node, object) {
    const updated = await this.vfs.metadata.update(node.id, {
      size: object.size ?? node.size,
      etag: object.etag ?? null,
    });
    await this.vfs.indexing.indexNode(updated).catch(() => {});
    return updated;
  }

  async #uniqueName(collectionId, base) {
    if (!(await this.vfs.metadata.getByName(collectionId, base))) return base;
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 1; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!(await this.vfs.metadata.getByName(collectionId, candidate))) return candidate;
    }
    throw TroveError.invalid(`Cannot find a free name for "${base}"`);
  }

  /**
   * Turn the outcome into something a human sees.
   *
   * Orphans and unreachable files are raised as a standing issue rather than logged,
   * because they are exactly the kind of fact that matters days later: "17 items point
   * at bytes that are gone" is a data-loss report, and it should still be on screen
   * tomorrow if nobody has dealt with it. A clean scan clears it.
   */
  async #report(collectionId, result) {
    if (!this.issues || result.stopped) return;
    try {
      if (result.orphaned) {
        await this.issues.raise({
          kind: 'orphaned',
          subject: collectionId,
          collectionId,
          severity: 'warning',
          title: result.orphaned === 1
            ? `1 item in “${collectionId}” points at a file that is no longer in the store`
            : `${result.orphaned} items in “${collectionId}” point at files that are no longer in the store`,
          detail: 'Their bytes were removed outside Trove. Nothing was deleted automatically — '
            + 'the records are kept so you can decide, because a listing that briefly misses objects '
            + 'must never be able to destroy data.',
          retry: { op: 'scan-collection', collectionId },
        });
      } else {
        await this.issues.clear('orphaned', collectionId);
      }

      if (result.unaddressable) {
        await this.issues.raise({
          kind: 'unaddressable',
          subject: collectionId,
          collectionId,
          severity: 'warning',
          title: result.unaddressable === 1
            ? '1 file in the data directory is not where Trove can read it'
            : `${result.unaddressable} files in the data directory are not where Trove can read them`,
          detail: 'Files copied directly into the storage root have to sit at the path their name maps to. '
            + 'Upload them through Trove instead, or move them into place and scan again.',
          retry: { op: 'scan-collection', collectionId },
        });
      } else {
        await this.issues.clear('unaddressable', collectionId);
      }

      if (result.failed) {
        await this.issues.raise({
          kind: 'scan',
          subject: collectionId,
          collectionId,
          title: `${result.failed} object${result.failed === 1 ? '' : 's'} in “${collectionId}” could not be reconciled`,
          detail: `${result.scanned} scanned, ${result.adopted} adopted, ${result.refreshed} refreshed, ${result.failed} failed.`,
          retry: { op: 'scan-collection', collectionId },
        });
      } else {
        await this.issues.clear('scan', collectionId);
      }
    } catch (err) {
      console.error('could not record a scan issue:', err.message);
    }
  }
}

/** S3 etags are quoted and some backends aren't; compare the value, not the quoting. */
function normalizeEtag(etag) {
  return String(etag).replace(/^W\//, '').replace(/^"|"$/g, '');
}

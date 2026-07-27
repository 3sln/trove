// Authorization you hold, rather than authorization you remembered to check.
//
// The shape this replaces was everywhere: stat the node, look up its collection,
// assert a capability, then operate — through an unrestricted `vfs`, using a raw
// id. Twenty-six sites, each of which had to remember all four steps in order.
// The check and the use were separate, so nothing carried the grant forward: a
// caller who asserted `read` still held a `vfs` and an id, and `vfs.remove(id)`
// was one line away.
//
// Here the grant IS the object you operate through. `obtain` resolves the node,
// asserts the capability, and hands back a handle whose METHODS ARE THE ONES
// THAT CAPABILITY PERMITS — a read handle has no `remove`, because there is no
// `remove` to call, not because calling it is checked. The action never sees a
// raw id it could take somewhere else; `id` is on the handle as data, for the
// response, and there is nowhere else to take it.
//
// And because this is a provider, denial happens during `container.lease()` —
// before `execute` runs at all. An action cannot proceed unauthorized because it
// cannot obtain its dependencies. That works identically for actions and
// queries, which an interceptor could not: ngin runs interceptors on the
// dispatcher only, so a query would have escaped one entirely.

import { Provider } from '@3sln/ngin';
import { TroveError } from '@trove/core';

/**
 * The one place that decides whether this deployment enforces ACLs at all.
 *
 * From configuration, never from whether a service is present — those agree when
 * everything is wired correctly and diverge exactly when it is not, and the
 * second stops enforcing at the worst possible moment.
 */
const enforcing = (config) => config?.collections !== false;

/** Conversations are optional; a drive without them says so rather than crashing. */
function requireSidecar(sidecar) {
  if (!sidecar) throw TroveError.unsupported('Conversations are not enabled on this server');
  return sidecar;
}


/**
 * What the principal actually holds — never a second opinion about it.
 *
 * An earlier draft of this file decided implication here: `write` implies
 * `read`, `delete` implies `read`. CollectionService does not agree — only
 * `admin` implies anything (see `expand`), and a grant of `['write']` alone
 * carries no read. So a handle obtained with `capability: 'write'` was handing
 * out `read`, `download` and `view` to a principal the ACL had never given them
 * to. Two models of the same rule, and the more permissive one winning.
 *
 * There is one model now, and it lives in CollectionService. This asks — and
 * then intersects with what the caller ASKED for, so a handle stays as narrow as
 * the request that made it. An admin who obtains a `read` handle gets a read
 * handle; holding a capability and wielding it are different things, and an
 * operation that only needs to read should not be one typo from deleting.
 */
const ALL = new Set(['read', 'write', 'delete', 'admin']);

/** One list of what a capability can be, so a typo is refused rather than read as none. */
function assertCapability(capability) {
  if (!ALL.has(capability)) throw TroveError.invalid(`Unknown capability "${capability}"`);
}

/** What naming `capability` asks for, under CollectionService's own implication. */
function requested(capability) {
  return capability === 'admin' ? new Set(ALL) : new Set([capability]);
}

const intersect = (held, asked) => new Set([...asked].filter((c) => held.has(c)));

/**
 * One node, and the operations the caller may perform on it.
 *
 * @param {object} vfs
 * @param {object} node   already resolved by `stat`
 * @param {string|symbol} granted the capability that was asserted
 */
function nodeHandle(vfs, sidecar, node, held) {
  const permits = (capability) => held.has(capability);
  const granted = held === ALL ? 'system' : [...held].sort().join(',');
  // Data, not authority. Present so a response can name what it acted on.
  const handle = {
    id: node.id,
    name: node.name,
    collectionId: node.collectionId,
    contentType: node.contentType,
    size: node.size,
    node,
    granted,
  };

  // Conversations and tags live in the sidecar, not the vfs — but they are still
  // operations ON THIS NODE, so the same grant has to reach them. Fronting only
  // the vfs would have left eight routes asserting a capability and then working
  // through an unrestricted service, which is the shape this exists to remove.
  //
  // Reading a file's conversation is reading the file: the comments on it are as
  // much its content as its bytes are.
  if (permits('read')) {
    handle.read = (opts) => vfs.readStream(node.id, opts);
    handle.download = (opts) => vfs.getDownload(node.id, opts);
    handle.backlinks = (opts) => vfs.backlinks(node.id, opts);
    handle.view = () => requireSidecar(sidecar).view(node.id);
    handle.subscribe = (principal, muted) => requireSidecar(sidecar).subscribe(node.id, principal, muted);
    handle.unsubscribe = (principal) => requireSidecar(sidecar).unsubscribe(node.id, principal);
  }

  if (permits('write')) {
    handle.rename = (newName) => vfs.rename(node.id, newName);
    handle.setTag = (name, value, principal) => vfs.setTag(node.id, name, value, principal);
    handle.removeTag = (name, principal) => vfs.removeTag(node.id, name, principal);
    handle.contribute = (contributorId, contribution) =>
      vfs.indexContributions(node.id, contributorId, contribution);
    handle.comment = (comment, principal) => requireSidecar(sidecar).addComment(node.id, comment, principal);
    handle.editComment = (cid, body, principal) =>
      requireSidecar(sidecar).editComment(node.id, cid, body, principal);
    handle.deleteComment = (cid, principal) =>
      requireSidecar(sidecar).deleteComment(node.id, cid, principal);
    handle.react = (cid, emoji, on, principal) =>
      requireSidecar(sidecar).react(node.id, cid, emoji, on, principal);
  }

  if (permits('delete')) {
    handle.remove = (opts) => vfs.remove(node.id, opts);
    handle.restore = () => vfs.restore(node.id);
  }

  return handle;
}

/** One collection, and the operations the caller may perform in it. */
function collectionHandle(vfs, collectionId, held) {
  const permits = (capability) => held.has(capability);
  const handle = {
    id: collectionId,
    granted: held === ALL ? 'system' : [...held].sort().join(','),
  };

  if (permits('read')) {
    handle.list = (opts) => vfs.list(collectionId, opts);
    handle.usage = () => vfs.storageUsage(collectionId);
    handle.storage = () => vfs.storageFor(collectionId);
  }

  if (permits('write')) {
    handle.createUpload = (req) => vfs.createUpload({ ...req, collectionId });
    handle.writeFile = (name, body, opts) => vfs.writeFile(name, body, { ...opts, collectionId });
  }

  if (permits('delete')) {
    // The trash follows `delete`, not `read`. Seeing what you deleted and undoing it
    // are not lesser rights than deleting — and its contents are items that are no
    // longer part of the drive, which a reader has no business enumerating.
    handle.listTrash = (opts) => vfs.listTrash(collectionId, opts);
    // Scoped by listing THIS collection's trash and destroying those rows.
    //
    // `vfs.purgeTrash` is the retention sweeper: it takes `{ before, limit }` and no
    // collection at all, because it runs for the whole drive on a timer. Handing it a
    // `collectionId` it does not read looked collection-scoped and was not — a `delete`
    // grant on one collection would have emptied every other collection's trash.
    handle.purgeTrash = async ({ limit = 1000 } = {}) => {
      const trash = await vfs.listTrash(collectionId, { limit });
      let purged = 0;
      for (const node of trash) {
        await vfs.remove(node.id, { permanent: true }).then(() => { purged++; }).catch(() => {});
      }
      return { purged };
    };
  }

  return handle;
}

/**
 * `deps = { node: { principal, id, capability } }`
 *
 * Resolves the node, asserts the capability on ITS collection, and yields a
 * handle shaped by what was granted. Throws — so the lease fails and the action
 * never runs — when the node is missing or the capability is not held.
 */
export class NodeAccessProvider extends Provider {
  static deps = ['vfs', 'sidecar', 'collections', 'config'];

  constructor({ vfs, sidecar, collections, config }) {
    super();
    this.vfs = vfs;
    this.sidecar = sidecar;
    this.collections = collections;
    this.config = config;
  }

  // `id` is anything `stat` resolves: a node id, a `trove:` URI, or a name — and a
  // name is only unique within a collection, hence the hint. The capability is still
  // asserted on the collection the node TURNS OUT to be in, never on the hint, so
  // naming the wrong collection finds nothing rather than authorizing against it.
  // `trashed: true` widens resolution to include the trash, which `stat` deliberately
  // cannot see — restoring and permanently deleting are the only operations on items
  // that are no longer part of the drive. It widens WHAT IS VISIBLE, never what is
  // permitted: the capability is asserted exactly the same way afterwards.
  async obtain({ principal, id, collectionId, trashed = false, capability = 'read' } = {}) {
    if (!id) throw TroveError.invalid('A node id is required');
    assertCapability(capability);
    const vfs = await this.vfs.obtain();
    const sidecar = await this.sidecar.obtain();
    const node = trashed ? await vfs.statAny(id, collectionId) : await vfs.stat(id, collectionId);

    const config = await this.config.obtain();
    if (!enforcing(config)) return nodeHandle(vfs, sidecar, node, requested(capability));

    // `assert` throws when the capability is not held. Nothing here decides from
    // presence: if the service is missing this raises, it does not allow.
    const collections = await this.collections.obtain();
    const collection = await collections.assert(principal, node.collectionId, capability);
    // Shaped by what the principal HOLDS — asked of the one thing that knows —
    // narrowed to what this call asked for.
    return nodeHandle(vfs, sidecar, node,
      intersect(collections.capabilities(principal, collection), requested(capability)));
  }

  // vfs is a lazy singleton: its release is a no-op and the handle holds nothing
  // else, so there is nothing to give back.
  release() {}
}

/**
 * `deps = { collection: { principal, id, capability } }`
 *
 * The same, for operations named by collection rather than by node — listing,
 * usage, starting an upload.
 */
export class CollectionAccessProvider extends Provider {
  static deps = ['vfs', 'collections', 'config'];

  constructor({ vfs, collections, config }) {
    super();
    this.vfs = vfs;
    this.collections = collections;
    this.config = config;
  }

  async obtain({ principal, id = 'default', capability = 'read' } = {}) {
    assertCapability(capability);
    const vfs = await this.vfs.obtain();
    const config = await this.config.obtain();
    if (!enforcing(config)) return collectionHandle(vfs, id, requested(capability));

    const collections = await this.collections.obtain();
    const collection = await collections.assert(principal, id, capability);
    return collectionHandle(vfs, id,
      intersect(collections.capabilities(principal, collection), requested(capability)));
  }

  release() {}
}

/**
 * `deps = { upload: { principal, id } }`
 *
 * An upload is a conversation, not a call: negotiate, sign or push parts, report them,
 * commit. It spans several requests keyed only by an unguessable `uploadId`, which is
 * why every one of them has to re-check — a grant revoked between `POST /api/uploads`
 * and `complete` must stop the upload, and "we checked at the start" would not.
 *
 * The check was `assertUploadCap`: look the session up to learn its collection, assert
 * `write` there, then drive an unrestricted `vfs` with the raw id. Six routes, and the
 * grant was thrown away in every one. Here the session IS the handle.
 */
export class UploadAccessProvider extends Provider {
  static deps = ['vfs', 'collections', 'config'];

  constructor({ vfs, collections, config }) {
    super();
    this.vfs = vfs;
    this.collections = collections;
    this.config = config;
  }

  async obtain({ principal, id } = {}) {
    if (!id) throw TroveError.invalid('An upload id is required');
    const vfs = await this.vfs.obtain();
    // Resolving first is what makes the check possible at all: only the session knows
    // which collection the bytes are destined for.
    const session = await vfs.uploadStatus(id);
    const config = await this.config.obtain();
    if (enforcing(config)) {
      const collections = await this.collections.obtain();
      await collections.assert(principal, session.collectionId, 'write');
    }
    return {
      id,
      collectionId: session.collectionId,
      status: () => vfs.uploadStatus(id),
      signPart: (n) => vfs.signUploadPart(id, n),
      reportPart: (n, etag) => vfs.reportUploadPart(id, n, etag),
      uploadPart: (n, bodyStream, opts) => vfs.uploadPart(id, n, bodyStream, opts),
      complete: (parts) => vfs.completeUpload(id, parts),
      abort: () => vfs.abortUpload(id),
    };
  }

  release() {}
}

/**
 * The background domain's grant: unattended work, no user behind it.
 *
 * Separate providers rather than a `system: true` option on the ones above, and
 * that distinction is the whole point. An option is a value in a declaration —
 * it can be copied from another action, set from a variable, or arrive from
 * somewhere it should not. A separate provider has to be named in `deps` by an
 * action that means it, which puts "this runs unauthorized" in the one place a
 * reader is already looking to find out what an action touches.
 */
export class SystemNodeProvider extends Provider {
  static deps = ['vfs', 'sidecar'];
  constructor({ vfs, sidecar }) { super(); this.vfs = vfs; this.sidecar = sidecar; }
  async obtain({ id } = {}) {
    if (!id) throw TroveError.invalid('A node id is required');
    const vfs = await this.vfs.obtain();
    return nodeHandle(vfs, await this.sidecar.obtain(), await vfs.stat(id), ALL);
  }
  release() {}
}

export class SystemCollectionProvider extends Provider {
  static deps = ['vfs'];
  constructor({ vfs }) { super(); this.vfs = vfs; }
  async obtain({ id = 'default' } = {}) {
    return collectionHandle(await this.vfs.obtain(), id, ALL);
  }
  release() {}
}

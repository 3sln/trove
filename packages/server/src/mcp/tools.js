// What an agent can actually do with the drive.
//
// Every tool here goes through the SAME permission checks the HTTP API uses. That is the
// whole security posture: an agent holding Alice's token is Alice, with Alice's
// collections and Alice's write access, and there is no MCP-shaped bypass around the
// collection ACL. The alternative — a service account the agent shares — would mean one
// compromised agent reads everyone's drive.
//
// Descriptions are written for a MODEL to read. That means saying what a tool is FOR and
// when to reach for it, not restating the parameter names it can already see in the
// schema. The single most valuable sentence in this file is the one telling the model
// that this drive has no folders, because every model assumes otherwise and will
// otherwise spend its turns looking for a path that does not exist.

import { TroveError } from '@trove/core';
import { troveUri } from '@trove/core/links.js';
import { toolText } from './protocol.js';

// A file read has to fit in a context window and in memory. Past this the tool returns
// the head and says so, which is far more useful than refusing or than silently
// truncating and letting the model reason about half a document as if it were whole.
const MAX_READ_BYTES = 256 * 1024;
const MAX_RESULTS = 50;

const INSTRUCTIONS = `Trove is a personal file drive with semantic search.

There are NO FOLDERS and no paths. Files live in flat "collections" (the default one is
called "default"), and are found by searching rather than by browsing a tree. If you are
looking for something, search for it — do not try to construct a path.

Files reference each other with trove: URIs (trove:default?name=notes.md). Search matches
meaning as well as words, so a description of the content works as a query.`;

/**
 * Whether this deployment has an ACL layer at all — from configuration, never from
 * whether `ctx.collections` happens to be there. The two agree while everything is
 * wired correctly and diverge exactly when it is not, and here the failure mode is an
 * agent quietly reading every collection in the drive.
 */
const enforcing = (ctx) => ctx.config?.collections !== false;

/**
 * Collections this principal can read, or undefined when there is no ACL layer.
 *
 * `undefined` means "do not scope the query", which is only correct when there is
 * nothing to scope BY. Search and backlinks reach across collections by design, so an
 * unscoped query hands back names, ids and `trove:` URIs from collections the caller
 * cannot read.
 */
async function readable(ctx, narrowTo) {
  if (!enforcing(ctx)) return undefined;
  const ids = (await ctx.collections.list(ctx.principal)).map((c) => c.id);
  return narrowTo ? ids.filter((id) => id === narrowTo) : ids;
}

/**
 * A file, and the operations this agent may perform on it.
 *
 * `access.node` resolves by id, by name within a collection, or by `trove:` URI, and
 * throws when the capability is not held — so a tool that gets a handle back is a tool
 * that may act. Missing becomes the sentence a MODEL should read: "Item" tells it
 * nothing, and it will retry the same call.
 */
async function fileHandle(ctx, file, collectionId, capability) {
  try {
    return await ctx.access.node(file, capability, { collectionId });
  } catch (err) {
    if (err?.code === 'not_found') throw TroveError.notFound(`No file called "${file}"`);
    throw err;
  }
}

/** Everything about a node worth telling a model, and nothing internal. */
function describeNode(node) {
  return {
    id: node.id,
    name: node.name,
    uri: troveUri(node),
    collection: node.collectionId,
    contentType: node.contentType,
    size: node.size,
    updatedAt: node.updatedAt,
    ...(node.tags && Object.keys(node.tags).length ? { tags: node.tags } : {}),
  };
}

const textLike = (type) => !type || /^text\/|json|xml|yaml|javascript|csv|markdown|x-sh/.test(type);

async function readText(handle) {
  const { stream } = await handle.read({ range: { start: 0, end: MAX_READ_BYTES } });
  const text = await new Response(stream).text();
  return { text, truncated: handle.size > MAX_READ_BYTES };
}

/**
 * Register Trove's tools on an McpServer.
 *
 * `ctx` at call time carries { vfs, collections, principal } — the same objects the HTTP
 * routes get, so the two surfaces cannot drift apart on what a given user may do.
 */
export function registerTroveTools(server) {
  server.instructions = INSTRUCTIONS;

  server.tool({
    name: 'search_files',
    title: 'Search the drive',
    readOnly: true,
    description:
      'Search the drive by meaning and by keyword. This is the primary way to find anything — '
      + 'there are no folders to browse. A natural description of the content works ("notes about '
      + 'the boat refit"); so does an exact phrase. Append #tag to require a tag, or #key:value to '
      + 'compare one (=, !=, <, <=, >, >=). Returns matching files with a snippet where there is one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in words.' },
        collection: { type: 'string', description: 'Restrict to one collection. Omit to search everything you can read.' },
        limit: { type: 'integer', description: `Maximum results (default 10, max ${MAX_RESULTS}).` },
      },
      required: ['query'],
    },
    async run({ query, collection, limit }, ctx) {
      if (!query?.trim()) throw TroveError.invalid('query is required');
      const collectionIds = await readable(ctx, collection);
      const { results, resolved } = await ctx.vfs.query(query, {
        limit: Math.min(Math.max(1, limit || 10), MAX_RESULTS),
        collectionIds,
      });
      const items = results.map((r) => ({
        ...describeNode(r.node),
        score: r.score,
        ...(r.snippet ? { snippet: r.snippet } : {}),
      }));
      if (!items.length) {
        // Saying "nothing matched" beats an empty array: a model reading `[]` often
        // retries the identical query, while a sentence prompts it to rephrase.
        return toolText(`No files matched "${query}". Try different words — search matches meaning, so a description of the content works.`,
          { structured: { results: [] } });
      }
      return toolText(JSON.stringify({ resolved, results: items }, null, 2), { structured: { results: items } });
    },
  });

  server.tool({
    name: 'list_files',
    title: 'List a collection',
    readOnly: true,
    description:
      'List what is in a collection, most recently changed first. Use this to see what exists; use '
      + 'search_files to find something specific. Large collections are paged — pass the returned '
      + 'cursor to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Which collection (default: "default").' },
        cursor: { type: 'string', description: 'Continue from a previous call.' },
        limit: { type: 'integer', description: `Maximum items (default 25, max ${MAX_RESULTS}).` },
      },
    },
    async run({ collection = 'default', cursor, limit }, ctx) {
      // The description promises recency and `list` defaults to alphabetical, so it
      // has to be asked for. An agent answering "what did I add recently?" off the top
      // of an alphabetical list is confidently wrong in a way nothing surfaces.
      const page = await (await ctx.access.collection(collection, 'read')).list({
        cursor, sort: 'updatedAt', order: 'desc',
        limit: Math.min(Math.max(1, limit || 25), MAX_RESULTS),
      });
      const items = (page.items || []).map(describeNode);
      return toolText(JSON.stringify({
        collection, items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }, null, 2), { structured: { items, nextCursor: page.nextCursor || null } });
    },
  });

  server.tool({
    name: 'read_file',
    title: 'Read a file',
    readOnly: true,
    description:
      'Read a file\'s text. Identify it by id, by name, or by a trove: URI — whichever you have. '
      + 'Binary files (images, video, archives) are not returned as text; their details are '
      + 'returned instead so you know what is there.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'A file id, a name, or a trove: URI.' },
        collection: { type: 'string', description: 'Which collection to look in when given a name (default: "default").' },
      },
      required: ['file'],
    },
    async run({ file, collection = 'default' }, ctx) {
      const handle = await fileHandle(ctx, file, collection, 'read');
      const node = handle.node;
      if (!textLike(node.contentType)) {
        return toolText(`"${node.name}" is ${node.contentType || 'binary'} (${node.size} bytes) and has no text to read.\n`
          + JSON.stringify(describeNode(node), null, 2), { structured: describeNode(node) });
      }
      const { text, truncated } = await readText(handle);
      // Saying it was cut off matters: a model that believes it read a whole document
      // will confidently answer questions about the part it never saw.
      return toolText(truncated
        ? `${text}\n\n[truncated — showing the first ${MAX_READ_BYTES} bytes of ${node.size}]`
        : text);
    },
  });

  server.tool({
    name: 'write_file',
    title: 'Write a file',
    description:
      'Create a file, or replace one that already has this name. Requires write access to the '
      + 'collection. Link to other files with trove: URIs (trove:default?name=other.md) — that is '
      + 'how things are related here, since there are no folders.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The file name, including its extension.' },
        content: { type: 'string', description: 'The text to write.' },
        collection: { type: 'string', description: 'Which collection (default: "default").' },
        contentType: { type: 'string', description: 'Override the type guessed from the name.' },
      },
      required: ['name', 'content'],
    },
    async run({ name, content, collection = 'default', contentType }, ctx) {
      if (!name?.trim()) throw TroveError.invalid('name is required');
      const into = await ctx.access.collection(collection, 'write');
      // No contentType falls through to the vfs's own guess from the name.
      const node = await into.writeFile(name, content ?? '', { contentType });
      return toolText(`Wrote ${node.name} (${node.size} bytes) — ${troveUri(node)}`,
        { structured: describeNode(node) });
    },
  });

  server.tool({
    name: 'delete_file',
    title: 'Move a file to the trash',
    description:
      'Move a file to the trash. It leaves the drive but is kept and can be restored, so this is '
      + 'recoverable — it does not destroy anything. Requires delete access to the collection.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'A file id, a name, or a trove: URI.' },
        collection: { type: 'string', description: 'Which collection to look in when given a name.' },
      },
      required: ['file'],
    },
    async run({ file, collection = 'default' }, ctx) {
      const handle = await fileHandle(ctx, file, collection, 'delete');
      await handle.remove();
      return toolText(`Moved "${handle.name}" to the trash. It can be restored from the drive's trash.`);
    },
  });

  server.tool({
    name: 'list_collections',
    title: 'List collections',
    readOnly: true,
    description:
      'List the collections you can see and what you may do in each. Collections are the top-level '
      + 'division of the drive — the closest thing here to a folder, except they do not nest.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      if (!enforcing(ctx)) {
        return toolText(JSON.stringify({ collections: [{ id: 'default', capabilities: ['read', 'write', 'delete'] }] }, null, 2));
      }
      const list = await ctx.collections.list(ctx.principal);
      return toolText(JSON.stringify({ collections: list }, null, 2), { structured: { collections: list } });
    },
  });

  server.tool({
    name: 'get_file_info',
    title: 'Get a file\'s details',
    readOnly: true,
    description:
      'Everything known about one file — type, size, when it changed, its tags, and which other '
      + 'files link to it. Use the backlinks to follow how things are connected.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'A file id, a name, or a trove: URI.' },
        collection: { type: 'string', description: 'Which collection to look in when given a name.' },
      },
      required: ['file'],
    },
    async run({ file, collection = 'default' }, ctx) {
      const handle = await fileHandle(ctx, file, collection, 'read');
      const node = handle.node;
      // Scoped, exactly like the HTTP route. Backlinks reach ACROSS collections by
      // design — that is what makes them useful — so an unscoped query hands back the
      // names, ids and trove: URIs of files inside collections the caller cannot read.
      const collectionIds = await readable(ctx);
      const backlinks = await handle.backlinks({ limit: 20, collectionIds })
        // Distinguishable from "nothing links here", which in a drive with no folders is
        // a load-bearing fact an agent will reason from.
        .catch((err) => { throw TroveError.transient(`Could not read backlinks: ${err.message}`); });
      const info = {
        ...describeNode(node),
        backlinks: (backlinks || []).map((n) => ({ id: n.id, name: n.name, uri: troveUri(n) })),
      };
      return toolText(JSON.stringify(info, null, 2), { structured: info });
    },
  });

  // Resources, so a client that prefers attaching context to a conversation over calling
  // a tool has the same reach. The URIs are Trove's own `trove:` scheme rather than
  // something invented for MCP — one name for a file across the whole system.
  server.resources({
    async list(params, ctx) {
      const ids = await readable(ctx);
      const out = [];
      for (const cid of ids || ['default']) {
        const page = await (await ctx.access.collection(cid, 'read')).list({ limit: 100 });
        for (const node of page.items || []) {
          out.push({
            uri: troveUri(node),
            name: node.name,
            mimeType: node.contentType || 'application/octet-stream',
            ...(node.size != null ? { size: node.size } : {}),
          });
        }
      }
      return { resources: out };
    },
    async read(params, ctx) {
      let handle;
      try {
        handle = await ctx.access.node(params.uri, 'read');
      } catch (err) {
        if (err?.code === 'not_found') throw TroveError.notFound(`No such resource: ${params.uri}`);
        throw err;
      }
      const node = handle.node;
      if (!textLike(node.contentType)) {
        // Base64 rather than refusing: a client that asked for an image wants the image.
        const { stream } = await handle.read({ range: { start: 0, end: MAX_READ_BYTES } });
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return { contents: [{ uri: params.uri, mimeType: node.contentType, blob: btoa(bin) }] };
      }
      const { text } = await readText(handle);
      return { contents: [{ uri: params.uri, mimeType: node.contentType || 'text/plain', text }] };
    },
  });

  return server;
}

export { MAX_READ_BYTES, INSTRUCTIONS };

// SidecarStore — cold persistence for sidecar documents. Each file's sidecar is
// a single JSON object stored in the SAME pluggable storage backend as the file
// bytes (S3/filesystem/memory), under a reserved `sidecars/` key space. This
// keeps social/metadata state next to the data, with zero extra infrastructure,
// and lets an S3 deployment need no database at all for conversations.

import { emptyDoc } from './document.js';
import { wrapError } from '../errors.js';

function keyFor(nodeId) {
  return `sidecars/${nodeId}.json`;
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class SidecarStore {
  /** @param {{storage: import('../storage/interface.js').StorageBackend}} deps */
  constructor({ storage }) {
    this.storage = storage;
  }

  /** @returns {Promise<object|null>} the raw CRDT doc, or null if none yet. */
  async load(nodeId) {
    try {
      const { stream } = await this.storage.get(keyFor(nodeId));
      const bytes = await readAll(stream);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
      const e = wrapError(err);
      if (e.code === 'not_found') return null;
      throw e;
    }
  }

  async save(nodeId, doc) {
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    await this.storage.put(keyFor(nodeId), bytes, { contentType: 'application/json' });
  }

  async remove(nodeId) {
    await this.storage.delete(keyFor(nodeId)).catch(() => {});
  }

  emptyDoc(nodeId) {
    return emptyDoc(nodeId);
  }
}

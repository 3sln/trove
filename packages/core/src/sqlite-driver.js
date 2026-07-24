// Open a SQLite database using whichever driver the runtime provides: Bun's
// built-in `bun:sqlite` or Node's built-in `node:sqlite` (Node ≥ 22.5). Both
// expose the same statement API — prepare().run/get/all(...params), exec() for
// raw/multi-statement SQL, close() — and differ only in the constructor, so
// callers get one `db` handle that behaves identically under either runtime.

import { TroveError } from './errors.js';

export async function openDatabase(pathOrMemory = ':memory:') {
  if (typeof Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    return new Database(pathOrMemory);
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(pathOrMemory);
  } catch (err) {
    throw TroveError.unsupported(
      'No SQLite driver available — run under Bun (bun:sqlite) or Node ≥ 22.5 (node:sqlite), or supply another store',
      { cause: err },
    );
  }
}

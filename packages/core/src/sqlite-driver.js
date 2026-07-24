// Open a SQLite database using whichever driver the runtime provides: Bun's
// built-in `bun:sqlite` or Node's built-in `node:sqlite` (Node ≥ 22.5). Both
// expose the same statement API — prepare().run/get/all(...params), exec() for
// raw/multi-statement SQL, close() — and differ only in the constructor, so
// callers get one `db` handle that behaves identically under either runtime.

import { TroveError } from './errors.js';

export async function openDatabase(pathOrMemory = ':memory:') {
  const db = await open(pathOrMemory);
  // Durability/concurrency defaults for file-backed dbs: WAL survives an ungraceful
  // stop far better than the rollback journal, and a busy_timeout avoids spurious
  // "database is locked" under concurrent readers/writers. (No-op for :memory:.)
  if (pathOrMemory !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
    } catch { /* pragmas are best-effort */ }
  }
  return db;
}

async function open(pathOrMemory) {
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

// Open a SQLite database using whichever driver the runtime provides: Bun's
// built-in `bun:sqlite` or Node's built-in `node:sqlite` (Node ≥ 22.5). Both
// expose the same statement API — prepare().run/get/all(...params), exec() for
// raw/multi-statement SQL, close() — and differ only in the constructor, so
// callers get one `db` handle that behaves identically under either runtime.
//
// Both also load extensions, which is what sqlite-vec needs for a durable vector index:
// node:sqlite via `allowExtension` at construction, bun:sqlite natively. The one place
// that is not true is macOS under Bun, where the system libsqlite3 Bun links is built
// without extension support — see useExtensionCapableSqlite below.
//
// better-sqlite3 is deliberately not used here. It would add a native dependency that
// every consumer installs, including Workers deployments that can never call it, in
// exchange for a feature set both built-ins already have — and it does not survive the
// trade: constructing one under Bun 1.2.23 and 1.3.14 on macOS arm64 aborts the process
// with `NAPI FATAL ERROR`, which is a panic rather than a throw and so cannot even be
// caught and fallen back from.

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

// Held in a variable so a bundler cannot read it.
//
// `await import('bun:sqlite')` behind a `typeof Bun` guard still fails to BUILD for
// Workers: esbuild resolves a literal specifier statically, and a guard is a runtime
// thing that says nothing about what the bundler does with the module graph. The result
// was a wrangler build that could not link, from an import that would never have run.
// A non-literal specifier is not resolvable at build time, so it survives as a runtime
// import — which the guard then never reaches.
const BUN_SQLITE = 'bun:sqlite';

// Where a SQLite that can load extensions tends to live on macOS. Ordered: an explicit
// setting wins, then Homebrew on Apple Silicon, then Homebrew on Intel.
const MACOS_SQLITE_CANDIDATES = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
];

let customSqliteTried = false;

/**
 * Point Bun at a SQLite that can load extensions, on the one platform where it cannot.
 *
 * `bun:sqlite` supports extensions natively — `loadExtension` is right there and works
 * on Linux with nothing special. macOS is the exception, and not because of Bun: the
 * SYSTEM libsqlite3 that Bun links by default is built without
 * SQLITE_ENABLE_LOAD_EXTENSION, so the call comes back "This build of sqlite3 does not
 * support dynamic extension loading". The effect is that sqlite-vec cannot load, and
 * semantic search silently degrades to an in-memory index rebuilt on every restart —
 * on developer laptops specifically, which is where it is least likely to be noticed.
 *
 * `setCustomSQLite` is Bun's documented answer. It has to happen before any database is
 * opened, hence doing it here rather than at the point extensions are wanted.
 *
 * Best-effort throughout: if no capable library is installed we leave Bun on the system
 * one and the sqlite-vec store degrades exactly as it did before, with its own warning.
 * Set TROVE_SQLITE_LIB to override the search.
 */
async function useExtensionCapableSqlite(Database) {
  if (customSqliteTried || process.platform !== 'darwin') return;
  customSqliteTried = true;
  if (typeof Database.setCustomSQLite !== 'function') return;

  const configured = process.env.TROVE_SQLITE_LIB;
  const { existsSync } = await import('node:fs');
  const candidates = configured ? [configured] : MACOS_SQLITE_CANDIDATES;
  for (const lib of candidates) {
    if (!existsSync(lib)) continue;
    try {
      Database.setCustomSQLite(lib);
      return;
    } catch { /* keep looking; the default is still a working database */ }
  }
  // Only worth saying when it was asked for explicitly — otherwise this is the ordinary
  // case of a machine without Homebrew sqlite, and the vector store says its own piece.
  if (configured) {
    console.warn(`[trove] TROVE_SQLITE_LIB=${configured} could not be used; falling back to the system SQLite`);
  }
}

async function open(pathOrMemory) {
  if (typeof Bun !== 'undefined') {
    const { Database } = await import(BUN_SQLITE);
    await useExtensionCapableSqlite(Database);
    return new Database(pathOrMemory);
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    // `allowExtension` has to be set at CONSTRUCTION — enableLoadExtension() alone
    // isn't enough on node:sqlite. It only permits loading; nothing is loaded unless
    // something asks (the sqlite-vec store does, and degrades if it can't).
    return new DatabaseSync(pathOrMemory, { allowExtension: true });
  } catch (err) {
    throw TroveError.unsupported(
      'No SQLite driver available — run under Bun (bun:sqlite) or Node ≥ 22.5 (node:sqlite), or supply another store',
      { cause: err },
    );
  }
}

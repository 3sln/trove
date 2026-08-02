// SQLite on Cloudflare D1.
//
// The Workers deployment was the one with a hole in it: storage had R2, vectors had
// Vectorize, and metadata said "implement the MetadataStore interface over env.DB" —
// which is a way of saying it didn't work. The provider interface is six methods, and
// D1 speaks almost exactly the same dialect, so this closes it.
//
// Two things about D1 shape the design, and neither is a detail an operator should have
// to discover from a stack trace:
//
//   1. **A binding is one database.** LocalSqliteProvider hands out sibling FILES for
//      plugin scopes, which is what keeps one plugin's SQL out of another's. There is no
//      "create me another database" call on D1, so a scope with no binding of its own is
//      refused rather than quietly co-located — plugin isolation is a security boundary,
//      and silently collapsing it is the wrong way to save an operator a config line.
//   2. **No sqlite-vec.** The vector half of search cannot live here. Use Vectorize (the
//      worker adapter wires it from the binding); the keyword half is fine, since D1
//      compiles in FTS5.

import { TroveError } from './errors.js';
import { SqliteDatabase, SqliteProvider } from './sqlite.js';

// The keys the server co-locates in one database — see LocalSqliteProvider.
const CORE_KEYS = new Set(['metadata', 'kv', 'plugins', 'search']);

// D1 answers `PRAGMA journal_mode = WAL` with SQLITE_AUTH: setting a pragma is not
// something a D1 client may do. The shared metadata schema opens with two of them, and
// that runs in SqliteStore.init() — so the first request a Workers drive ever served
// died, and every one after it, on a statement that is pure local-file housekeeping and
// means nothing here. Dropped rather than made conditional at the call site: this is the
// one place that knows it is talking to D1.
//
// Only ASSIGNMENTS. `PRAGMA table_info(nodes)` is a query, D1 supports it, and the trash
// migration reads it to decide whether it has already run — filtering that too would
// silently re-run migrations.
const PRAGMA_ASSIGNMENT = /^\s*PRAGMA\s+[\w.]+\s*=/i;
const notAPragmaAssignment = (statement) => !PRAGMA_ASSIGNMENT.test(statement);

/** Split a multi-statement DDL script into individual statements. */
function splitStatements(sql) {
  // Good enough for the schema DDL Trove ships, which contains no semicolons inside
  // string literals or triggers. Deliberately not a SQL parser: if that assumption ever
  // stops holding, the failure is a loud syntax error from D1 rather than a silent
  // half-applied migration.
  return String(sql)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

class D1Database extends SqliteDatabase {
  /** @param {{prepare: Function, batch: Function, exec?: Function}} d1 a D1 binding */
  constructor(d1) {
    super();
    this.d1 = d1;
  }

  #stmt(sql, params) {
    const s = this.d1.prepare(sql);
    return params && params.length ? s.bind(...params) : s;
  }

  async exec(sql) {
    // D1's own exec() is documented as slow and unsuitable for anything hot; it is also
    // inconsistent about multi-statement input across versions. Batching prepared
    // statements is both faster and atomic, which is what schema setup wants.
    const statements = splitStatements(sql).filter(notAPragmaAssignment);
    if (!statements.length) return;
    if (statements.length === 1) {
      await this.d1.prepare(statements[0]).run();
      return;
    }
    await this.d1.batch(statements.map((s) => this.d1.prepare(s)));
  }

  async run(sql, ...params) {
    const res = await this.#stmt(sql, params).run();
    // Shaped like better-sqlite3's return so callers can't tell the difference. `meta`
    // is D1's; the field names differ by version, hence the fallbacks.
    return {
      changes: res?.meta?.changes ?? res?.meta?.rows_written ?? 0,
      lastInsertRowid: res?.meta?.last_row_id ?? null,
    };
  }

  async get(sql, ...params) {
    return (await this.#stmt(sql, params).first()) ?? null;
  }

  async all(sql, ...params) {
    const res = await this.#stmt(sql, params).all();
    return res?.results || [];
  }

  async batch(statements) {
    if (!statements?.length) return;
    // D1 batches are atomic — one implicit transaction, rolled back as a unit. That is
    // exactly the guarantee LocalSqliteDatabase gets from BEGIN/COMMIT, so callers keep
    // the same promise on both.
    await this.d1.batch(statements.map(({ sql, params = [] }) =>
      (params.length ? this.d1.prepare(sql).bind(...params) : this.d1.prepare(sql))));
  }

  async close() { /* D1 bindings are managed by the runtime */ }
}

export class D1SqliteProvider extends SqliteProvider {
  /**
   * @param {object} opts
   * @param {object} opts.db      the main D1 binding (metadata, kv, plugin installs)
   * @param {Record<string, object>} [opts.scopes]
   *   extra bindings by key, for scopes that need their own database.
   * @param {object} [opts.pluginStore]
   *   one binding to hold EVERY plugin scope. A scope key embeds the runtime principal,
   *   so it cannot be pre-bound and D1 cannot create databases on demand — without this,
   *   plugin storage simply doesn't exist on Workers.
   */
  constructor({ db, scopes = {}, pluginStore = null } = {}) {
    super();
    if (!db) throw TroveError.invalid('D1SqliteProvider requires a D1 binding (env.DB)');
    this.main = new D1Database(db);
    this.scopes = new Map(Object.entries(scopes).map(([k, v]) => [k, new D1Database(v)]));
    // The catch-all for plugin scopes (see obtain).
    this.pluginStore = pluginStore ? new D1Database(pluginStore) : null;
  }

  // D1 is a real database that survives the isolate being torn down — which is the
  // whole question this flag answers, and the reason the search index may live here.
  get durable() { return true; }

  async obtain({ key }) {
    if (CORE_KEYS.has(key)) return this.main;
    const scoped = this.scopes.get(key);
    if (scoped) return scoped;
    // One binding for every plugin store.
    //
    // A plugin scope key embeds the runtime principal — `pstore:alice@x.com:plg:acme/notes`
    // — so it can never be pre-bound, and D1 cannot create a database on demand. The
    // adapter's `scopes: { plugins: … }` therefore bound a name that (a) is a CORE key
    // already, so it short-circuited to `main`, and (b) is not what any real store asks
    // for: every /api/plugins/:id/sql call on Workers was a 501.
    //
    // So a deployment may nominate ONE database to hold them all. Weaker isolation than
    // the local provider's file-per-scope — the tables live side by side — but the keys
    // are still distinct per (user, plugin) and it is the strongest thing D1's model
    // allows. Stated here rather than discovered.
    // ONE BINDING FOR EVERY PLUGIN SCOPE, and it is a compromise rather than a design.
    // The tables live side by side: distinct names per (user, plugin), no boundary
    // between them. `DurableObjectSqliteProvider` is the one that gets this right — a DO
    // is addressable by name, so each scope is its own object with its own database, and
    // creating one on demand is the thing D1 cannot do. Prefer it where a Durable Object
    // is available; this stays for deployments that have only D1.
    if (this.pluginStore) return this.pluginStore;
    // Plugin scopes are an isolation boundary. Handing back the main database would
    // put a plugin's tables next to the drive's metadata, which is precisely what the
    // scope exists to prevent.
    throw TroveError.unsupported(
      `No D1 binding for the "${key}" store. D1 cannot create databases on demand, so a `
      + 'plugin scope needs its own binding — add one to the Worker and pass it as '
      + `scopes: { "${key}": env.YOUR_BINDING }. Plugin data is not co-located with the `
      + 'drive metadata by design.',
    );
  }

  async drop({ key }) {
    // Dropping a D1 database is an account-level operation, not something a request can
    // do. Emptying it is the closest honest equivalent, and it is what uninstall means:
    // the plugin's data is gone.
    const db = CORE_KEYS.has(key) ? null : this.scopes.get(key);
    if (!db) return;
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    );
    if (!tables.length) return;
    await db.batch(tables.map((t) => ({ sql: `DROP TABLE IF EXISTS "${String(t.name).replace(/"/g, '""')}"` })));
  }

  async close() { /* nothing to release */ }
}

export { D1Database, splitStatements };

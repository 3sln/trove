// A Durable Object per scope — plugin storage on Workers, done properly.
//
// `D1SqliteProvider` cannot do this, and its own comment says why: a plugin scope key
// embeds the runtime principal (`pstore:alice@x.com:plg:acme/notes`), so it can never be
// pre-bound, and D1 cannot create a database on demand. What shipped instead was one
// nominated binding holding every plugin's tables for every user side by side — weaker
// isolation than the local provider's file-per-scope, kept only because it was the
// strongest thing D1's model allowed. The keys stayed distinct; the boundary was a naming
// convention.
//
// A Durable Object is addressable BY NAME, which is exactly the missing primitive:
// `obtain({ key })` becomes a lookup, the object is created on first use, and each one
// carries its own SQLite storage. The isolation is structural rather than a prefix.
//
// The seam does not change. This is a third sibling next to the local and D1 providers,
// returning the same `SqliteDatabase` surface, and a deployment picks it by declaring the
// binding.
//
// WHAT A DO COSTS, so nobody is surprised: it is single-threaded and lives in one place,
// so every query for a scope routes there. For per-user plugin state — a listening
// position, a reader's notes — that is exactly right. For something read from everywhere
// at once it would be a bottleneck, and that is a different problem than this one.

import { TroveError } from './errors.js';
import { SqliteDatabase, SqliteProvider } from './sqlite.js';

/**
 * One scope's database, reached through its Durable Object.
 *
 * Every call is a `fetch` at the stub. Batched where the interface allows it, because a
 * round trip per statement to a single-threaded object is the one thing that would make
 * this slower than the shared table it replaces.
 */
class DurableObjectDatabase extends SqliteDatabase {
  constructor(stub, key) {
    super();
    this.stub = stub;
    this.key = key;
  }

  async #call(op, sql, params) {
    const res = await this.stub.fetch('https://trove.store/sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, sql, params }),
    });
    const body = await res.json().catch(() => ({ error: `store returned ${res.status}` }));
    // The DO reports a SQL error as data rather than as a 500, so the message survives the
    // trip — a plugin that wrote bad SQL should read its own error, not "500".
    if (!res.ok || body?.error) throw TroveError.invalid(body?.error || `store returned ${res.status}`);
    return body.result;
  }

  async exec(sql) { await this.#call('exec', sql); }
  async run(sql, ...params) { return this.#call('run', sql, params); }
  async get(sql, ...params) { return this.#call('get', sql, params); }
  async all(sql, ...params) { return this.#call('all', sql, params); }
  async batch(statements) { return this.#call('batch', null, statements); }
}

export class DurableObjectSqliteProvider extends SqliteProvider {
  /**
   * @param {object} opts
   * @param {{idFromName: Function, get: Function}} opts.namespace a DurableObjectNamespace
   * @param {SqliteProvider} [opts.core] where the CORE keys go — metadata, kv, installs,
   *   search. Those are one-per-deployment and already have a home; this provider exists
   *   for the keys that are one-per-(user, plugin).
   */
  constructor({ namespace, core = null } = {}) {
    super();
    if (!namespace?.idFromName) throw TroveError.invalid('DurableObjectSqliteProvider requires a Durable Object namespace');
    this.namespace = namespace;
    this.core = core;
    this._dbs = new Map();
  }

  // A Durable Object's storage survives the isolate, the deploy and the restart. That is
  // the whole question this flag answers.
  get durable() { return true; }

  async obtain({ key }) {
    if (!key) throw TroveError.invalid('a scope key is required');
    // Core keys keep whatever the deployment already gave them. Routing the metadata
    // store through a DO would put the whole drive behind one single-threaded object,
    // which is the bottleneck this file's header warns about.
    if (this.core && !isPluginScope(key)) return this.core.obtain({ key });

    let db = this._dbs.get(key);
    if (!db) {
      // NAMED BY THE SCOPE KEY, which is what makes the isolation structural: two scopes
      // are two objects with two databases, not two prefixes in one.
      const stub = this.namespace.get(this.namespace.idFromName(key));
      db = new DurableObjectDatabase(stub, key);
      this._dbs.set(key, db);
    }
    return db;
  }

  async drop({ key }) {
    if (this.core && !isPluginScope(key)) return this.core.drop({ key });
    const db = this._dbs.get(key);
    this._dbs.delete(key);
    // Ask the object to empty itself. Its storage outlives this process, so forgetting the
    // handle here would leave the data behind — which for an uninstalled plugin is the
    // difference between "removed" and "invisible".
    if (db) await db.stub.fetch('https://trove.store/drop', { method: 'POST' }).catch(() => {});
  }

  async close() { this._dbs.clear(); }
}

/** Plugin scopes are the ones that cannot be pre-bound — see the header. */
export function isPluginScope(key) {
  return typeof key === 'string' && key.startsWith('pstore:');
}

/**
 * The Durable Object class itself.
 *
 * Deliberately thin: it owns `state.storage.sql` and answers the verbs above. Everything
 * that decides WHAT may run — `assertSafePluginSql`, the scope gate — already happened on
 * the way in, and repeating it here would put two authorities on one question.
 *
 * Export it from the Worker entry and declare it in wrangler.toml with a
 * `new_sqlite_classes` migration, the same way TroveTasks is declared.
 */
export function createPluginStore() {
  return class TrovePluginStore {
    constructor(state) {
      this.state = state;
      this.sql = state.storage.sql;
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/drop') {
        // `deleteAll` takes the tables with it, which is the point: an uninstalled
        // plugin's data should stop existing rather than stop being addressed.
        await this.state.storage.deleteAll();
        return json({ result: { ok: true } });
      }
      const { op, sql, params } = await request.json().catch(() => ({}));
      try {
        return json({ result: this.#run(op, sql, params) });
      } catch (err) {
        // As DATA, not a 500: the message is the plugin author's own SQL error and is the
        // only useful thing anyone will get back.
        return json({ error: err?.message || String(err) });
      }
    }

    #run(op, sql, params) {
      const bind = (s, p) => [...this.sql.exec(s, ...(p || []))];
      switch (op) {
        case 'exec':
          // Multi-statement schema setup. `exec` takes one statement at a time here, so a
          // schema arrives split — which is also what makes it safe to run per statement.
          for (const s of String(sql).split(';').map((x) => x.trim()).filter(Boolean)) this.sql.exec(s);
          return { ok: true };
        case 'run': {
          bind(sql, params);
          return { changes: this.sql.rowsWritten, lastInsertRowid: null };
        }
        case 'get': return bind(sql, params)[0] ?? null;
        case 'all': return bind(sql, params);
        case 'batch': {
          // ATOMIC. A DO's storage transaction is what makes a batch mean what it says;
          // running the statements loose would leave a half-applied schema behind on the
          // first bad one.
          const out = [];
          this.state.storage.transactionSync(() => {
            for (const st of params || []) out.push(bind(st.sql, st.params));
          });
          return out;
        }
        default: throw new Error(`Unknown store op "${op}"`);
      }
    }
  };
}

const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

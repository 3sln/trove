// Which SQL a plugin may run against its own database.
//
// Its own module rather than part of sqlite.js because BOTH sides of the mirror need it
// and only one of them can load a driver: the server checks before touching the on-disk
// store, and the browser checks before touching the wasm one. Importing sqlite.js from
// the web bundle would drag `bun:sqlite` in behind it.

import { TroveError } from '../errors.js';

// Plugins run SQL against their OWN isolated database, but on a shared-filesystem
// provider the sibling scope files are guessable, so `ATTACH DATABASE` would be an
// isolation escape (and `DETACH` its pair). Strip comments + string/identifier
// literals first so the keyword can't hide inside a value, then reject.

// ATTACH/DETACH would reach a sibling scope's file. VACUUM INTO is worse and less
// obvious: it writes a complete SQLite database to any path the server process can
// create, whose pages contain rows the caller chose — attacker-chosen bytes at an
// attacker-chosen path (a cron file, a webroot, authorized_keys). PRAGMA is refused
// because several of them (database_list, temp_store_directory) either disclose host
// paths or move where files land.
const DANGEROUS_SQL = /\b(ATTACH|DETACH|VACUUM|PRAGMA)\b/i;

/** Blank out --/**-comments and '..'/".."/`..`/[..] literals, preserving length-ish. */
export function stripSqlLiterals(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < sql.length) {
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; }
        i++;
      }
      out += ' '; continue;
    }
    if (c === '[') { const e = sql.indexOf(']', i); i = e < 0 ? sql.length : e + 1; out += ' '; continue; }
    out += c; i++;
  }
  return out;
}

/** Throw if plugin-supplied SQL tries to escape its isolated database. */
export function assertSafePluginSql(sql) {
  if (typeof sql !== 'string' || !sql) throw TroveError.invalid('SQL statement is required');
  if (DANGEROUS_SQL.test(stripSqlLiterals(sql))) {
    throw TroveError.invalid('ATTACH, DETACH, VACUUM and PRAGMA are not permitted in plugin storage');
  }
}


#!/usr/bin/env bun
// Take a consistent backup of a running Trove's database.
//
//   bun scripts/backup.mjs ./data/trove.db ./backups/trove-2026-07-26.db
//   node scripts/backup.mjs ./data/trove.db ./backups/trove-2026-07-26.db
//
// WHY THIS EXISTS. The obvious advice — `sqlite3 db ".backup out.db"` — requires the
// sqlite3 CLI, which is not in the image Trove ships (oven/bun:1-slim), so following it
// inside the container fails. `VACUUM INTO` is SQLite's own online-backup statement: it
// runs through the driver already present, takes a read lock rather than blocking
// writers for the duration, and produces a single defragmented file.
//
// And DO NOT just copy the file. In WAL mode the database is three files (.db, -wal,
// -shm) and the newest committed data lives in the -wal; copying the .db alone yields a
// backup that opens cleanly and is silently missing your most recent work — the worst
// kind of backup, because it looks like one.
//
// The objects are separate. This backs up metadata, the search index, KV and plugin
// records — everything except the bytes, which are in your filesystem root or bucket
// and want their own tooling (rsync, bucket versioning, replication).

import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('usage: backup.mjs <source.db> <target.db>');
  process.exit(2);
}

const src = resolve(source);
const dst = resolve(target);
if (src === dst) {
  console.error('refusing to back up a database over itself');
  process.exit(2);
}
try {
  await stat(dst);
  // Never overwrite: a backup script that clobbers the previous backup can destroy the
  // only good copy at the exact moment the live database is broken.
  console.error(`${dst} already exists — pick a new name (backups should not overwrite each other)`);
  process.exit(2);
} catch { /* the normal case: it doesn't exist yet */ }

await mkdir(dirname(dst), { recursive: true });

const { openDatabase } = await import('../packages/core/src/sqlite-driver.js');
const db = await openDatabase(src);
const started = Date.now();
try {
  // Single-quoted SQL string literal; the path is ours, and a quote in it would be a
  // syntax error rather than an injection, but escape it anyway.
  db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
} finally {
  db.close?.();
}
const { size } = await stat(dst);
console.log(`backed up ${src} → ${dst} (${(size / 1048576).toFixed(1)} MB in ${Date.now() - started}ms)`);
console.log('Remember: this is metadata + the search index. Back up your objects separately.');

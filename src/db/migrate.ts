/**
 * Migration ladder (ADR 0004): numbered SQL files in migrations/ are the ONLY
 * DDL source. Applied idempotently at daemon startup and by every test fixture.
 * A schema_version row records the applied head.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '../log.js';

const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function appliedHead(db: Database.Database): number {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
    .get();
  if (table === undefined) return 0;
  const row = db.prepare('SELECT MAX(version) AS head FROM schema_version').get() as {
    head: number | null;
  };
  return row.head ?? 0;
}

/** Apply every migration above the recorded head, in order, each in a transaction. */
export function migrate(db: Database.Database, migrationsDir: string, log?: Logger): void {
  const files = readdirSync(migrationsDir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();

  const head = appliedHead(db);
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (match?.[1] === undefined) continue;
    const version = Number.parseInt(match[1], 10);
    if (version <= head) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      const recorded = db
        .prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = ?')
        .get(version) as { n: number };
      if (recorded.n === 0) {
        throw new Error(
          `migration ${file} did not record its schema_version row (version ${version})`,
        );
      }
    })();
    log?.info('migration applied', { file, version });
  }
}

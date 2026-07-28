/**
 * Guarded transitions (contracts/job-lifecycle.md): legal transitions apply;
 * illegal ones are rejected AND logged, never applied; terminal states are
 * final. Migration ladder applies clean on a scratch DB twice (idempotent head).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { transitionJob } from '../src/db/transitions.js';
import type { JobStatus } from '../src/types.js';
import { MIGRATIONS_DIR, makeTestLogger, type TestLogger } from './helpers.js';

function insertJob(db: Database.Database, id: string, status: JobStatus): void {
  db.prepare(
    `INSERT INTO jobs (id, type, title, status, workdir, log_path, created_at, sentinel_path)
     VALUES (?, 'test', 'test job', ?, '/tmp', '/tmp/log', ?, '/tmp/sentinel.json')`,
  ).run(id, status, new Date().toISOString());
}

function statusOf(db: Database.Database, id: string): JobStatus {
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: JobStatus };
  return row.status;
}

describe('migration ladder', () => {
  it('applies the full ladder twice on a scratch DB without error (idempotent)', () => {
    const db = openDatabase(':memory:');
    const log = makeTestLogger();
    migrate(db, MIGRATIONS_DIR, log);
    migrate(db, MIGRATIONS_DIR, log); // second apply must be a no-op, not a crash

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBe(7); // 0001 init + 0002 turns + 0003 pending + 0004 jobs.retry_of + 0005 settings + 0006 promotions + 0007 app_outbox

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('jobs');
    expect(names).toContain('schema_version');
    expect(names).toContain('settings');
    expect(names).toContain('promotions');
    expect(names).toContain('app_outbox');

    // Each migration applied exactly once: one version row per rung.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(rows.n).toBe(7);

    // 0002/0003 are additive: existing rows backfill turns = 0, pending = 0.
    db.prepare(`INSERT INTO sessions (session_id, started_at) VALUES ('s1', '2026-07-06')`).run();
    const session = db
      .prepare('SELECT turns, pending FROM sessions WHERE session_id = ?')
      .get('s1') as { turns: number; pending: number };
    expect(session.turns).toBe(0);
    expect(session.pending).toBe(0);
    db.close();
  });

  it('upgrades a v2-head DB (the live pre-incident shape): 0003 backfills pending = 0, idempotently', () => {
    // Build a DB at ladder head 2 with a live materialized session — exactly
    // the state the 2026-07-06 incident daemon woke up to.
    const db = openDatabase(':memory:');
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8'));
    db.exec(readFileSync(join(MIGRATIONS_DIR, '0002_sessions_turns.sql'), 'utf8'));
    db.prepare(
      `INSERT INTO sessions (session_id, started_at, is_current) VALUES ('sess-live', '2026-07-05T22:00:00Z', 1)`,
    ).run();

    migrate(db, MIGRATIONS_DIR);
    migrate(db, MIGRATIONS_DIR); // second apply must be a no-op, not a crash

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBe(7);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(rows.n).toBe(7);

    // 0004 is additive: pre-existing jobs rows backfill retry_of = NULL.
    insertJob(db, 'job-pre-0004', 'queued');
    const job = db.prepare(`SELECT retry_of FROM jobs WHERE id = 'job-pre-0004'`).get() as {
      retry_of: string | null;
    };
    expect(job.retry_of).toBeNull();

    // The pre-existing live session is NOT pending (turns lies at 0 — fine).
    const session = db
      .prepare(`SELECT turns, pending FROM sessions WHERE session_id = 'sess-live'`)
      .get() as { turns: number; pending: number };
    expect(session.turns).toBe(0);
    expect(session.pending).toBe(0);
    db.close();
  });
});

describe('guarded job transitions', () => {
  let db: Database.Database;
  let log: TestLogger;

  beforeEach(() => {
    db = openDatabase(':memory:');
    log = makeTestLogger();
    migrate(db, MIGRATIONS_DIR, log);
  });

  afterEach(() => {
    db.close();
  });

  it('applies queued → running and running → succeeded', () => {
    insertJob(db, 'job-1', 'queued');

    const toRunning = transitionJob(db, log, 'job-1', 'running');
    expect(toRunning.applied).toBe(true);
    expect(statusOf(db, 'job-1')).toBe('running');

    const toSucceeded = transitionJob(db, log, 'job-1', 'succeeded');
    expect(toSucceeded.applied).toBe(true);
    expect(statusOf(db, 'job-1')).toBe('succeeded');

    const row = db.prepare('SELECT started_at, ended_at FROM jobs WHERE id = ?').get('job-1') as {
      started_at: string | null;
      ended_at: string | null;
    };
    expect(row.started_at).not.toBeNull();
    expect(row.ended_at).not.toBeNull();
  });

  it('rejects succeeded → running (terminal is FINAL) and logs the rejection', () => {
    insertJob(db, 'job-2', 'queued');
    transitionJob(db, log, 'job-2', 'running');
    transitionJob(db, log, 'job-2', 'succeeded');

    const late = transitionJob(db, log, 'job-2', 'running');
    expect(late.applied).toBe(false);
    expect(statusOf(db, 'job-2')).toBe('succeeded'); // NOT applied

    const rejection = log.entries.find(
      (e) => e.level === 'warn' && e.msg.includes('transition rejected'),
    );
    expect(rejection).toBeDefined();
    expect(rejection?.fields).toMatchObject({ jobId: 'job-2', from: 'succeeded', to: 'running' });
  });

  it('rejects queued → succeeded (skipping running)', () => {
    insertJob(db, 'job-3', 'queued');
    const result = transitionJob(db, log, 'job-3', 'succeeded');
    expect(result.applied).toBe(false);
    expect(statusOf(db, 'job-3')).toBe('queued');
  });

  it('rejects every write to killed (terminal)', () => {
    insertJob(db, 'job-4', 'queued');
    transitionJob(db, log, 'job-4', 'killed');
    for (const to of ['queued', 'running', 'succeeded', 'failed'] as const) {
      expect(transitionJob(db, log, 'job-4', to).applied).toBe(false);
    }
    expect(statusOf(db, 'job-4')).toBe('killed');
  });

  it('rejects transitions on unknown job ids', () => {
    const result = transitionJob(db, log, 'no-such-job', 'running');
    expect(result.applied).toBe(false);
    expect(log.entries.some((e) => e.msg.includes('job not found'))).toBe(true);
  });
});

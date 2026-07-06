/**
 * Guarded transitions (contracts/job-lifecycle.md): legal transitions apply;
 * illegal ones are rejected AND logged, never applied; terminal states are
 * final. Migration ladder applies clean on a scratch DB twice (idempotent head).
 */

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
  it('applies migration 0001 twice on a scratch DB without error (idempotent)', () => {
    const db = openDatabase(':memory:');
    const log = makeTestLogger();
    migrate(db, MIGRATIONS_DIR, log);
    migrate(db, MIGRATIONS_DIR, log); // second apply must be a no-op, not a crash

    const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number;
    };
    expect(version.v).toBe(1);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('jobs');
    expect(names).toContain('schema_version');

    // Applied exactly once: a single version row.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(rows.n).toBe(1);
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

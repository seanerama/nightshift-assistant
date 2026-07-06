/**
 * Job runner (contracts/job-lifecycle.md): happy path, sentinel authority,
 * bounded retries, kill, reconciliation, concurrency, the default-deny worker
 * env (FIX-H3), and the kill-switch. The worker binary is stubbed at the
 * agentBin seam (test/fixtures/worker-stub.cjs) — never the runner logic.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { transitionJob } from '../src/db/transitions.js';
import { workerEnv } from '../src/jobs/env.js';
import { createJobRunner, JobError, type JobRunner } from '../src/jobs/runner.js';
import type { JobRecord } from '../src/types.js';
import {
  MIGRATIONS_DIR,
  makeConfig,
  makeTestLogger,
  type TestLogger,
  WORKER_STUB,
  waitFor,
} from './helpers.js';

interface Notice {
  job: JobRecord;
  notice: string;
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A pid guaranteed dead: a node child that already ran to completion. */
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined) throw new Error('could not obtain a dead pid');
  return child.pid;
};

describe('job runner', () => {
  let tmpDir: string;
  let workdir: string;
  let db: Database.Database;
  let log: TestLogger;
  let notices: Notice[];

  const makeRunner = (overrides: Partial<Config> = {}): JobRunner => {
    const config = makeConfig({
      jobsEnabled: true,
      agentBin: WORKER_STUB,
      jobKillGraceSec: 1,
      ...overrides,
    });
    const runner = createJobRunner(db, log, config, { appDir: tmpDir });
    runner.onFinish((job, notice) => {
      notices.push({ job, notice });
    });
    return runner;
  };

  const submit = (runner: JobRunner, instruction: string): JobRecord =>
    runner.submit({
      schema: 1,
      type: 'test',
      title: 'test job',
      instruction,
      workdir,
      env: 'minimal',
    });

  /** Simulate a row persisted by a PREVIOUS daemon life (no in-process exit handler). */
  const insertOrphanRunningRow = (opts: { pid: number | null; sentinel?: unknown }): string => {
    const id = randomUUID();
    const dir = join(tmpDir, 'jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instruction.txt'), 'MODE=success');
    db.prepare(
      `INSERT INTO jobs (id, schema, type, title, status, workdir, log_path, attempts,
                         created_at, sentinel_path)
       VALUES (?, 1, 'test', 'orphan', 'queued', ?, ?, 0, ?, ?)`,
    ).run(
      id,
      workdir,
      join(dir, 'worker.log'),
      new Date().toISOString(),
      join(dir, 'sentinel.json'),
    );
    transitionJob(db, log, id, 'running');
    db.prepare('UPDATE jobs SET pid = ? WHERE id = ?').run(opts.pid, id);
    if (opts.sentinel !== undefined) {
      writeFileSync(join(dir, 'sentinel.json'), JSON.stringify(opts.sentinel));
    }
    return id;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-jobs-'));
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir);
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    log = makeTestLogger();
    notices = [];
  });

  afterEach(() => {
    // Reap any sleeper the test failed to kill (workers are detached).
    for (const row of db.prepare(`SELECT pid FROM jobs WHERE status = 'running'`).all() as Array<{
      pid: number | null;
    }>) {
      // Never reap ourselves: the live-pid reconciler test parks process.pid on a row.
      if (row.pid !== null && row.pid !== process.pid && pidIsAlive(row.pid)) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('happy path', () => {
    it('submit → queued → running (pid) → success sentinel → succeeded, one notice', async () => {
      const runner = makeRunner();
      const record = submit(runner, 'MODE=success do the work');

      // A free slot starts it immediately: running with pid + session id persisted.
      expect(record.status).toBe('running');
      expect(record.pid).toBeTypeOf('number');
      expect(record.sessionId).not.toBeNull();
      expect(record.attempts).toBe(0);
      expect(record.createdAt).toBeTruthy();
      expect(record.startedAt).toBeTruthy();
      expect(record.logPath).toBe(join(tmpDir, 'jobs', record.id, 'worker.log'));
      expect(record.sentinelPath).toBe(join(tmpDir, 'jobs', record.id, 'sentinel.json'));

      await waitFor(() => runner.get(record.id)?.status === 'succeeded');
      const done = runner.get(record.id);
      expect(done?.endedAt).toBeTruthy();

      // Per-job dir holds the log (worker stdout) and the sentinel.
      expect(readFileSync(record.logPath, 'utf8')).toContain('worker stub started');
      expect(existsSync(record.sentinelPath)).toBe(true);

      // Exactly one finish notification, carrying the sentinel summary.
      await waitFor(() => notices.length >= 1);
      await new Promise((r) => setTimeout(r, 150));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.job.status).toBe('succeeded');
      expect(notices[0]?.notice).toContain('Job succeeded');
      expect(notices[0]?.notice).toContain('stub work complete');
    });

    it('get() and list() read rows; list filters by status', async () => {
      const runner = makeRunner();
      const record = submit(runner, 'MODE=success');
      await waitFor(() => runner.get(record.id)?.status === 'succeeded');

      expect(runner.get('nope')).toBeNull();
      expect(runner.list()).toHaveLength(1);
      expect(runner.list({ status: 'succeeded' })).toHaveLength(1);
      expect(runner.list({ status: 'queued' })).toHaveLength(0);
    });
  });

  describe('sentinel authority (the sole success signal)', () => {
    it.each([
      ['clean exit WITHOUT a sentinel', 'MODE=no-sentinel', 'no completion sentinel'],
      ['a failure sentinel', 'MODE=failure-sentinel', 'stub could not finish'],
      ['a malformed sentinel', 'MODE=malformed-sentinel', 'not valid JSON'],
      ['nonzero exit without a sentinel', 'MODE=exit-nonzero', 'no completion sentinel'],
    ])('%s takes the failure path', async (_desc, instruction, expected) => {
      const runner = makeRunner({ jobRetryCap: 1 }); // land terminal on the first failure
      const record = submit(runner, instruction);

      await waitFor(() => runner.get(record.id)?.status === 'failed');
      await waitFor(() => notices.length >= 1);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.job.status).toBe('failed');
      expect(notices[0]?.notice).toContain('Job failed');
      expect(notices[0]?.notice).toContain(expected);
      // Failure notices carry the log tail.
      expect(notices[0]?.notice).toContain('log line 12');
    });
  });

  describe('bounded retries', () => {
    it('persistent failure retries up to the cap, then terminal failed with ONE notice', async () => {
      const runner = makeRunner({ jobRetryCap: 2 });
      const record = submit(runner, 'MODE=no-sentinel');

      // Chain terminal: exactly one notification, after the cap is exhausted.
      await waitFor(() => notices.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.job.attempts).toBe(2);
      expect(notices[0]?.notice).toContain('after 2 attempt(s)');

      // Two rows: the original (failed, attempts 1) and the linked retry (failed, attempts 2).
      const all = runner.list();
      expect(all).toHaveLength(2);
      const original = runner.get(record.id);
      expect(original?.status).toBe('failed');
      expect(original?.attempts).toBe(1);
      const retry = all.find((j) => j.id !== record.id);
      expect(retry?.retryOf).toBe(record.id);
      expect(retry?.status).toBe('failed');
      expect(retry?.attempts).toBe(2);
      expect(runner.list({ status: 'queued' })).toHaveLength(0);
      expect(runner.list({ status: 'running' })).toHaveLength(0);
    });

    it('a retry that succeeds notifies success exactly once (no notice for the retried row)', async () => {
      // MODE=flaky fails on the first run in this workdir and succeeds on the
      // retry (marker file in cwd) — a real fail-once-then-recover chain.
      const runner = makeRunner({ jobRetryCap: 2 });
      const record = submit(runner, 'MODE=flaky');

      await waitFor(() => notices.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.job.status).toBe('succeeded');
      expect(notices[0]?.job.retryOf).toBe(record.id);
      expect(notices[0]?.notice).toContain('flaky succeeded on retry');
      expect(runner.get(record.id)?.status).toBe('failed'); // intermediate row: logged, not notified
    });
  });

  describe('kill', () => {
    it('SIGTERMs a sleeping worker → process dead, row killed, one notice, no retry', async () => {
      const runner = makeRunner();
      const record = submit(runner, 'MODE=sleep SLEEP_MS=60000');
      await waitFor(() => runner.get(record.id)?.pid !== null);
      const pid = runner.get(record.id)?.pid as number;
      expect(pidIsAlive(pid)).toBe(true);

      const killed = runner.kill(record.id);
      expect(killed.status).toBe('killed');
      expect(killed.endedAt).toBeTruthy();

      await waitFor(() => !pidIsAlive(pid));
      // The exit handler fires after the kill; the terminal row rejects its
      // transition — no failure path, no retry row, no second notice.
      await new Promise((r) => setTimeout(r, 200));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.notice).toContain('Job killed');
      expect(runner.list()).toHaveLength(1);
      expect(runner.get(record.id)?.attempts).toBe(0);
    });

    it('escalates to SIGKILL after the grace period when SIGTERM is ignored', async () => {
      const runner = makeRunner({ jobKillGraceSec: 1 });
      const record = submit(runner, 'MODE=sleep IGNORE_SIGTERM SLEEP_MS=60000');
      await waitFor(() => runner.get(record.id)?.pid !== null);
      const pid = runner.get(record.id)?.pid as number;

      runner.kill(record.id);
      expect(runner.get(record.id)?.status).toBe('killed');
      expect(pidIsAlive(pid)).toBe(true); // SIGTERM ignored; grace running
      await waitFor(() => !pidIsAlive(pid), 4000);
    });

    it('kills a queued job without a process and rejects unknown ids', async () => {
      const runner = makeRunner({ maxJobs: 1 });
      const sleeper = submit(runner, 'MODE=sleep SLEEP_MS=60000');
      const queued = submit(runner, 'MODE=success');
      expect(runner.get(queued.id)?.status).toBe('queued');

      const killed = runner.kill(queued.id);
      expect(killed.status).toBe('killed');
      expect(killed.pid).toBeNull();
      expect(notices).toHaveLength(1);

      expect(() => runner.kill('no-such-id')).toThrow(JobError);
      runner.kill(sleeper.id);
    });
  });

  describe('reconciler', () => {
    it('settles a dead-pid running row as succeeded when its sentinel is valid', async () => {
      const id = insertOrphanRunningRow({
        pid: deadPid(),
        sentinel: { schema: 1, status: 'success', summary: 'finished before the restart' },
      });
      const runner = makeRunner();
      runner.reconcile();

      expect(runner.get(id)?.status).toBe('succeeded');
      await new Promise((r) => setTimeout(r, 100));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.notice).toContain('finished before the restart');
    });

    it('settles a dead-pid running row without a sentinel through the failure path', async () => {
      const id = insertOrphanRunningRow({ pid: deadPid() });
      const runner = makeRunner({ jobRetryCap: 1 });
      runner.reconcile();

      expect(runner.get(id)?.status).toBe('failed');
      await new Promise((r) => setTimeout(r, 100));
      expect(notices).toHaveLength(1);
      expect(notices[0]?.notice).toContain('reconciled');
    });

    it('a reconciled failure below the cap re-queues a linked retry that can succeed', async () => {
      // Orphan died without a sentinel; its persisted instruction is MODE=success,
      // so the auto-submitted retry runs and the CHAIN ends succeeded — one notice.
      const id = insertOrphanRunningRow({ pid: deadPid() });
      const runner = makeRunner({ jobRetryCap: 2 });
      runner.reconcile();

      expect(runner.get(id)?.status).toBe('failed');
      await waitFor(() => notices.length >= 1);
      expect(notices).toHaveLength(1);
      expect(notices[0]?.job.status).toBe('succeeded');
      expect(notices[0]?.job.retryOf).toBe(id);
    });

    it('leaves a running row with a LIVE pid alone', async () => {
      const id = insertOrphanRunningRow({ pid: process.pid }); // this test process: alive
      const runner = makeRunner();
      runner.reconcile();

      expect(runner.get(id)?.status).toBe('running');
      await new Promise((r) => setTimeout(r, 100));
      expect(notices).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('with max 1, the second submit stays queued until the first finishes, then auto-starts', async () => {
      const runner = makeRunner({ maxJobs: 1 });
      const first = submit(runner, 'MODE=sleep SLEEP_MS=400');
      const second = submit(runner, 'MODE=success');

      expect(runner.get(first.id)?.status).toBe('running');
      expect(runner.get(second.id)?.status).toBe('queued');

      await waitFor(() => runner.get(first.id)?.status === 'succeeded');
      await waitFor(() => runner.get(second.id)?.status === 'succeeded');
      await waitFor(() => notices.length === 2);
    });

    it('counts LIVE processes, not raw running rows: a dead-pid row frees its slot', () => {
      insertOrphanRunningRow({ pid: deadPid() }); // dead row would block a row-count check
      const runner = makeRunner({ maxJobs: 1, jobRetryCap: 1 });
      const record = submit(runner, 'MODE=sleep SLEEP_MS=60000');
      // The live count ignores the dead pid, so the new job starts immediately.
      expect(record.status).toBe('running');
      runner.kill(record.id);
    });
  });

  describe('default-deny worker env (FIX-H3)', () => {
    it('workerEnv() copies ONLY the allow-list', () => {
      const env = workerEnv({
        PATH: '/usr/bin',
        HOME: '/home/u',
        USER: 'u',
        SHELL: '/bin/bash',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm',
        WEBEX_BOT_TOKEN: 'secret-token',
        WEBEX_WEBHOOK_SECRET: 'secret-hmac',
        WEBEX_OWNER_PERSON_ID: 'owner',
        NIGHTSHIFT_DB_PATH: 'data/nightshift.db',
        SMTP_PASSWORD: 'future-secret',
        CLOUDFLARE_API_TOKEN: 'future-secret',
      });
      expect(env).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/u',
        USER: 'u',
        SHELL: '/bin/bash',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm',
      });
    });

    it('a spawned worker sees the allow-list but NEVER the Webex credentials', async () => {
      const saved: Record<string, string | undefined> = {
        WEBEX_BOT_TOKEN: process.env.WEBEX_BOT_TOKEN,
        WEBEX_WEBHOOK_SECRET: process.env.WEBEX_WEBHOOK_SECRET,
        WEBEX_OWNER_PERSON_ID: process.env.WEBEX_OWNER_PERSON_ID,
      };
      process.env.WEBEX_BOT_TOKEN = 'live-secret-token';
      process.env.WEBEX_WEBHOOK_SECRET = 'live-secret-hmac';
      process.env.WEBEX_OWNER_PERSON_ID = 'live-owner-id';
      try {
        const runner = makeRunner();
        const record = submit(runner, 'MODE=dump-env');
        await waitFor(() => runner.get(record.id)?.status === 'succeeded');

        const dumped = JSON.parse(readFileSync(join(workdir, 'worker-env.json'), 'utf8')) as Record<
          string,
          string
        >;
        expect(dumped.PATH).toBeDefined(); // allow-list present (node was found via PATH)
        expect(dumped.WEBEX_BOT_TOKEN).toBeUndefined();
        expect(dumped.WEBEX_WEBHOOK_SECRET).toBeUndefined();
        expect(dumped.WEBEX_OWNER_PERSON_ID).toBeUndefined();
        // Nothing outside the allow-list leaks at all.
        const allowed = new Set([
          'PATH',
          'HOME',
          'USER',
          'SHELL',
          'LANG',
          'TERM',
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ]);
        for (const key of Object.keys(dumped)) {
          expect(allowed.has(key), `unexpected env var reached the worker: ${key}`).toBe(true);
        }
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  describe('kill-switch + submit validation', () => {
    it('rejects submit when NIGHTSHIFT_JOBS_ENABLED is off, inserting nothing', () => {
      const runner = makeRunner({ jobsEnabled: false });
      expect(() => submit(runner, 'MODE=success')).toThrow(JobError);
      expect(runner.list()).toHaveLength(0);
    });

    it('rejects invalid submit shapes (env other than minimal, bad schema, empty fields)', () => {
      const runner = makeRunner();
      const base = {
        schema: 1 as const,
        type: 'test',
        title: 't',
        instruction: 'MODE=success',
        workdir,
        env: 'minimal' as const,
      };
      expect(() => runner.submit({ ...base, env: 'full' as never })).toThrow(/env must be exactly/);
      expect(() => runner.submit({ ...base, schema: 2 as never })).toThrow(/schema/);
      expect(() => runner.submit({ ...base, instruction: '' })).toThrow(/instruction/);
      expect(() => runner.submit({ ...base, workdir: 42 as never })).toThrow(/workdir/);
      expect(runner.list()).toHaveLength(0);
    });
  });
});

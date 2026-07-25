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
    const runner = createJobRunner(db, log, config, { appDir: tmpDir, home: tmpDir });
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
      expect(notices[0]?.notice).toContain('✅ **test job** — test finished');
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
      expect(notices[0]?.notice).toContain('❌ **test job** — test failed after 1 attempt(s)');
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
      expect(notices[0]?.notice).toContain('⏹ **test job** — test killed');
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

    it('a spawned worker sees the allow-list but NEVER the Webex credentials, the API token, or the promotion infra creds', async () => {
      const saved: Record<string, string | undefined> = {
        WEBEX_BOT_TOKEN: process.env.WEBEX_BOT_TOKEN,
        WEBEX_WEBHOOK_SECRET: process.env.WEBEX_WEBHOOK_SECRET,
        WEBEX_OWNER_PERSON_ID: process.env.WEBEX_OWNER_PERSON_ID,
        NIGHTSHIFT_API_TOKEN: process.env.NIGHTSHIFT_API_TOKEN,
        CF_DNS_TOKEN: process.env.CF_DNS_TOKEN,
        COOLIFY_API_TOKEN: process.env.COOLIFY_API_TOKEN,
      };
      process.env.WEBEX_BOT_TOKEN = 'live-secret-token';
      process.env.WEBEX_WEBHOOK_SECRET = 'live-secret-hmac';
      process.env.WEBEX_OWNER_PERSON_ID = 'live-owner-id';
      // Stage 5 invariant: the control-API token must never reach a worker —
      // a worker must not be able to drive its own daemon (ADR 0007).
      process.env.NIGHTSHIFT_API_TOKEN = 'live-api-token';
      // Stage 11 invariant (ADR 0008): promotion infra creds are daemon-only.
      process.env.CF_DNS_TOKEN = 'live-cf-token';
      process.env.COOLIFY_API_TOKEN = 'live-coolify-token';
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
        expect(dumped.NIGHTSHIFT_API_TOKEN).toBeUndefined();
        expect(dumped.CF_DNS_TOKEN).toBeUndefined();
        expect(dumped.COOLIFY_API_TOKEN).toBeUndefined();
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

  describe('job-type registry spawns (Stage 6)', () => {
    const readJson = (path: string): Record<string, string> =>
      JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;

    const BASE_ALLOWED = new Set([
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'LANG',
      'TERM',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);

    /** Set env vars for a test and restore afterwards. */
    const withEnv = async (
      vars: Record<string, string>,
      body: () => Promise<void>,
    ): Promise<void> => {
      const saved: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(vars)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      try {
        await body();
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };

    it('a typed story worker spawns with the pipeline profile AFTER the base argv', async () => {
      const runner = makeRunner({ typesEnabled: true });
      const record = runner.submitType('story', { idea: 'MODE=dump-args turtles' });

      expect(record.type).toBe('story');
      expect(record.title).toBe('Story: MODE=dump-args turtles');
      expect(record.workdir).toBe(join(tmpDir, 'projects', 'mode-dump-args-turtles'));
      await waitFor(() => runner.get(record.id)?.status === 'succeeded');

      const args = JSON.parse(
        readFileSync(join(record.workdir, 'worker-args.json'), 'utf8'),
      ) as string[];
      // Base argv first (the -p prompt is the rendered skill instruction)…
      expect(args[0]).toBe('-p');
      expect(args[1]).toContain('/story:start MODE=dump-args turtles');
      expect(args[2]).toBe('--session-id');
      // …then the Stage 12 per-type model (single-value flag, BEFORE the
      // variadic --allowedTools so nothing can swallow its value)…
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(args.indexOf('--session-id'));
      expect(args[modelIdx + 1]).toBe('claude-opus-4-8'); // story runs Opus
      // …then the registry permission args (NEVER before -p: --allowedTools is
      // variadic and would swallow a following prompt — CLI v2.1.201 verified).
      expect(args.indexOf('--permission-mode')).toBeGreaterThan(modelIdx);
      expect(args.indexOf('--allowedTools')).toBeGreaterThan(modelIdx);
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
      const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('Bash(node *)');
      expect(allowed).toContain('Bash(ffmpeg *)');
      expect(allowed.split(' ')).not.toContain('Bash'); // never wholesale
    });

    it('an app-build worker spawns with the broadest (experimental) profile', async () => {
      const runner = makeRunner({ typesEnabled: true });
      const record = runner.submitType('app-build', { idea: 'MODE=dump-args tracker' });
      await waitFor(() => runner.get(record.id)?.status === 'succeeded');

      const args = JSON.parse(
        readFileSync(join(record.workdir, 'worker-args.json'), 'utf8'),
      ) as string[];
      expect(args).toContain('--permission-mode');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8'); // Stage 12
    });

    it('a story worker env = allow-list + the story extras and NOTHING else', () =>
      withEnv(
        {
          ELEVENLABS_API_KEY: 'tts-key',
          GEMINI_API_KEY: 'img-key',
          PERPLEXITY_API_KEY: 'pplx-key', // declared for study/brief, NOT story
          WEBEX_BOT_TOKEN: 'live-secret',
          NIGHTSHIFT_API_TOKEN: 'live-token',
        },
        async () => {
          const runner = makeRunner({ typesEnabled: true });
          const record = runner.submitType('story', { idea: 'MODE=dump-env turtles' });
          await waitFor(() => runner.get(record.id)?.status === 'succeeded');

          const dumped = readJson(join(record.workdir, 'worker-env.json'));
          expect(dumped.ELEVENLABS_API_KEY).toBe('tts-key');
          expect(dumped.GEMINI_API_KEY).toBe('img-key');
          expect(dumped.PERPLEXITY_API_KEY).toBeUndefined(); // not a story extra
          expect(dumped.WEBEX_BOT_TOKEN).toBeUndefined();
          expect(dumped.NIGHTSHIFT_API_TOKEN).toBeUndefined();
          const storyAllowed = new Set([
            ...BASE_ALLOWED,
            'ELEVENLABS_API_KEY',
            'OPENAI_API_KEY',
            'GEMINI_API_KEY',
            'GOOGLE_API_KEY',
            'NANOBANANA_API_KEY',
          ]);
          for (const key of Object.keys(dumped)) {
            expect(storyAllowed.has(key), `unexpected env var reached the worker: ${key}`).toBe(
              true,
            );
          }
        },
      ));

    it('a study worker gets ONLY its own declared extras (no story keys)', () =>
      withEnv({ ELEVENLABS_API_KEY: 'tts-key', PERPLEXITY_API_KEY: 'pplx-key' }, async () => {
        const runner = makeRunner({ typesEnabled: true });
        const record = runner.submitType('study', { topic: 'MODE=dump-env networking' });
        await waitFor(() => runner.get(record.id)?.status === 'succeeded');

        const dumped = readJson(join(record.workdir, 'worker-env.json'));
        expect(dumped.PERPLEXITY_API_KEY).toBe('pplx-key');
        expect(dumped.ELEVENLABS_API_KEY).toBeUndefined();
        const studyAllowed = new Set([...BASE_ALLOWED, 'PERPLEXITY_API_KEY']);
        for (const key of Object.keys(dumped)) {
          expect(studyAllowed.has(key), `unexpected env var reached the worker: ${key}`).toBe(true);
        }
      }));

    it('a typed guide worker spawns with the pipeline profile + heavy model and writes its marker (Stage 16)', async () => {
      const runner = makeRunner({ typesEnabled: true });
      const record = runner.submitType('guide', { topic: 'MODE=dump-args ebpf' });

      expect(record.type).toBe('guide');
      expect(record.title).toBe('Guide: MODE=dump-args ebpf');
      expect(record.workdir).toBe(join(tmpDir, 'projects', 'mode-dump-args-ebpf'));
      expect(readFileSync(join(tmpDir, 'jobs', record.id, 'job-type.txt'), 'utf8').trim()).toBe(
        'guide',
      );
      await waitFor(() => runner.get(record.id)?.status === 'succeeded');

      const args = JSON.parse(
        readFileSync(join(record.workdir, 'worker-args.json'), 'utf8'),
      ) as string[];
      expect(args[0]).toBe('-p');
      expect(args[1]).toContain('/tg:start MODE=dump-args ebpf');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8'); // Stage 12 heavy tier
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
      const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('Bash(node *)');
      expect(allowed).toContain('Bash(curl *)');
      expect(allowed).toContain('mcp__perplexity'); // Stage 18: the research seam
      expect(allowed.split(' ')).not.toContain('Bash'); // never wholesale
    });

    it('a RAW submit keeps the Stage 5 shape + the generic model even with the registry ENABLED', () =>
      withEnv({ ELEVENLABS_API_KEY: 'tts-key', PERPLEXITY_API_KEY: 'pplx-key' }, async () => {
        const runner = makeRunner({ typesEnabled: true });
        const record = submit(runner, 'MODE=dump-args plain worker');
        await waitFor(() => runner.get(record.id)?.status === 'succeeded');

        // Stage 12 DELIBERATE RE-PIN: the Stage 5 argv (-p <prompt>
        // --session-id <uuid>) grew EXACTLY one flag — the explicit generic
        // worker model. Model selection is runtime config, not a registry
        // feature, so it rides every worker spawn; everything else stays
        // pinned (no permission args, no extra env).
        const args = JSON.parse(
          readFileSync(join(workdir, 'worker-args.json'), 'utf8'),
        ) as string[];
        expect(args).toHaveLength(6);
        expect(args[0]).toBe('-p');
        expect(args[2]).toBe('--session-id');
        expect(args[4]).toBe('--model');
        expect(args[5]).toBe('claude-sonnet-5');

        const envRecord = submit(runner, 'MODE=dump-env plain worker');
        await waitFor(() => runner.get(envRecord.id)?.status === 'succeeded');
        const dumped = readJson(join(workdir, 'worker-env.json'));
        for (const key of Object.keys(dumped)) {
          expect(BASE_ALLOWED.has(key), `raw worker env grew a key: ${key}`).toBe(true);
        }
      }));

    it('kill-switch: non-generic submits reject while OFF; generic + raw are unaffected', async () => {
      const runner = makeRunner({ typesEnabled: false });
      expect(() => runner.submitType('story', { idea: 'bedtime' })).toThrow(
        /job type 'story' is disabled.*NIGHTSHIFT_TYPES_ENABLED/,
      );
      expect(runner.list()).toHaveLength(0);

      const generic = runner.submitType('generic', { instruction: 'MODE=dump-args', workdir });
      await waitFor(() => runner.get(generic.id)?.status === 'succeeded');
      // Stage 12: the model flag applies even with the registry OFF — a
      // generic spawn carries the generic model (never host-inherited).
      const args = JSON.parse(readFileSync(join(workdir, 'worker-args.json'), 'utf8')) as string[];
      expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
      const raw = submit(runner, 'MODE=success');
      await waitFor(() => runner.get(raw.id)?.status === 'succeeded');
    });

    it('unknown type rejects listing the known types; bad params reject per type', () => {
      const runner = makeRunner({ typesEnabled: true });
      expect(() => runner.submitType('research', {})).toThrow(
        /unknown job type: research \(known types: generic, story, study, brief, guide, note-ingest, app-build\)/,
      );
      expect(() => runner.submitType('story', {})).toThrow(/"idea" must be a non-empty string/);
      expect(() => runner.submitType('story', 'nope')).toThrow(/JSON object/);
      expect(runner.list()).toHaveLength(0);
    });

    it('submitType respects the JOBS kill-switch too', () => {
      const runner = makeRunner({ jobsEnabled: false, typesEnabled: true });
      expect(() => runner.submitType('story', { idea: 'x' })).toThrow(/job runner is disabled/);
    });

    it('a typed retry keeps its registry profile (marker copied to the fresh row)', async () => {
      // MODE=flaky: first run fails without a sentinel, the auto-retry succeeds.
      const runner = makeRunner({ typesEnabled: true, jobRetryCap: 2 });
      const record = runner.submitType('story', { idea: 'MODE=flaky turtles' });

      await waitFor(() => notices.length >= 1);
      expect(notices[0]?.job.status).toBe('succeeded');
      const retry = runner.list().find((j) => j.retryOf === record.id);
      expect(retry).toBeDefined();
      expect(
        readFileSync(join(tmpDir, 'jobs', retry?.id ?? '', 'job-type.txt'), 'utf8').trim(),
      ).toBe('story');
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

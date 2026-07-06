/**
 * Job runner (contracts/job-lifecycle.md): background worker sessions with
 * persisted, reconciled state. A worker is a `claude` child process (the
 * NIGHTSHIFT_AGENT_BIN seam) run in the job's workdir with the DEFAULT-DENY
 * env from workerEnv(); its only representation is the jobs row, and EVERY
 * status write flows through transitionJob() (the guarded state machine).
 *
 * Success authority (ENH-10): a worker succeeds ONLY by writing a valid
 * `{schema:1, status:'success', ...}` sentinel at sentinel_path. Everything
 * else — clean exit without a sentinel, unparsable sentinel, failure sentinel,
 * nonzero exit — takes the failure path. No progress heuristics, no
 * log-grepping.
 *
 * Retry semantics: the contract's state machine has NO running → queued edge,
 * so a below-cap failure marks the row terminal `failed` (a legal transition)
 * and auto-submits a FRESH queued row copying the job with the incremented
 * attempts count, linked via retry_of (migration 0004). transitionJob stays
 * untouched. Only the CHAIN-terminal state notifies: intermediate retried rows
 * log but do not fire onFinish (spec: "retries may log, only the terminal
 * state notifies"); succeeded/killed/at-cap-failed fire it exactly once,
 * guarded by the transition's `applied` result.
 *
 * Reconciliation (ENH-01): reconcile() — run by the app at startup and on the
 * 60s tick — checks every `running` row's pid against a live process
 * (process.kill(pid, 0)); dead → the shared exit routine (sentinel decides).
 * Concurrency counts LIVE processes via the same check, never raw row counts.
 * Workers are deliberately NOT killed on daemon shutdown: they are detached,
 * and the reconciler re-adopts them on restart via the persisted pid.
 *
 * Per-job dir jobs/<id>/ under the app dir holds instruction.txt (so queued
 * and retry rows survive a daemon restart), worker.log, and sentinel.json.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { transitionJob } from '../db/transitions.js';
import type { Logger } from '../log.js';
import type { JobRecord, JobSentinel, JobStatus, JobSubmit } from '../types.js';
import { workerEnv, workerEnvWith } from './env.js';
import {
  getJobType,
  type JobTypeEntry,
  JobTypeError,
  knownJobTypes,
  renderJobType,
} from './types.js';

/** Rejected submit/kill input (invalid shape, unknown id, or the kill-switch). */
export class JobError extends Error {}

const LOG_TAIL_LINES = 10;

/**
 * Fixed epilogue appended to every worker instruction. The "completion
 * sentinel JSON to: <path>" phrase is the worker's ONLY channel for the
 * sentinel location — keep it stable (the test stub parses it too).
 */
export function sentinelEpilogue(sentinelPath: string): string {
  return (
    '\n\n---\n' +
    'COMPLETION PROTOCOL (mandatory): when the task above is finished, as your ' +
    `FINAL act write the completion sentinel JSON to: ${sentinelPath}\n` +
    'Exact shape: {"schema": 1, "status": "success" | "failure", "summary": ' +
    '"<one-paragraph outcome>", "outputs": ["<produced file paths>"], "url": ' +
    '"<url if any>", "port": <port if any>} — outputs/url/port are optional. ' +
    'If the task cannot be completed, still write the sentinel with status ' +
    '"failure" and say why in the summary. Without a valid sentinel this job ' +
    'is recorded as FAILED regardless of your exit code.'
  );
}

interface JobRow {
  id: string;
  schema: number;
  type: string;
  title: string;
  status: JobStatus;
  pid: number | null;
  session_id: string | null;
  workdir: string;
  log_path: string;
  attempts: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  sentinel_path: string;
  retry_of: string | null;
}

export type FinishHandler = (job: JobRecord, notice: string) => void | Promise<void>;

export interface JobListFilter {
  status?: JobStatus;
}

export interface JobRunnerHooks {
  /** Base dir for jobs/<id>/ (default: daemon cwd) — tests only. */
  appDir?: string;
  /** Root for typed jobs' ~/projects/<slug> workdirs (default: os.homedir()) — tests only. */
  home?: string;
}

export interface JobRunner {
  /** Validate, insert `queued`, start if a concurrency slot is free. */
  submit(job: JobSubmit): JobRecord;
  /**
   * Stage 6 typed submit: render instruction/workdir/title from the job-type
   * registry; the worker later spawns with the type's permission profile +
   * extra env. Non-generic types reject unless NIGHTSHIFT_TYPES_ENABLED=true.
   */
  submitType(type: string, params: unknown): JobRecord;
  /** SIGTERM the live worker (SIGKILL after the grace period) → `killed`. */
  kill(id: string): JobRecord;
  get(id: string): JobRecord | null;
  list(filter?: JobListFilter): JobRecord[];
  /** Fires EXACTLY ONCE per terminal transition (retried rows excepted — see header). */
  onFinish(handler: FinishHandler): void;
  /** Startup + 60s tick: adopt/settle dead `running` rows, then fill free slots. */
  reconcile(): void;
}

export function createJobRunner(
  db: Database.Database,
  log: Logger,
  config: Config,
  hooks: JobRunnerHooks = {},
): JobRunner {
  const appDir = hooks.appDir ?? process.cwd();
  const home = hooks.home ?? homedir();

  let finishHandler: FinishHandler = () => undefined;

  const jobDir = (id: string): string => join(appDir, 'jobs', id);
  const instructionPath = (id: string): string => join(jobDir(id), 'instruction.txt');
  /**
   * Stage 6: registry-typed jobs persist their registry type at
   * jobs/<id>/job-type.txt (like instruction.txt — restart/retry-safe, no
   * migration). ONLY typed submits write it; raw submits — whatever their
   * type string says — never get one, so they keep the generic spawn shape.
   */
  const typeMarkerPath = (id: string): string => join(jobDir(id), 'job-type.txt');

  /** The registry entry a row spawns under, or null for the generic spawn shape. */
  const registryEntryFor = (id: string): JobTypeEntry | null => {
    // Kill-switch: with types off, EVERY spawn is the Stage 5 generic shape —
    // even a typed row queued while the flag was on (it will fail its skill
    // run rather than run with a profile the operator turned off).
    if (!config.typesEnabled) return null;
    let marker: string;
    try {
      marker = readFileSync(typeMarkerPath(id), 'utf8').trim();
    } catch {
      return null;
    }
    const entry = getJobType(marker);
    if (entry === undefined) {
      log.warn('job-type marker names an unregistered type; spawning generic', {
        jobId: id,
        marker,
      });
      return null;
    }
    return entry;
  };

  const getRow = (id: string): JobRow | null => {
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ?? null;
  };

  const toRecord = (row: JobRow): JobRecord => ({
    schema: 1,
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    pid: row.pid,
    sessionId: row.session_id,
    workdir: row.workdir,
    logPath: row.log_path,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sentinelPath: row.sentinel_path,
    retryOf: row.retry_of,
  });

  /** Exactly-once is enforced by callers (transition `applied` guards); this only delivers. */
  const emitFinish = (row: JobRow, notice: string): void => {
    try {
      const result = finishHandler(toRecord(row), notice);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          log.error('onFinish handler failed', {
            jobId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      log.error('onFinish handler failed', {
        jobId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isAlive = (pid: number | null): boolean => {
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = exists but not ours (still alive); ESRCH = gone.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  const logTail = (logPath: string): string => {
    try {
      const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
      return lines.slice(-LOG_TAIL_LINES).join('\n').slice(-4000);
    } catch {
      return '(no log output)';
    }
  };

  type SentinelVerdict = { ok: true; sentinel: JobSentinel } | { ok: false; reason: string };

  /** The SOLE success authority: a valid status:'success' sentinel, nothing else. */
  const readSentinel = (sentinelPath: string): SentinelVerdict => {
    let raw: string;
    try {
      raw = readFileSync(sentinelPath, 'utf8');
    } catch {
      return { ok: false, reason: 'no completion sentinel was written' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'completion sentinel is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, reason: 'completion sentinel is not a JSON object' };
    }
    const s = parsed as Partial<JobSentinel>;
    if (s.schema !== 1 || typeof s.summary !== 'string') {
      return { ok: false, reason: 'completion sentinel is malformed (schema/summary)' };
    }
    if (s.status === 'success') return { ok: true, sentinel: s as JobSentinel };
    if (s.status === 'failure') {
      return { ok: false, reason: `worker reported failure: ${s.summary}` };
    }
    return { ok: false, reason: `completion sentinel has an unknown status: ${String(s.status)}` };
  };

  /** Insert a fresh `queued` row + its jobs/<id>/ dir (instruction persisted for restarts). */
  const insertQueuedRow = (params: {
    type: string;
    title: string;
    instruction: string;
    workdir: string;
    attempts: number;
    retryOf: string | null;
    /** Registry type for typed submits (persists the spawn profile); null = generic shape. */
    registryType?: string | null;
  }): JobRow => {
    const id = randomUUID();
    const dir = jobDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(instructionPath(id), params.instruction);
    if (params.registryType !== undefined && params.registryType !== null) {
      writeFileSync(typeMarkerPath(id), params.registryType);
    }
    db.prepare(
      `INSERT INTO jobs (id, schema, type, title, status, workdir, log_path, attempts,
                         created_at, sentinel_path, retry_of)
       VALUES (@id, 1, @type, @title, 'queued', @workdir, @logPath, @attempts,
               @createdAt, @sentinelPath, @retryOf)`,
    ).run({
      id,
      type: params.type,
      title: params.title,
      workdir: params.workdir,
      logPath: join(dir, 'worker.log'),
      attempts: params.attempts,
      createdAt: new Date().toISOString(),
      sentinelPath: join(dir, 'sentinel.json'),
      retryOf: params.retryOf,
    });
    const row = getRow(id);
    if (row === null) throw new Error(`job row vanished after insert: ${id}`);
    return row;
  };

  /**
   * The single authoritative exit routine — shared by the exit handler, the
   * spawn-error handler, and the reconciler. Terminal-state races (a kill, a
   * concurrent settle) resolve via the guarded transition: not applied → no
   * side effects, no notification.
   */
  const finishJob = (id: string, exitInfo: string): void => {
    // A worker's exit event can arrive after the daemon closed its db (workers
    // are deliberately not killed on shutdown) — the NEXT life's reconciler
    // settles the row from the persisted pid instead.
    if (!db.open) return;
    const row = getRow(id);
    if (row === null || row.status !== 'running') return; // already settled (e.g. killed)

    const verdict = readSentinel(row.sentinel_path);
    if (verdict.ok) {
      if (!transitionJob(db, log, id, 'succeeded').applied) return;
      const settled = getRow(id);
      if (settled !== null) {
        emitFinish(
          settled,
          `Job succeeded: "${row.title}" (${row.type}, ${row.id})\n\n${verdict.sentinel.summary}`,
        );
      }
      startQueuedJobs();
      return;
    }

    // Failure path (FIX-C3: bounded, resources released before any retry).
    if (!transitionJob(db, log, id, 'failed').applied) return;
    const attempts = row.attempts + 1;
    db.prepare('UPDATE jobs SET attempts = ? WHERE id = ?').run(attempts, id);
    const failed = getRow(id);

    let requeued = false;
    if (attempts < config.jobRetryCap) {
      try {
        const instruction = readFileSync(instructionPath(id), 'utf8');
        // A typed row's retry keeps its registry profile (marker copied).
        let registryType: string | null = null;
        try {
          registryType = readFileSync(typeMarkerPath(id), 'utf8').trim();
        } catch {
          // raw/generic row — no marker to carry over
        }
        const retry = insertQueuedRow({
          type: row.type,
          title: row.title,
          instruction,
          workdir: row.workdir,
          attempts,
          retryOf: row.id,
          registryType,
        });
        requeued = true;
        // Retries log; only the chain-terminal state notifies.
        log.info('job failed; re-queued', {
          jobId: row.id,
          retryId: retry.id,
          attempts,
          cap: config.jobRetryCap,
          reason: verdict.reason,
        });
      } catch (err) {
        // Persisted instruction missing/unreadable: the chain cannot continue —
        // treat this failure as chain-terminal so it still notifies exactly once.
        log.error('job re-queue failed; treating failure as terminal', {
          jobId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!requeued && failed !== null) {
      emitFinish(
        failed,
        `Job failed: "${row.title}" (${row.type}, ${row.id}) after ${attempts} attempt(s).\n` +
          `Reason: ${verdict.reason} (${exitInfo}).\n\n` +
          `Last log lines:\n\`\`\`\n${logTail(row.log_path)}\n\`\`\``,
      );
    }
    startQueuedJobs();
  };

  /** queued → running + spawn. False when the transition was not applied (row moved on). */
  const startJob = (row: JobRow): boolean => {
    if (!transitionJob(db, log, row.id, 'running').applied) return false;

    let launched = false;
    try {
      const instruction = readFileSync(instructionPath(row.id), 'utf8');
      const prompt = instruction + sentinelEpilogue(row.sentinel_path);
      const sessionId = randomUUID();

      // Stage 6: a registry-typed row spawns with the type's permission args
      // ON TOP of the base argv and the type's extraEnv names ON TOP of
      // workerEnv() (still default-deny; never replaced). No marker (or the
      // types kill-switch off) → the exact Stage 5 spawn (test-pinned).
      // ORDER MATTERS: permission args go AFTER `-p <prompt> --session-id`
      // because --allowedTools is variadic and would swallow a following
      // prompt as a tool name (verified against claude CLI v2.1.201).
      const entry = registryEntryFor(row.id);
      const spawnArgs = ['-p', prompt, '--session-id', sessionId];
      if (entry !== null) spawnArgs.push(...entry.permissionArgs);
      const spawnEnv = entry === null ? workerEnv() : workerEnvWith(entry.extraEnv);

      // Log fd is inherited by the child; detached + unref so a daemon
      // shutdown never takes workers down (the reconciler re-adopts them).
      const logFd = openSync(row.log_path, 'a');
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(config.agentBin, spawnArgs, {
          cwd: row.workdir,
          env: spawnEnv,
          detached: true,
          stdio: ['ignore', logFd, logFd],
        });
      } finally {
        closeSync(logFd);
      }
      child.unref();

      child.on('error', (err) => {
        log.error('worker spawn failed', {
          jobId: row.id,
          bin: config.agentBin,
          error: err.message,
        });
        finishJob(row.id, `spawn failed: ${err.message}`);
      });
      child.on('exit', (code, signal) => {
        finishJob(row.id, `exit code ${code ?? 'null'}, signal ${signal ?? 'none'}`);
      });

      if (child.pid !== undefined) {
        db.prepare('UPDATE jobs SET pid = ?, session_id = ? WHERE id = ?').run(
          child.pid,
          sessionId,
          row.id,
        );
        log.info('worker started', { jobId: row.id, pid: child.pid, sessionId });
        launched = true;
      }
      // pid undefined → the 'error' event runs the failure path.
    } catch (err) {
      log.error('worker launch failed', {
        jobId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      finishJob(row.id, `launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return launched;
  };

  /** Concurrency truth: LIVE processes among `running` rows (never raw row counts). */
  const liveRunningCount = (): number => {
    const rows = db.prepare(`SELECT pid FROM jobs WHERE status = 'running'`).all() as Array<{
      pid: number | null;
    }>;
    return rows.filter((r) => isAlive(r.pid)).length;
  };

  /** Fill free slots with queued rows, oldest first. */
  const startQueuedJobs = (): void => {
    let free = config.maxJobs - liveRunningCount();
    while (free > 0) {
      const next = db
        .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`)
        .get() as JobRow | undefined;
      if (next === undefined) return;
      // A non-applied start means the row left `queued` concurrently; the next
      // SELECT no longer returns it, so this loop always makes progress.
      if (startJob(next)) free -= 1;
    }
  };

  const validateSubmit = (job: JobSubmit): void => {
    if (!config.jobsEnabled) {
      throw new JobError('job runner is disabled (set NIGHTSHIFT_JOBS_ENABLED=true to enable)');
    }
    const bad = (field: string): JobError => new JobError(`invalid submit: ${field}`);
    if (typeof job !== 'object' || job === null) throw bad('not an object');
    if (job.schema !== 1) throw bad('schema must be 1');
    for (const field of ['type', 'title', 'instruction', 'workdir'] as const) {
      if (typeof job[field] !== 'string' || job[field] === '') {
        throw bad(`${field} must be a non-empty string`);
      }
    }
    if (job.env !== 'minimal') {
      throw bad(`env must be exactly 'minimal' (workers always get the default-deny env)`);
    }
  };

  return {
    submit(job: JobSubmit): JobRecord {
      validateSubmit(job);
      const row = insertQueuedRow({
        type: job.type,
        title: job.title,
        instruction: job.instruction,
        workdir: job.workdir,
        attempts: 0,
        retryOf: null,
      });
      log.info('job submitted', { jobId: row.id, type: row.type, title: row.title });
      startQueuedJobs();
      const current = getRow(row.id);
      return toRecord(current ?? row);
    },

    submitType(type: string, params: unknown): JobRecord {
      if (!config.jobsEnabled) {
        throw new JobError('job runner is disabled (set NIGHTSHIFT_JOBS_ENABLED=true to enable)');
      }
      if (typeof type !== 'string' || getJobType(type) === undefined) {
        throw new JobError(
          `unknown job type: ${String(type)} (known types: ${knownJobTypes().join(', ')})`,
        );
      }
      // Stage 6 kill-switch: non-generic types are dark by default; generic
      // through the typed path is the raw shape and stays unaffected.
      if (type !== 'generic' && !config.typesEnabled) {
        throw new JobError(
          `job type '${type}' is disabled (set NIGHTSHIFT_TYPES_ENABLED=true to enable typed submits; generic jobs are unaffected)`,
        );
      }
      let rendered: ReturnType<typeof renderJobType>;
      try {
        rendered = renderJobType(type, params, home);
      } catch (err) {
        if (err instanceof JobTypeError) throw new JobError(err.message);
        throw err;
      }
      // Typed workdirs (~/projects/<slug>) are daemon-derived — create them;
      // raw submits keep Stage 5 behavior (caller owns the dir).
      mkdirSync(rendered.workdir, { recursive: true });
      const row = insertQueuedRow({
        type: rendered.type,
        title: rendered.title,
        instruction: rendered.instruction,
        workdir: rendered.workdir,
        attempts: 0,
        retryOf: null,
        registryType: type === 'generic' ? null : type,
      });
      log.info('typed job submitted', {
        jobId: row.id,
        type: row.type,
        title: row.title,
        workdir: row.workdir,
      });
      startQueuedJobs();
      const current = getRow(row.id);
      return toRecord(current ?? row);
    },

    kill(id: string): JobRecord {
      const row = getRow(id);
      if (row === null) throw new JobError(`kill: no such job: ${id}`);

      if (row.status === 'running' && row.pid !== null && isAlive(row.pid)) {
        const pid = row.pid;
        try {
          process.kill(pid, 'SIGTERM');
        } catch (err) {
          log.warn('SIGTERM failed', {
            jobId: id,
            pid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        const graceTimer = setTimeout(() => {
          if (isAlive(pid)) {
            log.warn('worker survived SIGTERM grace; sending SIGKILL', { jobId: id, pid });
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Died between the check and the signal — nothing to do.
            }
          }
        }, config.jobKillGraceSec * 1000);
        graceTimer.unref();
      }

      // queued → killed and running → killed are both legal; terminal rows reject.
      if (transitionJob(db, log, id, 'killed').applied) {
        const killed = getRow(id);
        if (killed !== null) {
          emitFinish(killed, `Job killed: "${row.title}" (${row.type}, ${row.id})`);
        }
        startQueuedJobs();
      }
      const finalRow = getRow(id);
      if (finalRow === null) throw new JobError(`kill: job vanished: ${id}`);
      return toRecord(finalRow);
    },

    get(id: string): JobRecord | null {
      const row = getRow(id);
      return row === null ? null : toRecord(row);
    },

    list(filter: JobListFilter = {}): JobRecord[] {
      const rows =
        filter.status === undefined
          ? (db.prepare('SELECT * FROM jobs ORDER BY created_at, rowid').all() as JobRow[])
          : (db
              .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid')
              .all(filter.status) as JobRow[]);
      return rows.map(toRecord);
    },

    onFinish(handler: FinishHandler): void {
      finishHandler = handler;
    },

    reconcile(): void {
      const running = db
        .prepare(`SELECT id, pid FROM jobs WHERE status = 'running'`)
        .all() as Array<{ id: string; pid: number | null }>;
      for (const row of running) {
        if (isAlive(row.pid)) continue; // live worker: left alone
        log.info('reconciler: running row has no live process; settling', {
          jobId: row.id,
          pid: row.pid,
        });
        finishJob(
          row.id,
          row.pid === null
            ? 'no pid was recorded (reconciled)'
            : `process ${row.pid} is gone (reconciled)`,
        );
      }
      startQueuedJobs();
    },
  };
}

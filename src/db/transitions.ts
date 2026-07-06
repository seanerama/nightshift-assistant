/**
 * Guarded-transition helper (contracts/job-lifecycle.md).
 * The ONLY legal transitions:
 *   queued  → running | killed
 *   running → succeeded | failed | killed
 * Terminal states (succeeded, failed, killed) are FINAL — a late exit handler
 * cannot overwrite them. Rejected transitions are logged, never applied.
 * EVERY job status write in this codebase flows through transitionJob().
 */

import type Database from 'better-sqlite3';
import type { Logger } from '../log.js';
import type { JobStatus } from '../types.js';

const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['running', 'killed'],
  running: ['succeeded', 'failed', 'killed'],
  succeeded: [],
  failed: [],
  killed: [],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'killed'];

export function isLegalTransition(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  applied: boolean;
  from: JobStatus | null;
  to: JobStatus;
}

/**
 * Attempt jobId: current → to. Applies only when legal; the UPDATE re-checks the
 * predecessor status in SQL so a concurrent writer cannot slip an illegal write in.
 */
export function transitionJob(
  db: Database.Database,
  log: Logger,
  jobId: string,
  to: JobStatus,
): TransitionResult {
  const row = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
    | { status: JobStatus }
    | undefined;

  if (row === undefined) {
    log.warn('job transition rejected: job not found', { jobId, to });
    return { applied: false, from: null, to };
  }

  const from = row.status;
  if (!isLegalTransition(from, to)) {
    log.warn('job transition rejected: illegal', { jobId, from, to });
    return { applied: false, from, to };
  }

  const now = new Date().toISOString();
  const startedAt = to === 'running' ? now : null;
  const endedAt = TERMINAL_STATUSES.includes(to) ? now : null;
  const result = db
    .prepare(
      `UPDATE jobs
         SET status = @to,
             started_at = COALESCE(@startedAt, started_at),
             ended_at = COALESCE(@endedAt, ended_at)
       WHERE id = @jobId AND status = @from`,
    )
    .run({ to, startedAt, endedAt, jobId, from });

  if (result.changes !== 1) {
    log.warn('job transition rejected: status changed concurrently', { jobId, from, to });
    return { applied: false, from, to };
  }

  log.info('job transition applied', { jobId, from, to });
  return { applied: true, from, to };
}

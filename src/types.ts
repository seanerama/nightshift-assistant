/**
 * TypeScript mirrors of the frozen v1 contracts in contracts/.
 * Drift between modules is a compile error (ADR 0002).
 * Additive only — a breaking change is a NEW contract, not an edit.
 */

/** contracts/webex-ingress.md — event handed to the session manager after verification. */
export interface InboundMessage {
  schema: 1;
  /** Webex message id (dedup key). */
  messageId: string;
  /** Real sender, from the FETCHED message, not the webhook body. */
  personId: string;
  /** Plain text of the message. */
  text: string;
  /** Absolute paths of downloaded files under uploads/<ts>-<name>. */
  attachments: string[];
  /** ISO 8601. */
  receivedAt: string;
}

/** contracts/assistant-session.md — relay() return shape. */
export interface AssistantReply {
  schema: 1;
  /** Markdown reply (transport chunks it). */
  text: string;
  /** Paths of produced files to attach (may be empty). */
  files: string[];
  /** Claude Code session id that produced the reply. */
  sessionId: string;
  /** True if this turn triggered a size-cap rotation. */
  rotated: boolean;
}

/** contracts/assistant-session.md — the reasons rotate() may be invoked. */
export type RotationReason = 'daily' | 'size-cap' | 'manual';

/** contracts/assistant-session.md — rotate() return shape. */
export interface RotationRecord {
  schema: 1;
  /** The rotated-out session. */
  closedSessionId: string;
  /** Pre-assigned id the next (seeded) session starts under at its first relay. */
  newSessionId: string;
  reason: RotationReason;
  /** logs/daily/YYYY-MM-DD.md written by the ritual. */
  summaryPath: string;
  /** Resolved claude CLI transcript path ('' when none exists — tolerated). */
  transcriptPath: string;
  /** ISO 8601. */
  rotatedAt: string;
}

/** contracts/job-lifecycle.md — the guarded state machine's states. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed';

/** contracts/job-lifecycle.md — submit() input shape (schema 1). */
export interface JobSubmit {
  schema: 1;
  /** 'app-build' | 'story' | 'study' | 'brief' | 'research' | ... (open set). */
  type: string;
  title: string;
  /** The worker session's task. */
  instruction: string;
  /** Project directory the worker runs in. */
  workdir: string;
  /** Workers ALWAYS get the default-deny allow-list env (FIX-H3); no override. */
  env: 'minimal';
}

/** contracts/job-lifecycle.md — persisted JobRecord (the only representation of a worker). */
export interface JobRecord {
  schema: 1;
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  /** Live process id while running. */
  pid: number | null;
  /** Worker's Claude session id. */
  sessionId: string | null;
  workdir: string;
  logPath: string;
  /** Bounded; cap exhaustion → terminal 'failed'. */
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Where the completion sentinel must appear. */
  sentinelPath: string;
  /**
   * Additive (v1-compatible): id of the failed row this row retries, or null.
   * Below-cap failures re-queue as a fresh linked row (no running → queued edge).
   */
  retryOf: string | null;
}

/** contracts/job-lifecycle.md — the completion sentinel a worker writes at sentinelPath. */
export interface JobSentinel {
  schema: 1;
  status: 'success' | 'failure';
  summary: string;
  outputs?: string[];
  url?: string;
  port?: number;
}

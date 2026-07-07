/**
 * Session manager (contracts/assistant-session.md): relay() + the rotation
 * ritual. Exactly ONE conversational claude session at a time: relay turns AND
 * rotations serialize on the same queue — a rotation never lands mid-turn. The
 * session is a child process in headless JSON mode; the binary path comes from
 * NIGHTSHIFT_AGENT_BIN (the test seam).
 *
 * Rotation ritual — rotate(reason) → RotationRecord:
 *   1. final summary turn against the OUTGOING session (fixed prompt; a failed
 *      summary NEVER blocks rotation — stub summary + logged failure);
 *   2. day-summary written to logs/daily/YYYY-MM-DD.md (-2, -3… on repeats);
 *   3. durable facts promoted into memory/ (MEMORY.md index + dated append);
 *   4. transcript location resolved (claude CLI convention) and recorded;
 *   5. sessions row flipped (is_current=0, rotated_at, rotation_reason) and a
 *      fresh PENDING row (pre-assigned session id, pending=1) becomes current —
 *      the next relay() starts it with --session-id plus a seed built from
 *      memory/ + the latest daily summary, delivered via --append-system-prompt
 *      so it never appears in the user-visible reply.
 *
 * ALL rotation triggers + seeding are dark unless NIGHTSHIFT_ROTATION_ENABLED
 * is exactly "true" — with it unset, relay behaves identically to Stage 1.
 * The rotation notice goes out via the injected notify hook (the app wires it
 * to send() with the owner's last-seen room, tracked in-memory for this stage).
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { jobTypesPreamble } from '../jobs/types.js';
import type { Logger } from '../log.js';
import { rotationNotice } from '../notices.js';
import type { AssistantReply, InboundMessage, RotationReason, RotationRecord } from '../types.js';
import { isPastDailyBoundary } from './boundary.js';
import {
  defaultProjectsRoot,
  extractDurableMemory,
  localDateStamp,
  promoteDurableMemory,
  recordTranscriptLocation,
  SUMMARY_PROMPT,
  transcriptPathFor,
  writeDailySummary,
} from './rotation.js';
import { buildSeed } from './seed.js';

/**
 * Bash permission rule granting the conversational session EXACTLY the
 * nightshift CLI (contracts/control-api.md: "Bash(nightshift *) allowed at
 * spawn"). Matcher syntax VERIFIED against the installed claude CLI v2.1.201
 * (2026-07-06): `claude --help` documents the space form — `--allowedTools
 * "Bash(git *) Edit"` — and a headless probe confirmed behavior: with
 * `--allowedTools "Bash(git *)"` the command `git --version` executed with no
 * permission denial, while the identical prompt WITHOUT the flag was denied
 * (`permission_denials` non-empty). The colon form "Bash(git:*)" also passed,
 * but the space form is what both the CLI help and the frozen contract spell —
 * re-verify empirically before ever changing it.
 */
export const NIGHTSHIFT_TOOL_RULE = 'Bash(nightshift *)';

/**
 * Fixed capability preamble (Stage 5): appended to the system prompt of every
 * NEW conversational session when the control surface is enabled, telling the
 * session what its hands are and when to use them. Delivered on the same
 * --append-system-prompt path as the rotation seed — never user-visible.
 */
export const CONTROL_PREAMBLE = [
  'You have the `nightshift` CLI available through your Bash tool (the only Bash you are permitted). It is your control surface for the Nightshift daemon:',
  '- `nightshift submit --type <type> --title <title> --instruction <text> --workdir <dir>` — dispatch long-running work (builds, pipelines, research) as a background job. NEVER run long work inline in this conversation; always submit a job and reply immediately.',
  '- `nightshift jobs [--status <status>]` / `nightshift job <id>` — list jobs or inspect one.',
  '- `nightshift kill <id>` — stop a job.',
  '- `nightshift rotate` — rotate this conversational session (manual).',
  '- `nightshift status` — daemon status (version, uptime, session, job counts).',
  'Invoke it as bare `nightshift …`, never with a path prefix (no `./bin/nightshift`, no absolute path) — path-prefixed invocations are denied by the permission rule.',
  'Add `--json` to any command for raw JSON. Job completion notices arrive in Webex on their own — do not poll or wait for jobs to finish.',
].join('\n');

interface AgentResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
}

/** Shape of `claude -p --output-format json` result output (fields we rely on). */
interface AgentJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

interface AgentTurnOptions {
  /** Resume an existing session. */
  resume?: string;
  /** Start a NEW session under this pre-assigned id (rotation's pending row). */
  sessionId?: string;
  /** Seed context — appended to the system prompt, never user-visible. */
  appendSystemPrompt?: string;
}

interface SessionRow {
  id: number;
  session_id: string;
  started_at: string;
  turns: number;
  /** 1 = rotation-created row whose claude session has not materialized yet. */
  pending: number;
}

export interface SessionManagerHooks {
  /** Injectable clock — boundary/date tests never need real time. */
  now?: () => Date;
  /** Base dir for logs/ + memory/ and the agent child's cwd (default: daemon cwd). */
  appDir?: string;
  /** claude CLI projects root for transcript lookup (default ~/.claude/projects). */
  projectsRoot?: string;
  /** Deliver the one-line rotation notice (the app wires this to send()). */
  notify?: (text: string) => Promise<void>;
}

export interface SessionManager {
  relay(msg: InboundMessage): Promise<AssistantReply>;
  /** The ritual (queued with relay turns — never mid-turn). Not operator-exposed yet. */
  rotate(reason: RotationReason): Promise<RotationRecord>;
  /** Daily-trigger check (interval-driven); resolves true when a rotation ran. */
  maybeRotateDaily(): Promise<boolean>;
  /** Current-session snapshot for GET /api/v1/status (additive, read-only). */
  info(): { id: string | null; turns: number };
}

export function createSessionManager(
  db: Database.Database,
  log: Logger,
  config: Config,
  hooks: SessionManagerHooks = {},
): SessionManager {
  const now = hooks.now ?? ((): Date => new Date());
  const appDir = hooks.appDir ?? process.cwd();
  const projectsRoot = hooks.projectsRoot ?? defaultProjectsRoot();
  const notify = hooks.notify ?? (async (): Promise<void> => undefined);

  // Serialize relays AND rotations: every task queues behind the previous one.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const getCurrentRow = (): SessionRow | null => {
    const row = db
      .prepare(
        'SELECT id, session_id, started_at, turns, pending FROM sessions WHERE is_current = 1 ORDER BY id DESC LIMIT 1',
      )
      .get() as SessionRow | undefined;
    return row ?? null;
  };

  const persistSessionId = (sessionId: string): void => {
    // A successful turn materializes the session: clear the pending marker
    // alongside the id — from here on relay() resumes, never starts.
    const updated = db
      .prepare('UPDATE sessions SET session_id = ?, pending = 0 WHERE is_current = 1')
      .run(sessionId);
    if (updated.changes === 0) {
      db.prepare('INSERT INTO sessions (session_id, started_at, is_current) VALUES (?, ?, 1)').run(
        sessionId,
        now().toISOString(),
      );
      log.info('conversational session started', { sessionId });
    }
  };

  const clearCurrentSession = (): void => {
    db.prepare(
      `UPDATE sessions SET is_current = 0, rotated_at = ?, rotation_reason = 'died' WHERE is_current = 1`,
    ).run(now().toISOString());
  };

  /** Count the completed turn on the current row; returns the new count (null if no row). */
  const incrementTurns = (): number | null => {
    const updated = db.prepare('UPDATE sessions SET turns = turns + 1 WHERE is_current = 1').run();
    if (updated.changes === 0) return null;
    return getCurrentRow()?.turns ?? null;
  };

  const runAgentTurn = (text: string, opts: AgentTurnOptions): Promise<AgentResult> =>
    new Promise((resolve) => {
      const args = ['-p', '--output-format', 'json'];
      // Stage 5, gated on the control flag: the tool rule on argv and the API
      // token in the env — this ONE spawn site only (workers go through
      // workerEnv(), which must never carry the token). With the flag off both
      // spawn calls below are byte-identical to Stage 4 (no extra args, no env
      // option — the child inherits process.env exactly as before).
      if (config.controlEnabled) args.push('--allowedTools', NIGHTSHIFT_TOOL_RULE);
      if (opts.resume !== undefined) args.push('--resume', opts.resume);
      if (opts.sessionId !== undefined) args.push('--session-id', opts.sessionId);
      if (opts.appendSystemPrompt !== undefined) {
        args.push('--append-system-prompt', opts.appendSystemPrompt);
      }

      // Stage 7: the app's committed CLI dir leads the child's PATH so bare
      // `nightshift` resolves regardless of the daemon's own PATH (under the
      // systemd user manager it lacks ~/.local/bin — the 2026-07-06 live
      // failure). No reliance on deploy symlinks; rest of the inherited PATH
      // is preserved. Control-gated like the token: flag-off spawns stay
      // byte-identical (no env option at all).
      const child = config.controlEnabled
        ? spawn(config.agentBin, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: appDir,
            env: {
              ...process.env,
              NIGHTSHIFT_API_TOKEN: config.apiToken,
              PATH:
                process.env.PATH === undefined
                  ? join(appDir, 'bin')
                  : `${join(appDir, 'bin')}${delimiter}${process.env.PATH}`,
            },
          })
        : spawn(config.agentBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: appDir });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        log.error('agent turn timed out; killing child', {
          timeoutSec: config.turnTimeoutSec,
        });
        child.kill('SIGKILL');
        settle({ ok: false, text: 'agent turn timed out', sessionId: null });
      }, config.turnTimeoutSec * 1000);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) => {
        log.error('agent spawn failed', { bin: config.agentBin, error: err.message });
        settle({ ok: false, text: `agent spawn failed: ${err.message}`, sessionId: null });
      });
      child.on('close', (code) => {
        if (settled) return;
        let parsed: AgentJson | null = null;
        try {
          parsed = JSON.parse(stdout.trim()) as AgentJson;
        } catch {
          // Tolerate leading noise: try the last line that looks like JSON.
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = (lines[i] as string).trim();
            if (line.startsWith('{')) {
              try {
                parsed = JSON.parse(line) as AgentJson;
                break;
              } catch {
                // keep scanning
              }
            }
          }
        }

        if (code !== 0 || parsed === null || parsed.is_error === true) {
          log.error('agent turn failed', {
            exitCode: code,
            parsed: parsed !== null,
            stderr: stderr.slice(0, 2000),
          });
          settle({
            ok: false,
            text: `agent exited with code ${code}`,
            sessionId: parsed?.session_id ?? null,
          });
          return;
        }

        settle({
          ok: true,
          text: parsed.result ?? '',
          sessionId: parsed.session_id ?? null,
        });
      });

      child.stdin.write(text);
      child.stdin.end();
    });

  /** The ritual itself. Runs INSIDE a queued task — callers go through enqueue(). */
  const rotateNow = async (reason: RotationReason): Promise<RotationRecord> => {
    const current = getCurrentRow();
    if (current === null) {
      throw new Error('rotate: no current conversational session to rotate');
    }
    const rotatedAtDate = now();
    const rotatedAt = rotatedAtDate.toISOString();

    // 1. Final summary turn against the OUTGOING session. Failure never blocks
    //    rotation — a wedged session must not prevent its own retirement.
    const summaryResult = await runAgentTurn(SUMMARY_PROMPT, { resume: current.session_id });
    let summaryText: string;
    if (summaryResult.ok) {
      summaryText = summaryResult.text;
    } else {
      log.error('rotation summary turn failed; rotating with a stub summary', {
        sessionId: current.session_id,
        reason,
        error: summaryResult.text,
      });
      summaryText =
        `Summary turn FAILED during rotation (${summaryResult.text}). ` +
        `No end-of-session summary is available for session ${current.session_id}.`;
    }

    // 2. Permanent day-summary record.
    const header =
      `# Session summary — ${localDateStamp(rotatedAtDate)}\n\n` +
      `- session: ${current.session_id}\n- reason: ${reason}\n- rotated at: ${rotatedAt}\n\n`;
    const summaryPath = writeDailySummary(appDir, rotatedAtDate, `${header}${summaryText}\n`);

    // 3. Durable-memory promotion (may be a no-op when the block is empty).
    const durable = extractDurableMemory(summaryText);
    const promotedPath = promoteDurableMemory(appDir, rotatedAtDate, rotatedAt, durable);

    // 4. Transcript location — claude CLI convention; tolerate absence (stub
    //    and test sessions have none).
    const candidate = transcriptPathFor(projectsRoot, appDir, current.session_id);
    const transcriptPath = existsSync(candidate) ? candidate : '';
    if (transcriptPath === '') {
      log.info('no transcript found for the rotated session (tolerated)', {
        sessionId: current.session_id,
        candidate,
      });
    }
    recordTranscriptLocation(appDir, rotatedAt, current.session_id, transcriptPath);

    // 5. Flip the outgoing row; a fresh EXPLICITLY-pending row (pre-assigned
    //    id, pending=1) becomes current — the next relay() starts it seeded.
    const newSessionId = randomUUID();
    db.transaction(() => {
      db.prepare(
        'UPDATE sessions SET is_current = 0, rotated_at = ?, rotation_reason = ? WHERE id = ?',
      ).run(rotatedAt, reason, current.id);
      db.prepare(
        'INSERT INTO sessions (session_id, started_at, is_current, turns, pending) VALUES (?, ?, 1, 0, 1)',
      ).run(newSessionId, rotatedAt);
    })();

    const record: RotationRecord = {
      schema: 1,
      closedSessionId: current.session_id,
      newSessionId,
      reason,
      summaryPath,
      transcriptPath,
      rotatedAt,
    };
    log.info('session rotated', { ...record, memoryPromoted: promotedPath !== null });

    // Rotation notice (builder-formatted) — best-effort, never blocks the ritual.
    try {
      await notify(rotationNotice(reason, relative(appDir, summaryPath)));
    } catch (err) {
      log.error('rotation notice delivery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return record;
  };

  const runTurn = async (msg: InboundMessage): Promise<AssistantReply> => {
    const current = getCurrentRow();

    // A row EXPLICITLY marked pending is a rotation-created session: start it
    // under its pre-assigned id, seeded. No row at all is a brand-new session
    // (also seeded when rotation is enabled). Any other row — whatever its
    // turn count says — is a materialized session: resume, Stage 1 behavior.
    // (turns==0 is NOT pending-ness: migration backfill leaves real sessions
    // at 0, and starting one burns the turn — the 2026-07-06 incident.)
    const pending = current !== null && current.pending === 1;
    const opts: AgentTurnOptions = {};
    if (current === null || pending) {
      if (current !== null) opts.sessionId = current.session_id;
      // System-prompt extras for a NEW session, each behind its own flag:
      // the Stage 5 capability preamble (control), the Stage 6 dispatchable
      // type list (control AND types — a dark registry is not advertised),
      // then the rotation seed. All off → no --append-system-prompt at all
      // (Stage 1 spawn shape).
      const parts: string[] = [];
      if (config.controlEnabled) parts.push(CONTROL_PREAMBLE);
      if (config.controlEnabled && config.typesEnabled) parts.push(jobTypesPreamble());
      if (config.rotationEnabled) {
        const seed = buildSeed(appDir, config.seedMaxBytes);
        if (seed !== '') parts.push(seed);
      }
      if (parts.length > 0) opts.appendSystemPrompt = parts.join('\n\n');
    } else {
      opts.resume = current.session_id;
    }

    const result = await runAgentTurn(msg.text, opts);

    if (!result.ok) {
      // Session died (or never started) mid-turn: error reply, never silence.
      // A pending row never materialized — keep it (still pending) so the
      // retry STARTS it again under the same pre-assigned id; otherwise clear
      // the persisted session so the next message starts cleanly.
      if (!pending) clearCurrentSession();
      return {
        schema: 1,
        text: `The assistant session hit an error on this turn (${result.text}). The next message will start a fresh session.`,
        files: [],
        sessionId: current?.session_id ?? '',
        rotated: false,
      };
    }

    if (result.sessionId !== null) {
      persistSessionId(result.sessionId);
    }

    // Size-cap trigger: count the completed turn; when it pushes PAST the cap,
    // rotate right after the turn (still inside this queued task — never mid-turn).
    const turns = incrementTurns();
    let rotated = false;
    if (config.rotationEnabled && turns !== null && turns > config.sizeCapTurns) {
      try {
        await rotateNow('size-cap');
        rotated = true;
      } catch (err) {
        log.error('size-cap rotation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      schema: 1,
      text: result.text,
      files: [],
      sessionId: result.sessionId ?? current?.session_id ?? '',
      rotated,
    };
  };

  return {
    relay(msg: InboundMessage): Promise<AssistantReply> {
      return enqueue(() => runTurn(msg));
    },

    rotate(reason: RotationReason): Promise<RotationRecord> {
      return enqueue(() => rotateNow(reason));
    },

    info(): { id: string | null; turns: number } {
      const current = getCurrentRow();
      return { id: current?.session_id ?? null, turns: current?.turns ?? 0 };
    },

    maybeRotateDaily(): Promise<boolean> {
      if (!config.rotationEnabled) return Promise.resolve(false);
      // Check + rotate atomically on the queue so an in-flight turn (or another
      // rotation) finishes first and the conditions are re-read after it.
      return enqueue(async () => {
        const current = getCurrentRow();
        // Nothing to rotate, or an unused rotation-created pending session
        // (rotating an unmaterialized session would just churn summaries).
        // Explicit pending — NOT turns==0 — so a backfilled-but-real session
        // (turns lies at 0) still rotates once past the boundary.
        if (current === null || current.pending === 1) return false;
        if (!isPastDailyBoundary(now(), config.rotateHour, new Date(current.started_at))) {
          return false;
        }
        await rotateNow('daily');
        return true;
      });
    },
  };
}

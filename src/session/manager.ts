/**
 * Session manager, relay surface only (contracts/assistant-session.md).
 * Exactly ONE conversational claude session at a time: relay() calls serialize —
 * a second inbound message queues behind the in-flight turn. The session is a
 * child process in headless JSON mode; the binary path comes from
 * NIGHTSHIFT_AGENT_BIN (the test seam). Current session id persists in the
 * sessions table and later turns resume it. If the session dies mid-turn,
 * relay() returns an error reply — never silence. NO rotation ritual in Stage 1.
 */

import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { AssistantReply, InboundMessage } from '../types.js';

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

export interface SessionManager {
  relay(msg: InboundMessage): Promise<AssistantReply>;
}

export function createSessionManager(
  db: Database.Database,
  log: Logger,
  config: Config,
): SessionManager {
  // Serialize concurrent relays: each turn queues behind the previous one.
  let queue: Promise<unknown> = Promise.resolve();

  const getCurrentSessionId = (): string | null => {
    const row = db
      .prepare('SELECT session_id FROM sessions WHERE is_current = 1 ORDER BY id DESC LIMIT 1')
      .get() as { session_id: string } | undefined;
    return row?.session_id ?? null;
  };

  const persistSessionId = (sessionId: string): void => {
    const now = new Date().toISOString();
    const updated = db
      .prepare('UPDATE sessions SET session_id = ? WHERE is_current = 1')
      .run(sessionId);
    if (updated.changes === 0) {
      db.prepare('INSERT INTO sessions (session_id, started_at, is_current) VALUES (?, ?, 1)').run(
        sessionId,
        now,
      );
      log.info('conversational session started', { sessionId });
    }
  };

  const clearCurrentSession = (): void => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE sessions SET is_current = 0, rotated_at = ?, rotation_reason = 'died' WHERE is_current = 1`,
    ).run(now);
  };

  const runAgentTurn = (text: string, resumeSessionId: string | null): Promise<AgentResult> =>
    new Promise((resolve) => {
      const args = ['-p', '--output-format', 'json'];
      if (resumeSessionId !== null) args.push('--resume', resumeSessionId);

      const child = spawn(config.agentBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

  const runTurn = async (msg: InboundMessage): Promise<AssistantReply> => {
    const resumeSessionId = getCurrentSessionId();
    const result = await runAgentTurn(msg.text, resumeSessionId);

    if (!result.ok) {
      // Session died (or never started) mid-turn: error reply, never silence.
      // Clear the persisted session so the next message starts cleanly.
      clearCurrentSession();
      return {
        schema: 1,
        text: `The assistant session hit an error on this turn (${result.text}). The next message will start a fresh session.`,
        files: [],
        sessionId: resumeSessionId ?? '',
        rotated: false,
      };
    }

    if (result.sessionId !== null) {
      persistSessionId(result.sessionId);
    }

    return {
      schema: 1,
      text: result.text,
      files: [],
      sessionId: result.sessionId ?? resumeSessionId ?? '',
      rotated: false,
    };
  };

  return {
    relay(msg: InboundMessage): Promise<AssistantReply> {
      const turn = queue.then(
        () => runTurn(msg),
        () => runTurn(msg),
      );
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}

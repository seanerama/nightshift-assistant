/**
 * Hook ingress (contracts/hook-ingress.md v1, frozen; ADR 0018): the public,
 * chat-only door for owner callers that are not on the tailnet (scripts,
 * Shortcuts, Zapier/n8n). Mounted inside the existing loopback transport
 * server (src/transport/server.ts) ONLY when HOOK_INGRESS_ENABLED=true — flag
 * off, this module is never constructed and /hook/v1/* is the ordinary 404.
 * Public reach is exactly one Funnel path scope, /hook/v1 (stage 40).
 *
 * Gate order on EVERY /hook/v1 request:
 *   1. bearer NIGHTSHIFT_HOOK_TOKEN, constant-time compare (src/transport/
 *      auth.ts), fail closed on empty → 401. 401 PRECEDES 404/405/400/413:
 *      the surface is not enumerable without the token;
 *   2. rate limit — authenticated requests only, one token bucket for POST
 *      (HOOK_RATE_PER_MIN, burst 3) and one for everything else
 *      (HOOK_POLL_RATE_PER_MIN) → 429 + Retry-After;
 *   3. route (404) / method (405) / body (413 over 16 KiB, 400 invalid).
 *
 * POST /hook/v1/messages inserts a durable `pending` hook_messages row,
 * enqueues relay() on the frozen seam (contracts/assistant-session.md — the
 * turn queues with every Webex/app turn), and races the turn against the
 * caller's `wait`: done in time → 200 `completed` with the reply; otherwise
 * 202 `pending` + a poll path. The turn ALWAYS runs to completion and settles
 * its row, whatever happened to the HTTP request (a client disconnect cancels
 * nothing). A re-POST of an existing messageId starts no turn — it answers
 * that row's current state (durable idempotency; the row doubles as the poll
 * store). The pending cap (HOOK_MAX_PENDING) applies only when a NEW turn
 * would start.
 *
 * Trust: owner-equivalent, tagged — the turn text is prefixed
 * "[via hook: <source>]" so the assistant knows the origin. Chat-only at the
 * wire: no attachments in, reply files are COUNTED (filesOmitted), never
 * exposed. No proactive send() sink is registered — notices keep flowing to
 * Webex + the app outbox.
 *
 * Logging: messageId, source, status, latencyMs, HTTP code. NEVER the token,
 * the turn text, or the reply text.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { AssistantReply, InboundMessage } from '../types.js';
import { tokenMatches } from './auth.js';
import { createTokenBucket } from './ratelimit.js';
import { respond } from './server.js';

const MESSAGES_PATH = '/hook/v1/messages';
const MESSAGE_PREFIX = '/hook/v1/messages/';

/** The hook's OWN body cap (contract: 16 KiB) — not the shared 1 MiB reader's. */
const MAX_BODY_BYTES = 16 * 1024;
/**
 * After a 413 the remainder is drained so the response can still go out on
 * the same socket — but only this far: a public door never reads an
 * unbounded body. Past it the socket is destroyed.
 */
const MAX_DRAIN_BYTES = 1024 * 1024;

const MAX_TEXT_CHARS = 8000;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_SOURCE = 'hook';

/** POST burst is fixed by the contract ("HOOK_RATE_PER_MIN=6 with burst 3 for POST"). */
const POST_BURST = 3;
/** Poll burst (unspecified by the contract): enough for a 1s poller to catch up. */
const POLL_BURST = 10;
/** Retry-After for the pending-cap 429 — turns take seconds to minutes. */
const PENDING_RETRY_AFTER_SEC = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Contract text for a row found `pending` at daemon start. */
export const HOOK_LOST_TEXT = 'lost: the daemon restarted before this turn finished';
/** Defensive: relay() rejected despite its never-throws contract. */
const HOOK_FAILED_TEXT = 'failed: the assistant turn did not complete';

type HookStatus = 'pending' | 'completed' | 'failed';

interface HookRow {
  message_id: string;
  source: string;
  status: HookStatus;
  reply_text: string | null;
  rotated: number | null;
  files_omitted: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface HookDeps {
  config: Config;
  log: Logger;
  db: Database.Database;
  /** The frozen seam (contracts/assistant-session.md) — awaited here; this door owns its reply. */
  relay(msg: InboundMessage): Promise<AssistantReply>;
  /** Clock seam (timestamps, retention cutoff, rate-limit refill) — tests only. */
  now?: () => Date;
}

export type HookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Boot reconciliation: a row still `pending` at daemon start belongs to a
 * turn that died with the previous process and cannot be resumed — mark it
 * `failed` with the contract's "lost" text so pollers get a terminal answer.
 */
export function reconcileHookMessages(
  db: Database.Database,
  log: Logger,
  now: Date = new Date(),
): number {
  const info = db
    .prepare(
      `UPDATE hook_messages
          SET status = 'failed', reply_text = ?, rotated = 0, files_omitted = 0, completed_at = ?
        WHERE status = 'pending'`,
    )
    .run(HOOK_LOST_TEXT, now.toISOString());
  if (info.changes > 0) {
    log.warn('hook turns lost across a restart marked failed', { count: info.changes });
  }
  return info.changes;
}

/** Every non-2xx body on this surface is { ok: false, error } (contract). */
function sendError(res: ServerResponse, status: number, error: string): void {
  respond(res, status, { ok: false, error });
}

/** Rejection carrying "the body outgrew the cap" — distinct from transport errors. */
class BodyTooLargeError extends Error {}

/**
 * Bounded body reader: rejects the moment the 16 KiB cap is crossed. The
 * request is left undestroyed so the 413 can go out on the same socket; the
 * remainder is drained up to MAX_DRAIN_BYTES, then the socket is cut.
 */
function readHookBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (rejected) {
        if (size > MAX_BODY_BYTES + MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        parts.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      parts.push(part);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(parts));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

/** A validated POST body. */
interface HookSubmit {
  text: string;
  source: string;
  messageId: string;
  wait: number;
}

/** Hand-rolled validation (no schema library): a short reason on failure. */
function validateSubmit(
  parsed: unknown,
  maxWaitSec: number,
  defaultWaitSec: number,
): HookSubmit | string {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'body must be a JSON object';
  }
  const body = parsed as Record<string, unknown>;
  const { text, source, messageId, wait } = body;
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT_CHARS) {
    return `text must be a string of 1-${MAX_TEXT_CHARS} characters`;
  }
  if (source !== undefined && (typeof source !== 'string' || !SOURCE_RE.test(source))) {
    return 'source must match ^[a-z0-9][a-z0-9._-]{0,31}$';
  }
  if (
    messageId !== undefined &&
    (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId))
  ) {
    return 'messageId must match ^[A-Za-z0-9._:-]{1,128}$';
  }
  if (
    wait !== undefined &&
    (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > maxWaitSec)
  ) {
    return `wait must be an integer 0-${maxWaitSec}`;
  }
  return {
    text,
    source: source ?? DEFAULT_SOURCE,
    messageId: messageId ?? randomUUID(),
    wait: wait ?? defaultWaitSec,
  };
}

/** The wire state of one row — shared by POST (200/202) and GET (always 200). */
function stateBody(row: HookRow): Record<string, unknown> {
  if (row.status === 'pending') {
    return {
      ok: true,
      status: 'pending',
      messageId: row.message_id,
      poll: `${MESSAGE_PREFIX}${row.message_id}`,
    };
  }
  return {
    ok: true,
    status: row.status,
    messageId: row.message_id,
    reply: {
      text: row.reply_text ?? '',
      rotated: row.rotated === 1,
      filesOmitted: row.files_omitted ?? 0,
    },
  };
}

export function createHookHandler(deps: HookDeps): HookHandler {
  const { config, log, db, relay } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const nowMs = (): number => now().getTime();

  const postBucket = createTokenBucket({
    ratePerMin: config.hookRatePerMin,
    burst: POST_BURST,
    now: nowMs,
  });
  const pollBucket = createTokenBucket({
    ratePerMin: config.hookPollRatePerMin,
    burst: Math.min(POLL_BURST, config.hookPollRatePerMin),
    now: nowMs,
  });

  const getRow = (messageId: string): HookRow | null =>
    (db.prepare('SELECT * FROM hook_messages WHERE message_id = ?').get(messageId) as
      | HookRow
      | undefined) ?? null;

  /**
   * Settle a turn's row. Guarded: a write that fails (e.g. the DB closed
   * under a turn that outlived the daemon) is logged, never thrown — the
   * next boot's reconciliation gives the row its terminal state instead.
   */
  const settle = (
    messageId: string,
    status: 'completed' | 'failed',
    text: string,
    rotated: boolean,
    filesOmitted: number,
  ): void => {
    try {
      db.prepare(
        `UPDATE hook_messages
            SET status = ?, reply_text = ?, rotated = ?, files_omitted = ?, completed_at = ?
          WHERE message_id = ? AND status = 'pending'`,
      ).run(status, text, rotated ? 1 : 0, filesOmitted, now().toISOString(), messageId);
    } catch {
      log.error('hook state write failed', { messageId, status });
    }
  };

  /** Enqueue the turn on the frozen seam; the returned promise never rejects. */
  const startTurn = (submit: HookSubmit): Promise<void> => {
    const { messageId, source } = submit;
    const inbound: InboundMessage = {
      schema: 1,
      messageId: `hook:${messageId}`,
      personId: config.webexOwnerPersonId,
      text: `[via hook: ${source}]\n${submit.text}`,
      attachments: [],
      receivedAt: now().toISOString(),
    };
    const startedAt = nowMs();
    return (
      Promise.resolve()
        .then(() => relay(inbound))
        .then((reply: AssistantReply | undefined): HookStatus => {
          // Defensive reading: a reply without readable text is a failed turn;
          // a missing files/rotated is tolerated (counted as 0 / false).
          if (typeof reply !== 'object' || reply === null || typeof reply.text !== 'string') {
            throw new Error('malformed reply');
          }
          const files: unknown = reply.files;
          const filesOmitted = Array.isArray(files) ? files.length : 0;
          settle(messageId, 'completed', reply.text, reply.rotated === true, filesOmitted);
          return 'completed';
        })
        // ONE catch for both a rejecting relay() (never-throws per contract —
        // defensive) and any throw in the success path above: the row always
        // reaches a terminal state, so no pending-cap slot leaks.
        .catch((): HookStatus => {
          settle(messageId, 'failed', HOOK_FAILED_TEXT, false, 0);
          return 'failed';
        })
        .then((status) => {
          log.info('hook turn settled', {
            messageId,
            source,
            status,
            latencyMs: nowMs() - startedAt,
          });
        })
        // Terminal guard: the returned promise truly never rejects (settle and
        // the logger are not expected to throw; this makes it unconditional).
        .catch(() => undefined)
    );
  };

  /** Resolve when the turn settles OR the wait elapses, whichever is first. */
  const raceWait = (turn: Promise<void>, waitSec: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, waitSec * 1000);
      void turn.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAt = nowMs();
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendError(res, 400, 'content-type must be application/json');
      return;
    }
    let raw: Buffer;
    try {
      raw = await readHookBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.setHeader('Connection', 'close');
        sendError(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
        req.resume(); // drain (bounded) so the 413 can be delivered
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendError(res, 400, 'invalid JSON');
      return;
    }
    const submit = validateSubmit(parsed, config.hookMaxWaitSec, config.hookDefaultWaitSec);
    if (typeof submit === 'string') {
      sendError(res, 400, submit);
      return;
    }
    const { messageId, source } = submit;

    // Durable idempotency: an existing messageId starts NO new turn — answer
    // its current state. (No await between this lookup and the insert below,
    // so two same-id POSTs cannot both pass it.)
    const existing = getRow(messageId);
    if (existing !== null) {
      const code = existing.status === 'pending' ? 202 : 200;
      respond(res, code, stateBody(existing));
      log.info('hook re-POST answered from state', {
        messageId,
        source: existing.source,
        status: existing.status,
        code,
        latencyMs: nowMs() - receivedAt,
      });
      return;
    }

    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM hook_messages WHERE status = 'pending'")
      .get() as { n: number };
    if (pending.n >= config.hookMaxPending) {
      res.setHeader('Retry-After', String(PENDING_RETRY_AFTER_SEC));
      sendError(res, 429, 'too many pending hook turns');
      log.warn('hook rejected: pending cap', { messageId, source, code: 429 });
      return;
    }

    // Retention prune rides the insert (completed/failed only — a pending row
    // is never pruned), then the durable pending row lands BEFORE the turn.
    const createdAt = now();
    const cutoff = new Date(createdAt.getTime() - config.hookRetentionDays * DAY_MS).toISOString();
    db.transaction(() => {
      db.prepare(
        "DELETE FROM hook_messages WHERE status IN ('completed', 'failed') AND created_at < ?",
      ).run(cutoff);
      db.prepare(
        "INSERT INTO hook_messages (message_id, source, status, created_at) VALUES (?, ?, 'pending', ?)",
      ).run(messageId, source, createdAt.toISOString());
    })();

    const turn = startTurn(submit);
    if (submit.wait > 0) await raceWait(turn, submit.wait);

    const row = getRow(messageId);
    if (row === null) {
      // Unreachable in practice (pending rows are never pruned) — fail loud.
      sendError(res, 500, 'internal error');
      return;
    }
    const code = row.status === 'pending' ? 202 : 200;
    respond(res, code, stateBody(row));
    log.info('hook message answered', {
      messageId,
      source,
      status: row.status,
      code,
      latencyMs: nowMs() - receivedAt,
    });
  }

  function handleGet(res: ServerResponse, rawId: string): void {
    let messageId: string;
    try {
      messageId = decodeURIComponent(rawId);
    } catch {
      messageId = '';
    }
    const row = MESSAGE_ID_RE.test(messageId) ? getRow(messageId) : null;
    if (row === null) {
      sendError(res, 404, 'not found');
      return;
    }
    respond(res, 200, stateBody(row));
    log.info('hook poll answered', {
      messageId,
      source: row.source,
      status: row.status,
      code: 200,
    });
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url?.split('?')[0] ?? '';

    // Gate 1 — bearer auth, BEFORE any routing: an unauthenticated probe
    // gets the same 401 on every path and method (and on everything while
    // the token is unset — fail closed).
    const header = req.headers.authorization;
    if (!tokenMatches(header, config.hookToken)) {
      sendError(res, 401, 'unauthorized');
      log.warn('hook rejected: unauthorized', {
        code: 401,
        hasHeader: header !== undefined && header !== '',
      });
      return;
    }

    // Gate 2 — rate limit (authenticated only): POST and poll buckets.
    const bucket = req.method === 'POST' ? postBucket : pollBucket;
    const taken = bucket.take();
    if (!taken.ok) {
      res.setHeader('Retry-After', String(taken.retryAfterSec));
      sendError(res, 429, 'rate limited');
      log.warn('hook rejected: rate limited', { method: req.method, code: 429 });
      return;
    }

    // Gate 3 — route, then method.
    if (url === MESSAGES_PATH) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendError(res, 405, 'method not allowed');
        return;
      }
      return handlePost(req, res);
    }
    if (url.startsWith(MESSAGE_PREFIX)) {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        sendError(res, 405, 'method not allowed');
        return;
      }
      return handleGet(res, url.slice(MESSAGE_PREFIX.length));
    }
    sendError(res, 404, 'not found');
  }

  return async (req, res) => {
    try {
      await dispatch(req, res);
    } catch (err) {
      // Error NAME only: a message could in principle echo request content.
      log.error('hook handler error', { error: err instanceof Error ? err.name : 'unknown' });
      if (!res.headersSent) sendError(res, 500, 'internal error');
    }
  };
}

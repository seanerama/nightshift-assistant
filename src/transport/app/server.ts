/**
 * App transport (contracts/app-ingress.md v1, pinned agent-app-contract#v1.0.0;
 * ADR 0009–0011): the second front door. Owns its OWN node:http servers — one
 * per NIGHTSHIFT_APP_BIND address (loopback + tailnet only; an all-interfaces
 * bind is refused at config load) on NIGHTSHIFT_APP_PORT. The daemon's
 * existing 127.0.0.1-only server (src/transport/server.ts) is untouched.
 *
 * Gate order on EVERY request (ADR 0011): bearer NIGHTSHIFT_APP_TOKEN,
 * constant-time compare, fail closed on empty; 401 PRECEDES 404, so an
 * unauthenticated probe learns nothing about which paths exist. Every non-2xx
 * body is the single error shape { ok: false, error } (contract invariant 6).
 *
 * Chat triad: POST /messages validates against the pinned InboundMessage
 * shape (400), checks personId against the configured owner (403 — vestigial
 * but validated, invariant 4), and returns 202 BEFORE relay() runs; the ack
 * outbox row is the durable acceptance AND dedup record (invariant 5). The
 * reply arrives later as a `reply` event. GET /events (SSE, Last-Event-ID
 * resume, comment keep-alives) and GET /outbox?after= serve the same events
 * by the same `app_outbox.id` cursor (invariant 2).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../../config.js';
import type { Logger } from '../../log.js';
import type { AssistantReply, InboundMessage } from '../../types.js';
import { readRawBody, respond } from '../server.js';
import type { AppEvent, AppOutbox } from './outbox.js';

/** SSE comment keep-alive cadence — frequent enough for phone NATs, cheap enough to ignore. */
const KEEPALIVE_MS = 15_000;

/** Contract identity served on GET /app/v1/manifest. Capabilities are BINDING (ADR 0009). */
const AGENT_NAME = 'nightshift-assistant';
/**
 * Exactly ["chat"] this stage — the schema-mandated floor, served for real.
 * files / mcp-tools / mcp-apps-ui are added ONLY when their stage's harness
 * checks are green (Stages 26–28); declaring earlier makes the manifest a lie.
 */
const CAPABILITIES: readonly string[] = ['chat'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppTransportDeps {
  config: Config;
  log: Logger;
  outbox: AppOutbox;
  /** The frozen seam (contracts/assistant-session.md) — consumed as-is, off the request path. */
  relay(msg: InboundMessage): Promise<AssistantReply>;
  version: string;
}

export interface AppTransport {
  /** The outbox this transport serves — the fan-out writes `notice` rows here. */
  outbox: AppOutbox;
  /** Bind every configured address on config.appPort; resolves the bound port. */
  listen(): Promise<number>;
  /** Bound port after listen() (null before). */
  port(): number | null;
  close(): Promise<void>;
}

/**
 * Constant-time bearer check — the same discipline as the control API
 * (src/transport/api.ts): both sides hashed to fixed length so timingSafeEqual
 * applies and neither content nor length of the expected token leaks. Empty
 * expected token → fail closed, never compare (and app.ts refuses to start
 * the listener at all in that case).
 */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (expected === '') return false;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/** Every non-2xx body on this surface is the contract's single error shape (invariant 6). */
function sendError(res: ServerResponse, status: number, error: string): void {
  respond(res, status, { ok: false, error });
}

/** The wire InboundMessage (schemas/v1/inbound-message.json) after validation. */
interface WireInbound {
  schema: 1;
  messageId: string;
  personId: string;
  text: string;
  /** Upload ids. `files` is undeclared this stage, so there are never ids to resolve. */
  attachments: string[];
  receivedAt: string;
}

/**
 * Hand-rolled mirror of the pinned inbound-message.json — kept dependency-free
 * so the daemon never needs the (dev-only) contract package at runtime. The
 * schema is normative; every clause below cites it.
 */
function validateInbound(
  body: unknown,
): { ok: true; msg: WireInbound } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object (inbound-message.json)' };
  }
  const b = body as Record<string, unknown>;
  if (b.schema !== 1) return { ok: false, error: 'schema must be the integer 1' };
  if (typeof b.messageId !== 'string' || !UUID_RE.test(b.messageId)) {
    return { ok: false, error: 'messageId must be a UUID string' };
  }
  if (typeof b.personId !== 'string' || b.personId === '') {
    return { ok: false, error: 'personId must be a non-empty string' };
  }
  if (typeof b.text !== 'string') return { ok: false, error: 'text must be a string' };
  if (
    !Array.isArray(b.attachments) ||
    b.attachments.some((a) => typeof a !== 'string' || a === '')
  ) {
    return { ok: false, error: 'attachments must be an array of non-empty strings' };
  }
  if (typeof b.receivedAt !== 'string' || Number.isNaN(Date.parse(b.receivedAt))) {
    return { ok: false, error: 'receivedAt must be an ISO 8601 date-time string' };
  }
  return {
    ok: true,
    msg: {
      schema: 1,
      messageId: b.messageId,
      personId: b.personId,
      text: b.text,
      attachments: b.attachments as string[],
      receivedAt: b.receivedAt,
    },
  };
}

export function createAppTransport(deps: AppTransportDeps): AppTransport {
  const { config, log, outbox, relay, version } = deps;
  const startedAt = Date.now();
  let boundPort: number | null = null;

  /** Everything after the 202: relay, then a durable `reply` row (SSE emit rides append). */
  async function processMessage(wire: WireInbound): Promise<void> {
    const inbound: InboundMessage = {
      schema: 1,
      messageId: wire.messageId,
      personId: wire.personId,
      text: wire.text,
      // Wire attachments are upload ids (`files` capability — undeclared this
      // stage, Stage 26). NEVER passed through as local paths.
      attachments: [],
      receivedAt: wire.receivedAt,
    };
    try {
      const reply = await relay(inbound);
      // Wire AssistantReply: `files` carries servable ids only — none until
      // the `files` capability lands, so local paths are dropped, not leaked.
      outbox.append('reply', {
        schema: 1,
        text: reply.text,
        files: [],
        ...(reply.sessionId !== '' ? { sessionId: reply.sessionId } : {}),
        rotated: reply.rotated,
      });
      log.info('app reply emitted', { messageId: wire.messageId });
    } catch (err) {
      // relay() never throws per contract; this guards the seam anyway.
      log.error('app message processing failed after 202', {
        messageId: wire.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      sendError(res, 413, 'request body too large');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(res, 400, 'request body is not valid JSON');
      return;
    }
    const checked = validateInbound(parsed);
    if (!checked.ok) {
      sendError(res, 400, `body does not match inbound-message.json: ${checked.error}`);
      return;
    }
    const wire = checked.msg;
    // Invariant 4: vestigial but VALIDATED — never used to select an identity.
    if (wire.personId !== config.webexOwnerPersonId) {
      sendError(res, 403, 'personId does not match the configured owner id');
      return;
    }
    // Invariant 5: the ack row is the durable acceptance record. A re-POST
    // (same client UUID) finds it — 202 again, nothing new emitted, no
    // re-run, across daemon restarts included.
    if (!outbox.hasAck(wire.messageId)) {
      outbox.append('ack', { messageId: wire.messageId });
      // 202 BEFORE relay(): the turn runs off the request path.
      setImmediate(() => {
        processMessage(wire).catch((err: unknown) => {
          log.error('app message processing failed', {
            messageId: wire.messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    } else {
      log.info('app message deduplicated', { messageId: wire.messageId });
    }
    respond(res, 202, { ok: true, messageId: wire.messageId });
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    const headerRaw = req.headers['last-event-id'];
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
    const lastEventId = Number.parseInt(header ?? '', 10);
    const after = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const writeEvent = (event: AppEvent): void => {
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Replay strictly after the cursor, then go live. better-sqlite3 is
    // synchronous and this handler never awaits between the two, so no append
    // can fall in the gap (invariant 2: resume == ?after=, exactly).
    for (const event of outbox.after(after)) writeEvent(event);
    const unsubscribe = outbox.onAppend(writeEvent);
    // Comment keep-alives: ignored by clients, keep NATs and proxies awake.
    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, KEEPALIVE_MS);
    keepAlive.unref();
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  }

  function handleOutbox(url: URL, res: ServerResponse): void {
    const afterParam = url.searchParams.get('after');
    if (afterParam !== null && !/^\d+$/.test(afterParam)) {
      sendError(res, 400, 'after must be a non-negative integer event id');
      return;
    }
    const after = afterParam === null ? 0 : Number.parseInt(afterParam, 10);
    respond(res, 200, { schema: 1, events: outbox.after(after) });
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // Gate 1 — bearer auth BEFORE routing: 401 precedes 404 on every path,
    // real or not, so the surface is not enumerable without a token.
    const authHeader = req.headers.authorization;
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!tokenMatches(header, config.appToken)) {
      log.warn('app request rejected: bearer auth failed', {
        path: req.url?.split('?')[0],
      });
      sendError(res, 401, 'unauthorized');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? '';

    if (method === 'GET' && path === '/app/v1/health') {
      respond(res, 200, {
        ok: true,
        version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (method === 'GET' && path === '/app/v1/manifest') {
      respond(res, 200, {
        schema: 1,
        agent: { name: AGENT_NAME, version },
        contract: { name: 'app-ingress', version: 1 },
        capabilities: [...CAPABILITIES],
      });
      return;
    }
    if (method === 'POST' && path === '/app/v1/messages') {
      handleMessages(req, res).catch((err: unknown) => {
        log.error('app messages handler error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) sendError(res, 500, 'internal error');
      });
      return;
    }
    if (method === 'GET' && path === '/app/v1/events') {
      handleEvents(req, res);
      return;
    }
    if (method === 'GET' && path === '/app/v1/outbox') {
      handleOutbox(url, res);
      return;
    }
    // Includes the capability-gated routes (/uploads, /files, /mcp): none of
    // their capabilities are declared, so they 404 — correct gating, not a stub.
    sendError(res, 404, 'not found');
  }

  // One server per configured bind address (node:http binds one address each);
  // all share the handler and the port. Never 0.0.0.0 — config refuses it.
  const servers: Server[] = config.appBind.map(() => createServer(handle));

  return {
    outbox,
    async listen(): Promise<number> {
      await Promise.all(
        servers.map(
          (server, i) =>
            new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(config.appPort, config.appBind[i], () => {
                const address = server.address();
                const port =
                  typeof address === 'object' && address !== null ? address.port : config.appPort;
                if (boundPort === null) boundPort = port;
                log.info('app transport listening', { host: config.appBind[i], port });
                resolve();
              });
            }),
        ),
      );
      return boundPort ?? config.appPort;
    },
    port(): number | null {
      return boundPort;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        let remaining = servers.length;
        let firstErr: Error | null = null;
        if (remaining === 0) {
          resolve();
          return;
        }
        for (const server of servers) {
          server.close((err) => {
            if (err && firstErr === null) firstErr = err;
            remaining -= 1;
            if (remaining === 0) {
              if (firstErr) reject(firstErr);
              else resolve();
            }
          });
          // Open SSE streams would hold close() forever — drop them; the
          // client resumes from its cursor (that is the whole design).
          server.closeAllConnections();
        }
      });
    },
  };
}

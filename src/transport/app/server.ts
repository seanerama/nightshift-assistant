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
 *
 * Files (Stage 26): POST /uploads lands multipart bytes in the existing
 * uploads/<ts>-<name> layout (size-capped BEFORE any disk write, filename
 * sanitized); GET /files/<id> serves ONLY ids in the durable app_files
 * mapping, re-confined at serve time. Inbound attachments (upload ids)
 * resolve to absolute local paths before relay() — the session cannot tell
 * which door a file came through — and the reply event echoes the message's
 * attachment ids plus fresh ids for any confined relay-produced files.
 *
 * MCP (Stage 27, ADR 0012): POST /mcp is delegated to the AppMcp bridge —
 * five thin tools over the same App.jobs/App.sessions doors the control API
 * uses. Mounted INSIDE this dispatch, so bearer auth (401 first), the flag,
 * and the containment posture all apply unchanged. POST-only per the
 * contract; GET/DELETE answer 405 (a streamable-HTTP client reads that as
 * "no standalone SSE / no session termination", per the MCP spec).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../../config.js';
import type { Logger } from '../../log.js';
import type { AssistantReply, InboundMessage } from '../../types.js';
import { readRawBody, respond } from '../server.js';
import type { AppFiles } from './files.js';
import type { AppMcp } from './mcp.js';
import type { AppEvent, AppOutbox } from './outbox.js';

/** SSE comment keep-alive cadence — frequent enough for phone NATs, cheap enough to ignore. */
const KEEPALIVE_MS = 15_000;

/** Contract identity served on GET /app/v1/manifest. Capabilities are BINDING (ADR 0009). */
const AGENT_NAME = 'nightshift-assistant';
/**
 * Declaring is BINDING (ADR 0009): "chat" is the schema-mandated floor
 * (Stage 24); "files" landed with Stage 26's upload→attach→retrieve loop
 * harness-green; "mcp-tools" landed with Stage 27's five thin doors (harness
 * mcp.initialize + mcp.tools green). mcp-apps-ui is added ONLY when Stage 28's
 * checks pass; declaring earlier makes the manifest a lie.
 */
const CAPABILITIES: readonly string[] = ['chat', 'files', 'mcp-tools'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Multipart parse overhead allowed beyond the attachment cap (headers + boundary). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const BYTES_PER_MB = 1024 * 1024;

export interface AppTransportDeps {
  config: Config;
  log: Logger;
  outbox: AppOutbox;
  /** The durable id→path registry behind /uploads and /files (Stage 26). */
  files: AppFiles;
  /** The MCP bridge behind POST /mcp (Stage 27, ADR 0012). */
  mcp: AppMcp;
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
  /** Upload ids previously returned by POST /app/v1/uploads (Stage 26). */
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

/** Rejection carrying "the body outgrew the cap" — distinct from transport errors. */
class BodyTooLargeError extends Error {}

/**
 * Bounded body reader for uploads: rejects the moment the cap is crossed,
 * BEFORE anything could reach disk. The request is left undestroyed so the
 * 413 can still go out on the same socket; the handler drains the remainder.
 */
function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (part: Buffer) => {
      if (rejected) return; // draining after rejection
      size += part.length;
      if (size > maxBytes) {
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

/**
 * Minimal multipart/form-data reader: the first part carrying a filename.
 * Deliberately hand-rolled (like the control surface's own parsers) — the
 * contract needs "a file part in, bytes out", nothing more.
 */
function firstFilePart(
  body: Buffer,
  contentType: string,
): { filename: string; bytes: Buffer } | null {
  if (!/^multipart\/form-data/i.test(contentType)) return null;
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2])?.trim();
  if (boundary === undefined || boundary === '') return null;
  const delimiter = Buffer.from(`--${boundary}`);
  let index = body.indexOf(delimiter);
  while (index !== -1) {
    const start = index + delimiter.length;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Trim the CRLF that opens the part and the CRLF that closes it.
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = part.subarray(0, split).toString('utf8');
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      if (filename !== undefined && filename !== '') {
        return { filename, bytes: Buffer.from(part.subarray(split + 4)) };
      }
    }
    index = next;
  }
  return null;
}

export function createAppTransport(deps: AppTransportDeps): AppTransport {
  const { config, log, outbox, files, mcp, relay, version } = deps;
  const startedAt = Date.now();
  let boundPort: number | null = null;

  /** Everything after the 202: relay, then a durable `reply` row (SSE emit rides append). */
  async function processMessage(wire: WireInbound, attachments: string[]): Promise<void> {
    const inbound: InboundMessage = {
      schema: 1,
      messageId: wire.messageId,
      personId: wire.personId,
      text: wire.text,
      // Absolute uploads/<ts>-<name> paths — exactly what the Webex door
      // produces, so the session cannot tell which door a file came through.
      attachments,
      receivedAt: wire.receivedAt,
    };
    try {
      const reply = await relay(inbound);
      // Wire AssistantReply.files carries servable ids only: the message's
      // own attachment ids ride back (the certified round-trip — upload,
      // reference, receive back, download), plus fresh ids for any confined
      // relay-produced files. Unconfined local paths are dropped, not leaked.
      outbox.append('reply', {
        schema: 1,
        text: reply.text,
        files: [...wire.attachments, ...files.issueIds(reply.files)],
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
    // Attachments are upload ids from POST /uploads. An unknown id is a
    // client error refused up front (400) — silently dropping a file the
    // owner meant to send would be quiet data loss. (The reference mock
    // filters instead; the mock is not the oracle, the harness never sends
    // an unregistered id.)
    const attachments: string[] = [];
    for (const id of wire.attachments) {
      const path = files.resolve(id);
      if (path === null) {
        sendError(res, 400, `unknown upload id in attachments: ${id}`);
        return;
      }
      attachments.push(path);
    }
    // Invariant 5: the ack row is the durable acceptance record. A re-POST
    // (same client UUID) finds it — 202 again, nothing new emitted, no
    // re-run, across daemon restarts included.
    if (!outbox.hasAck(wire.messageId)) {
      outbox.append('ack', { messageId: wire.messageId });
      // 202 BEFORE relay(): the turn runs off the request path.
      setImmediate(() => {
        processMessage(wire, attachments).catch((err: unknown) => {
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

  async function handleUploads(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Size-cap discipline (NIGHTSHIFT_ATTACH_MAX_MB, same knob as Webex
    // attachments): enforced WHILE reading — an oversize body is refused
    // before a single byte can reach disk. 0 disables file uploads entirely.
    const capBytes = config.attachMaxMb * BYTES_PER_MB;
    let raw: Buffer;
    try {
      raw = await readBoundedBody(req, capBytes + MULTIPART_OVERHEAD_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendError(
          res,
          413,
          `upload exceeds the ${config.attachMaxMb}MB cap (NIGHTSHIFT_ATTACH_MAX_MB)`,
        );
        req.resume(); // drain the remainder so the 413 can be delivered
        return;
      }
      throw err;
    }
    const part = firstFilePart(raw, req.headers['content-type'] ?? '');
    if (part === null) {
      sendError(res, 400, 'expected multipart/form-data with a file part');
      return;
    }
    if (part.bytes.length > capBytes) {
      sendError(
        res,
        413,
        `upload exceeds the ${config.attachMaxMb}MB cap (NIGHTSHIFT_ATTACH_MAX_MB)`,
      );
      return;
    }
    const saved = files.saveUpload(part.filename, part.bytes);
    // upload-response.json: 201 Created exactly; path is informational only.
    respond(res, 201, { ok: true, uploadId: saved.uploadId, path: saved.relPath });
  }

  function handleFileDownload(id: string, res: ServerResponse): void {
    // NEVER an arbitrary-path read: only ids in the durable mapping resolve,
    // re-confined at serve time. Unknown/vanished/escaped → 404 (auth already
    // passed — 401 still precedes this).
    const real = files.resolve(id);
    if (real === null) {
      sendError(res, 404, `no such file: ${id}`);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch {
      sendError(res, 404, `no such file: ${id}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    res.end(bytes);
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

  /**
   * decodeURIComponent that treats malformed percent-encoding as the literal
   * string instead of throwing URIError. No issued id contains a raw '%', so
   * a malformed id simply misses the mapping and 404s like any unknown id.
   */
  function safeDecode(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    // CONTAINMENT (review fix, PR #67): the entire synchronous dispatch is
    // guarded — an app-surface failure must answer with the error shape, and
    // must NEVER escape to crash the daemon (the Webex door rides in the same
    // process). Async handlers carry their own .catch with the same posture.
    try {
      routeRequest(req, res);
    } catch (err) {
      log.error('app request handler failed', {
        path: req.url?.split('?')[0],
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendError(res, 500, 'internal error');
    }
  }

  function routeRequest(req: IncomingMessage, res: ServerResponse): void {
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
        // Clamped: health.json requires uptimeSec >= 0, and a wall-clock
        // adjustment (NTP step, VM resume) can briefly make the delta negative.
        uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
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
    if (method === 'POST' && path === '/app/v1/uploads') {
      handleUploads(req, res).catch((err: unknown) => {
        log.error('app uploads handler error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) sendError(res, 500, 'internal error');
      });
      return;
    }
    if (method === 'GET' && path.startsWith('/app/v1/files/')) {
      handleFileDownload(safeDecode(path.slice('/app/v1/files/'.length)), res);
      return;
    }
    if (path === '/app/v1/mcp') {
      if (method === 'POST') {
        // Same async containment posture as /messages and /uploads: a bridge
        // failure answers the error shape and never escapes the dispatch.
        mcp.handle(req, res).catch((err: unknown) => {
          log.error('app mcp handler error', {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.headersSent) sendError(res, 500, 'internal error');
        });
        return;
      }
      // The contract exposes POST only; 405 tells a streamable-HTTP client
      // "no standalone SSE stream, no session DELETE" (MCP spec behavior).
      sendError(res, 405, 'method not allowed (POST only)');
      return;
    }
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

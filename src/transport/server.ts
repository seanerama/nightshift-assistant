/**
 * Transport (contracts/webex-ingress.md): POST /webhook with the full fail-closed
 * verification chain, GET /health. The webhook handler acks 200 fast and does all
 * real work off the request path. The daemon binds 127.0.0.1 ONLY (ADR 0001) —
 * exposure is via the cloudflared tunnel to /webhook and nothing else.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { InboundMessage } from '../types.js';
import { MessageDedup } from './dedup.js';
import type { Sender } from './send.js';
import type { WebexClient } from './webex.js';

const MAX_BODY_BYTES = 1024 * 1024;

/** One-time receipt sent when a turn outlives NIGHTSHIFT_ACK_AFTER_SEC (Stage 8). */
export const ACK_TEXT = '🌙 On it — working on your request…';

export interface TransportDeps {
  config: Config;
  log: Logger;
  webex: WebexClient;
  sender: Sender;
  relay(msg: InboundMessage): Promise<{ text: string }>;
  /** Called with the owner's roomId on every authorized message (notice routing). */
  onOwnerRoom?(roomId: string): void;
  version: string;
  /**
   * Handler for /api/v1/* (contracts/control-api.md) — mounted here so the
   * loopback-only bind is inherited. Owns its own kill-switch/auth/404s.
   */
  api?(req: IncomingMessage, res: ServerResponse): void;
}

interface WebhookBody {
  resource?: string;
  event?: string;
  createdBy?: string;
  data?: { id?: string; personId?: string; roomId?: string };
}

function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  // Fail closed: no secret configured → reject ALL webhook requests.
  if (secret === '') return false;
  if (header === undefined || header === '') return false;
  const expected = createHmac('sha1', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Bounded body reader — shared with the /api/v1 handler (api.ts). */
export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** JSON responder — shared with the /api/v1 handler (api.ts). */
export function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export function createTransportServer(deps: TransportDeps): Server {
  const { config, log, webex, sender, relay, onOwnerRoom, version, api } = deps;
  const dedup = new MessageDedup();
  const startedAt = Date.now();

  /** Everything after the 200 ack: fetch, authorize, relay, reply. */
  async function processWebhook(messageId: string): Promise<void> {
    const message = await webex.fetchMessage(messageId);

    // Authorize the FETCHED message's sender — never the webhook body's.
    if (message.personId !== config.webexOwnerPersonId) {
      log.info('webhook dropped: sender is not the owner', { messageId });
      return;
    }

    // Remember the owner's most recent room for proactive notices (rotation).
    onOwnerRoom?.(message.roomId);

    const inbound: InboundMessage = {
      schema: 1,
      messageId,
      personId: message.personId,
      text: message.text ?? '',
      attachments: [],
      receivedAt: new Date().toISOString(),
    };

    log.info('relaying inbound message', { messageId });
    const dest = { roomId: message.roomId };

    // Deferred human ack (Stage 8): when relay() outlives the threshold, send
    // ONE short receipt so a slow turn is distinguishable from a dead bot.
    // setTimeout fires at most once → never more than one ack per inbound
    // message; 0 disables entirely. Ack failures are logged, never fatal, and
    // never suppress or delay the real reply.
    let ackTimer: NodeJS.Timeout | undefined;
    if (config.ackAfterSec > 0) {
      ackTimer = setTimeout(() => {
        log.info('slow turn: sending receipt ack', { messageId });
        sender.send(dest, ACK_TEXT).catch((err: unknown) => {
          log.error('ack send failed (real reply unaffected)', {
            messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, config.ackAfterSec * 1000);
    }

    try {
      let reply: { text: string };
      try {
        reply = await relay(inbound);
      } finally {
        // The reply beat the timer (or relay failed) — no ack from here on.
        if (ackTimer !== undefined) clearTimeout(ackTimer);
      }
      await sender.send(dest, reply.text);
      log.info('reply delivered', { messageId });
    } catch (err) {
      // relay() itself never throws per contract; this guards the send path.
      log.error('webhook processing failed after ack', {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readRawBody(req);

    const signature = req.headers['x-spark-signature'];
    const header = Array.isArray(signature) ? signature[0] : signature;
    if (!verifySignature(rawBody, header, config.webexWebhookSecret)) {
      log.warn('webhook rejected: signature verification failed', {
        hasHeader: header !== undefined && header !== '',
        secretConfigured: config.webexWebhookSecret !== '',
      });
      respond(res, 401, { error: 'unauthorized' });
      return;
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;
    } catch {
      respond(res, 400, { error: 'invalid JSON' });
      return;
    }

    if (body.resource !== 'messages' || body.event !== 'created') {
      log.info('webhook ignored: unhandled resource/event', {
        resource: body.resource,
        event: body.event,
      });
      respond(res, 200, { ok: true });
      return;
    }

    const messageId = body.data?.id;
    if (messageId === undefined || messageId === '') {
      respond(res, 400, { error: 'missing data.id' });
      return;
    }

    // The bot's own messages are dropped (webhook createdBy is the bot's id).
    if (body.createdBy !== undefined && body.data?.personId === body.createdBy) {
      log.info('webhook dropped: bot own message', { messageId });
      respond(res, 200, { ok: true });
      return;
    }

    // Dedup on messageId: duplicates ack 200 with no re-execution.
    if (!dedup.markIfNew(messageId)) {
      log.info('webhook dropped: duplicate messageId', { messageId });
      respond(res, 200, { ok: true });
      return;
    }

    // Ack fast; all real work happens off the request path.
    respond(res, 200, { ok: true });
    setImmediate(() => {
      processWebhook(messageId).catch((err: unknown) => {
        log.error('webhook processing failed', {
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  const server = createServer((req, res) => {
    const url = req.url?.split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      respond(res, 200, {
        ok: true,
        version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (api !== undefined && url?.startsWith('/api/v1/') === true) {
      api(req, res);
      return;
    }
    if (req.method === 'POST' && url === '/webhook') {
      handleWebhook(req, res).catch((err: unknown) => {
        log.error('webhook handler error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) respond(res, 500, { error: 'internal error' });
      });
      return;
    }
    respond(res, 404, { error: 'not found' });
  });

  return server;
}

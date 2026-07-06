/** Shared test scaffolding: capturing logger, test config, Webex fixture server, HMAC signer. */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/log.js';

export const AGENT_STUB = fileURLToPath(new URL('./fixtures/agent-stub.cjs', import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface LogEntry {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

export interface TestLogger extends Logger {
  entries: LogEntry[];
}

export function makeTestLogger(): TestLogger {
  const entries: LogEntry[] = [];
  const record =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      entries.push({ level, msg, fields });
    };
  return {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    webexBotToken: 'test-bot-token',
    webexWebhookSecret: 'test-webhook-secret',
    webexOwnerPersonId: 'owner-person-id',
    webexApiBase: 'http://127.0.0.1:1/v1', // unreachable unless a test wires the stub
    agentBin: AGENT_STUB,
    dbPath: ':memory:',
    port: 0, // ephemeral
    turnTimeoutSec: 10,
    ...overrides,
  };
}

export function sign(body: string, secret: string): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex');
}

export interface StubMessage {
  id: string;
  roomId: string;
  personId: string;
  text: string;
}

export interface WebexStub {
  baseUrl: string;
  /** Bodies of every POST /messages received. */
  sends: Array<Record<string, unknown>>;
  /** Register a message GET /messages/:id will serve. */
  addMessage(msg: StubMessage): void;
  close(): Promise<void>;
}

/** Local HTTP fixture server standing in for the Webex API (the WEBEX_API_BASE seam). */
export async function startWebexStub(): Promise<WebexStub> {
  const messages = new Map<string, StubMessage>();
  const sends: Array<Record<string, unknown>> = [];

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/v1/messages/')) {
      const id = decodeURIComponent(url.slice('/v1/messages/'.length));
      const msg = messages.get(id);
      if (msg === undefined) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg));
      return;
    }
    if (req.method === 'POST' && url === '/v1/messages') {
      let body = '';
      req.on('data', (d: Buffer) => {
        body += d.toString('utf8');
      });
      req.on('end', () => {
        sends.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `sent-${sends.length}` }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    sends,
    addMessage(msg: StubMessage): void {
      messages.set(msg.id, msg);
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

export function webhookBody(messageId: string, opts: { personId?: string } = {}): string {
  return JSON.stringify({
    id: 'webhook-1',
    name: 'nightshift',
    resource: 'messages',
    event: 'created',
    createdBy: 'bot-person-id',
    data: {
      id: messageId,
      roomId: 'room-1',
      personId: opts.personId ?? 'owner-person-id',
    },
  });
}

/** Shared test scaffolding: capturing logger, test config, Webex fixture server, HMAC signer. */

import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/log.js';

export const AGENT_STUB = fileURLToPath(new URL('./fixtures/agent-stub.cjs', import.meta.url));
export const WORKER_STUB = fileURLToPath(new URL('./fixtures/worker-stub.cjs', import.meta.url));
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
    model: 'claude-sonnet-5', // Stage 12: the documented conversational default
    dbPath: ':memory:',
    port: 0, // ephemeral
    turnTimeoutSec: 10,
    ackAfterSec: 0, // off in the shared config; Stage 8 ack tests set a small threshold
    rotationEnabled: false, // Stage 2 ships dark; rotation tests flip it on
    rotateHour: 4,
    sizeCapTurns: 200,
    seedMaxBytes: 16384,
    jobsEnabled: false, // Stage 4 ships dark; job tests flip it on
    maxJobs: 2,
    jobRetryCap: 2,
    jobKillGraceSec: 10,
    controlEnabled: false, // Stage 5 ships dark; control tests flip it on
    apiToken: '',
    typesEnabled: false, // Stage 6 ships dark; job-type tests flip it on
    attachMaxMb: 80,
    autoAttachMaxMb: 10,
    promoteEnabled: false, // Stage 11 ships dark; promotion tests flip it on
    promote: {
      coolifyApiUrl: 'http://127.0.0.1:1', // unreachable unless a test wires the stub
      coolifyApiToken: 'test-coolify-token',
      coolifyProjectUuid: 'proj-uuid',
      coolifyServerUuid: 'server-uuid',
      coolifyEnvironment: 'production',
      cfAccountId: 'cf-account',
      cfZoneId: 'cf-zone',
      cfTunnelId: 'cf-tunnel',
      cfDnsToken: 'test-cf-token',
      domain: 'example.test',
      cfApiBase: 'http://127.0.0.1:1/client/v4',
      healthBase: '',
    },
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
  /**
   * Bodies of every POST /messages received. JSON posts record the parsed
   * body; multipart posts record the form fields plus `fileName` + `fileBytes`
   * for the ONE `files` part a Webex message may carry.
   */
  sends: Array<Record<string, unknown>>;
  /** Register a message GET /messages/:id will serve. */
  addMessage(msg: StubMessage): void;
  /** Make the next n POST /messages fail with 500 (send-failure tests). */
  failNext(n: number): void;
  close(): Promise<void>;
}

/** Minimal multipart/form-data parser for the fixture: fields + one file part. */
function parseMultipart(body: Buffer, contentType: string): Record<string, unknown> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  const out: Record<string, unknown> = {};
  // 'binary' keeps a 1:1 byte↔char mapping so byte counts stay exact.
  for (const part of body.toString('binary').split(`--${boundary}`)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    const disposition =
      /content-disposition:[^\r\n]*\bname="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    if (disposition === null) continue;
    const name = disposition[1] as string;
    const filename = disposition[2];
    let value = part.slice(headerEnd + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    if (filename !== undefined) {
      out.fileName = filename;
      out.fileBytes = value.length;
    } else {
      out[name] = Buffer.from(value, 'binary').toString('utf8');
    }
  }
  return out;
}

/** Local HTTP fixture server standing in for the Webex API (the WEBEX_API_BASE seam). */
export async function startWebexStub(): Promise<WebexStub> {
  const messages = new Map<string, StubMessage>();
  const sends: Array<Record<string, unknown>> = [];
  let failRemaining = 0;

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
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => {
        parts.push(d);
      });
      req.on('end', () => {
        if (failRemaining > 0) {
          failRemaining -= 1;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'injected failure' }));
          return;
        }
        const body = Buffer.concat(parts);
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.startsWith('multipart/form-data')) {
          sends.push(parseMultipart(body, contentType));
        } else {
          sends.push(JSON.parse(body.toString('utf8')) as Record<string, unknown>);
        }
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
    failNext(n: number): void {
      failRemaining = n;
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

// ── Stage 11 promotion fixtures ─────────────────────────────────────────────

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Base of every promotion HTTP fixture: URL + the requests it received. */
interface PromotionStubBase {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface CoolifyStub extends PromotionStubBase {
  /** Make POST /api/v1/applications/public fail with 500 (step-failure tests). */
  failCreate(on: boolean): void;
}

export interface CloudflareStub extends PromotionStubBase {
  /** The tunnel-config ingress rules the fixture currently serves. */
  ingress: Array<Record<string, unknown>>;
}

export interface HealthStub extends PromotionStubBase {
  /** 503 the first n GETs (health-retry tests). */
  failFirst(n: number): void;
}

function startRecordingServer(
  handle: (req: RecordedRequest, res: import('node:http').ServerResponse) => void,
): Promise<PromotionStubBase> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      parts.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      let body: unknown = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        body,
      };
      requests.push(recorded);
      handle(recorded, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close(): Promise<void> {
          return new Promise((res2, rej) => {
            server.close((err) => (err ? rej(err) : res2()));
          });
        },
      });
    });
  });
}

const respondJson = (
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Coolify API fixture: create app → uuid, deploy → deployment id, poll → finished. */
export async function startCoolifyStub(): Promise<CoolifyStub> {
  let failing = false;
  const base = await startRecordingServer((req, res) => {
    if (req.method === 'POST' && req.path === '/api/v1/applications/public') {
      if (failing) {
        respondJson(res, 500, { message: 'injected coolify failure' });
        return;
      }
      respondJson(res, 201, { uuid: 'app-uuid-1' });
      return;
    }
    if (req.method === 'POST' && req.path === '/api/v1/deploy') {
      respondJson(res, 200, { deployments: [{ deployment_uuid: 'dep-1' }] });
      return;
    }
    if (req.method === 'GET' && req.path.startsWith('/api/v1/deployments/')) {
      respondJson(res, 200, { status: 'finished' });
      return;
    }
    respondJson(res, 404, { message: 'not found' });
  });
  return {
    ...base,
    failCreate(on: boolean): void {
      failing = on;
    },
  };
}

/** Cloudflare API fixture: tunnel configurations GET/PUT + DNS record POST. */
export async function startCloudflareStub(): Promise<CloudflareStub> {
  const ingress: Array<Record<string, unknown>> = [{ service: 'http_status:404' }];
  const stub = await startRecordingServer((req, res) => {
    if (/^\/client\/v4\/accounts\/[^/]+\/cfd_tunnel\/[^/]+\/configurations$/.test(req.path)) {
      if (req.method === 'GET') {
        respondJson(res, 200, { success: true, result: { config: { ingress } } });
        return;
      }
      if (req.method === 'PUT') {
        const config = (req.body as { config?: { ingress?: Array<Record<string, unknown>> } })
          .config;
        ingress.length = 0;
        ingress.push(...(config?.ingress ?? []));
        respondJson(res, 200, { success: true });
        return;
      }
    }
    if (req.method === 'POST' && /^\/client\/v4\/zones\/[^/]+\/dns_records$/.test(req.path)) {
      respondJson(res, 200, { success: true, result: { id: 'dns-1' } });
      return;
    }
    respondJson(res, 404, { success: false });
  });
  return { ...stub, baseUrl: `${stub.baseUrl}/client/v4`, ingress };
}

/** Health-target fixture: GET /<slug> → 200 (after failFirst n, when set). */
export async function startHealthStub(): Promise<HealthStub> {
  let failRemaining = 0;
  const base = await startRecordingServer((_req, res) => {
    if (failRemaining > 0) {
      failRemaining -= 1;
      respondJson(res, 503, { message: 'not up yet' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ok</title>');
  });
  return {
    ...base,
    failFirst(n: number): void {
      failRemaining = n;
    },
  };
}

/**
 * PATH shim for the repo step: a dir with fake `git` and `gh` executables that
 * append every invocation to invocations.log. `gh repo view` exits 1 until
 * `gh repo create` runs (it touches repo-exists) — so the first promote takes
 * the create path and a re-promote takes the update path, like the real gh.
 */
export function makeToolShim(dir: string): {
  shimDir: string;
  env: NodeJS.ProcessEnv;
  invocations(): string[];
} {
  const shimDir = join(dir, 'tool-shim');
  mkdirSync(shimDir, { recursive: true });
  const logPath = join(shimDir, 'invocations.log');
  const gitScript = [
    '#!/bin/sh',
    `echo "git $*" >> "${logPath}"`,
    'case "$1" in',
    '  rev-parse) echo main ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
  const ghScript = [
    '#!/bin/sh',
    `echo "gh $*" >> "${logPath}"`,
    'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
    `  if [ -e "${join(shimDir, 'repo-exists')}" ]; then exit 0; else exit 1; fi`,
    'fi',
    'if [ "$1" = "repo" ] && [ "$2" = "create" ]; then',
    `  touch "${join(shimDir, 'repo-exists')}"`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(shimDir, 'git'), gitScript, { mode: 0o755 });
  writeFileSync(join(shimDir, 'gh'), ghScript, { mode: 0o755 });
  return {
    shimDir,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
    invocations(): string[] {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    },
  };
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

/**
 * Stage 26 app files (contracts/app-ingress.md `files` capability): multipart
 * uploads land in the existing uploads/<ts>-<name> layout and reach relay()
 * as absolute paths (indistinguishable from the Webex door); reply files
 * come back as servable ids; GET /files/<id> is never an arbitrary-path read
 * (durable mapping + confined-roots resolution at serve time). Security:
 * traversal neutralized, unmapped id 404, out-of-confinement file never
 * served, oversize refused before any byte lands.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { type AppFiles, createAppFiles, sanitizeFilename } from '../src/transport/app/files.js';
import { createUiNotifyHub } from '../src/transport/app/mcp.js';
import { type AppEvent, type AppOutbox, createAppOutbox } from '../src/transport/app/outbox.js';
import { type AppTransport, createAppTransport } from '../src/transport/app/server.js';
import type { AssistantReply, InboundMessage } from '../src/types.js';
import {
  MIGRATIONS_DIR,
  makeAppMcp,
  makeConfig,
  makeTestLogger,
  type TestLogger,
} from './helpers.js';

const TOKEN = 'test-app-token';

interface Harness {
  dir: string;
  uploadsDir: string;
  /** A confined root standing in for <appDir>/jobs (reply files live here). */
  jobsDir: string;
  db: Database.Database;
  log: TestLogger;
  outbox: AppOutbox;
  files: AppFiles;
  transport: AppTransport;
  port: number;
  relayCalls: InboundMessage[];
  close(): Promise<void>;
}

async function start(
  relay: (msg: InboundMessage) => Promise<AssistantReply>,
  overrides: Partial<Config> = {},
  db?: Database.Database,
  existingDir?: string,
): Promise<Harness> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), 'nightshift-appfiles-'));
  const uploadsDir = join(dir, 'uploads');
  const jobsDir = join(dir, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
  const database = db ?? openDatabase(':memory:');
  migrate(database, MIGRATIONS_DIR);
  const log = makeTestLogger();
  const config = makeConfig({
    appTransportEnabled: true,
    appToken: TOKEN,
    appPort: 0,
    ...overrides,
  });
  const outbox = createAppOutbox(database, log);
  const files = createAppFiles(database, log, { uploadsDir, roots: [uploadsDir, jobsDir] });
  const relayCalls: InboundMessage[] = [];
  const transport = createAppTransport({
    config,
    log,
    outbox,
    files,
    mcp: makeAppMcp(database, log, config),
    uiNotify: createUiNotifyHub(log),
    relay: (msg) => {
      relayCalls.push(msg);
      return relay(msg);
    },
    version: '0.0.0-test',
  });
  const port = await transport.listen();
  return {
    dir,
    uploadsDir,
    jobsDir,
    db: database,
    log,
    outbox,
    files,
    transport,
    port,
    relayCalls,
    async close(): Promise<void> {
      await transport.close();
      database.close();
      if (existingDir === undefined) rmSync(dir, { recursive: true, force: true });
    },
  };
}

function multipart(
  filename: string,
  content: string | Buffer,
): { body: Buffer; contentType: string } {
  const boundary = `----test${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `content-disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'content-type: application/octet-stream\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(port: number, filename: string, content: string | Buffer): Promise<Response> {
  const { body, contentType } = multipart(filename, content);
  return fetch(`http://127.0.0.1:${port}/app/v1/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType },
    body,
  });
}

const get = (port: number, path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

const postMessage = (port: number, msg: Record<string, unknown>): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/app/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(msg),
  });

const wireMsg = (attachments: string[] = []): Record<string, unknown> => ({
  schema: 1,
  messageId: randomUUID(),
  personId: 'owner-person-id',
  text: 'message with files',
  attachments,
  receivedAt: new Date().toISOString(),
});

async function pollForReply(port: number): Promise<AppEvent | undefined> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const res = await get(port, '/app/v1/outbox');
    const events = ((await res.json()) as { events: AppEvent[] }).events;
    const reply = events.find((e) => e.type === 'reply');
    if (reply !== undefined) return reply;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

describe('the full round trip: upload → attach → relay → reply → download', () => {
  it('carries a file through both directions byte-identically', async () => {
    const h = await start(async (msg) => {
      // The relay stub "produces" a file under a confined root and names it.
      const outPath = join(h.jobsDir, 'result.md');
      writeFileSync(outPath, `# produced for ${msg.messageId}`);
      return { schema: 1, text: 'done', files: [outPath], sessionId: 'sess-1', rotated: false };
    });
    try {
      // 1. Upload lands 201 with the upload-response shape…
      const uploaded = await upload(h.port, 'report.txt', 'hello bytes');
      expect(uploaded.status).toBe(201);
      const body = (await uploaded.json()) as { ok: boolean; uploadId: string; path: string };
      expect(body.ok).toBe(true);
      expect(body.uploadId).toMatch(/^up_/);
      expect(body.path).toMatch(/^uploads\/.+-report\.txt$/);
      // …in the EXISTING uploads/<ts>-<name> layout on disk, byte-identical.
      const stored = readdirSync(h.uploadsDir);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatch(/-report\.txt$/);
      expect(readFileSync(join(h.uploadsDir, stored[0] as string), 'utf8')).toBe('hello bytes');

      // 2. A message referencing the upload id reaches relay() with the
      // ABSOLUTE path — exactly what the Webex door would hand it.
      const msg = wireMsg([body.uploadId]);
      const accepted = await postMessage(h.port, msg);
      expect(accepted.status).toBe(202);
      const reply = await pollForReply(h.port);
      expect(reply).toBeDefined();
      expect(h.relayCalls).toHaveLength(1);
      expect(h.relayCalls[0]?.attachments).toEqual([join(h.uploadsDir, stored[0] as string)]);

      // 3. The reply echoes the attachment id AND issues a servable id for
      // the relay-produced confined file.
      const replyFiles = reply?.payload.files as string[];
      expect(replyFiles).toContain(body.uploadId);
      const producedId = replyFiles.find((id) => id.startsWith('f_'));
      expect(producedId).toBeDefined();

      // 4. Both ids download byte-identically.
      const down = await get(h.port, `/app/v1/files/${encodeURIComponent(body.uploadId)}`);
      expect(down.status).toBe(200);
      expect(await down.text()).toBe('hello bytes');
      const downProduced = await get(h.port, `/app/v1/files/${producedId}`);
      expect(downProduced.status).toBe(200);
      expect(await downProduced.text()).toBe(`# produced for ${msg.messageId}`);
    } finally {
      await h.close();
    }
  });

  it('the id→path mapping is durable: a restart still serves an old upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightshift-appfiles-'));
    const dbPath = join(dir, 'app.db');
    const neverRelay = (): Promise<AssistantReply> => new Promise(() => undefined);
    try {
      const life1 = await start(neverRelay, {}, openDatabase(dbPath), dir);
      const uploaded = await upload(life1.port, 'keep.txt', 'survives restarts');
      const { uploadId } = (await uploaded.json()) as { uploadId: string };
      await life1.close();

      const life2 = await start(neverRelay, {}, openDatabase(dbPath), dir);
      const down = await get(life2.port, `/app/v1/files/${uploadId}`);
      expect(down.status).toBe(200);
      expect(await down.text()).toBe('survives restarts');
      await life2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('security: no arbitrary-path read, no traversal, no unconfined serving', () => {
  const neverRelay = (): Promise<AssistantReply> => new Promise(() => undefined);

  it('neutralizes path traversal in the multipart filename', async () => {
    const h = await start(neverRelay);
    try {
      for (const evil of ['../../../etc/evil.txt', '..\\..\\evil.txt', '....//evil.txt']) {
        const res = await upload(h.port, evil, 'trap');
        expect(res.status).toBe(201);
      }
      // Everything landed INSIDE uploads/ as bare sanitized filenames.
      const stored = readdirSync(h.uploadsDir);
      expect(stored).toHaveLength(3);
      for (const name of stored) expect(name).toMatch(/evil\.txt$/);
      expect(existsSync(join(h.dir, 'evil.txt'))).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('sanitizeFilename strips separators, leading dots, and garbage', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\boot.ini')).toBe('boot.ini');
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('...hidden')).toBe('hidden');
    expect(sanitizeFilename('sp ace$&.pdf')).toBe('sp_ace__.pdf');
    expect(sanitizeFilename('')).toBe('file');
  });

  it('survives a malformed percent-encoded file id — JSON error, process alive (PR #67 fix)', async () => {
    const h = await start(neverRelay);
    try {
      // Auth-first unchanged: without a token even the malformed path gets 401.
      const unauthed = await fetch(`http://127.0.0.1:${h.port}/app/v1/files/%zz`);
      expect(unauthed.status).toBe(401);
      // Authenticated: the malformed id decodes to its literal text, misses
      // the mapping, and 404s with the error shape — it must never throw
      // URIError out of the dispatch and take the daemon (and the Webex
      // door with it) down.
      const res = await get(h.port, '/app/v1/files/%zz');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      // The process survived: the SAME transport keeps serving.
      const health = await get(h.port, '/app/v1/health');
      expect(health.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('404s an unmapped file id with the error shape', async () => {
    const h = await start(neverRelay);
    try {
      const res = await get(h.port, `/app/v1/files/definitely-not-${randomUUID()}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('no such file');
    } finally {
      await h.close();
    }
  });

  it('400s a message referencing an unknown upload id — refused, not silently dropped', async () => {
    const h = await start(neverRelay);
    try {
      const res = await postMessage(h.port, wireMsg([`up_${randomUUID()}`]));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('unknown upload id');
      // Refused BEFORE acceptance: no ack row, no relay call.
      const events = (
        (await (await get(h.port, '/app/v1/outbox')).json()) as {
          events: AppEvent[];
        }
      ).events;
      expect(events).toHaveLength(0);
      expect(h.relayCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('drops a reply file outside the confined roots — logged, never served', async () => {
    const h = await start(async () => ({
      schema: 1,
      text: 'reply naming an unconfined file',
      // Exists on every host, lives far outside the roots.
      files: ['/etc/hostname'],
      sessionId: 'sess-1',
      rotated: false,
    }));
    try {
      await postMessage(h.port, wireMsg());
      const reply = await pollForReply(h.port);
      expect(reply?.payload.files).toEqual([]);
      expect(
        h.log.entries.some((e) => e.level === 'warn' && e.msg.includes('confined roots')),
      ).toBe(true);
      // And no id in the mapping resolves to it.
      const rows = h.db.prepare('SELECT path FROM app_files').all() as Array<{ path: string }>;
      expect(rows).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('rejects an oversize upload BEFORE any byte lands on disk', async () => {
    // attachMaxMb: 1 → cap 1MiB (+64KiB parse overhead); send ~2MiB.
    const h = await start(neverRelay, { attachMaxMb: 1 });
    try {
      const res = await upload(h.port, 'big.bin', Buffer.alloc(2 * 1024 * 1024, 7));
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error: string }).error).toContain('NIGHTSHIFT_ATTACH_MAX_MB');
      expect(existsSync(h.uploadsDir)).toBe(false); // uploads/ never even created
    } finally {
      await h.close();
    }
  });

  it('attachMaxMb=0 disables uploads entirely (the documented knob semantics)', async () => {
    const h = await start(neverRelay, { attachMaxMb: 0 });
    try {
      const res = await upload(h.port, 'any.txt', 'x');
      expect(res.status).toBe(413);
      expect(existsSync(h.uploadsDir)).toBe(false);
    } finally {
      await h.close();
    }
  });
});

/**
 * Stage 24 app transport (contracts/app-ingress.md v1, pinned to
 * agent-app-contract#v1.0.0; ADR 0009–0011): bearer auth with 401-before-404,
 * health + manifest (capabilities exactly
 * ["chat","files","mcp-tools","mcp-apps-ui"] since Stage 28),
 * the chat triad (202 before relay, durable dedup across restart, SSE
 * Last-Event-ID resume == ?after=), the migration ladder, and the dark-flag /
 * fail-closed startup wiring. The CI conformance job is the contract test;
 * these are the seams it cannot reach (restart durability, hanging relay,
 * flag-off absence). Stage 26 file specifics live in app-files.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { type AppFiles, createAppFiles } from '../src/transport/app/files.js';
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
  waitFor,
} from './helpers.js';

const TOKEN = 'test-app-token';

/** A schema-valid wire InboundMessage from the owner (overridable per test). */
const wireMsg = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  messageId: randomUUID(),
  personId: 'owner-person-id',
  text: 'hello from the app',
  attachments: [],
  receivedAt: new Date().toISOString(),
  ...overrides,
});

const echoRelay = async (msg: InboundMessage): Promise<AssistantReply> => ({
  schema: 1,
  text: `echo: ${msg.text}`,
  files: ['/tmp/never-leaked.pdf'],
  sessionId: 'sess-app-1',
  rotated: false,
});

interface Harness {
  db: Database.Database;
  log: TestLogger;
  outbox: AppOutbox;
  files: AppFiles;
  /** The registry's uploads/ dir (temp; removed on close). */
  uploadsDir: string;
  transport: AppTransport;
  port: number;
  relayCalls: InboundMessage[];
  close(): Promise<void>;
}

async function startTransport(
  relay: (msg: InboundMessage) => Promise<AssistantReply> = echoRelay,
  db?: Database.Database,
  overrides: Partial<Config> = {},
): Promise<Harness> {
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
  const tempDir = mkdtempSync(join(tmpdir(), 'nightshift-appt-'));
  const uploadsDir = join(tempDir, 'uploads');
  const files = createAppFiles(database, log, { uploadsDir, roots: [uploadsDir] });
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
    db: database,
    log,
    outbox,
    files,
    uploadsDir,
    transport,
    port,
    relayCalls,
    async close(): Promise<void> {
      await transport.close();
      database.close();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function request(
  port: number,
  path: string,
  init: { token?: string; method?: string; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const outboxEvents = async (port: number, after = 0): Promise<AppEvent[]> => {
  const res = await request(port, `/app/v1/outbox?after=${after}`, { token: TOKEN });
  const body = (await res.json()) as { events: AppEvent[] };
  return body.events;
};

/**
 * Read the SSE stream until `count` events arrive (or timeout), then abort.
 * Parses like a real client: `id:` field, `data:` JSON, `:` comments ignored.
 */
async function readSse(
  port: number,
  lastEventId: number,
  count: number,
  timeoutMs = 4000,
): Promise<Array<{ sseId: number; envelope: AppEvent }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: Array<{ sseId: number; envelope: AppEvent }> = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/app/v1/events`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(lastEventId) },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (res.body === null) throw new Error('no SSE body');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        let sseId = Number.NaN;
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('id:')) sseId = Number.parseInt(line.slice(3).trim(), 10);
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          // ':' comment keep-alives are ignored, as a client must.
        }
        if (dataLines.length === 0) continue;
        events.push({ sseId, envelope: JSON.parse(dataLines.join('\n')) as AppEvent });
        if (events.length >= count) controller.abort();
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

describe('app transport auth (ADR 0011: 401 precedes 404)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startTransport();
  });
  afterEach(async () => {
    await h.close();
  });

  it('401s without a token on a REAL path', async () => {
    const res = await request(h.port, '/app/v1/health');
    expect(res.status).toBe(401);
    // Invariant 6: the single error shape on every non-2xx.
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('401s without a token on a FAKE path — the surface is not enumerable', async () => {
    const res = await request(h.port, '/app/v1/definitely-not-a-route');
    expect(res.status).toBe(401);
  });

  it('401s a wrong token', async () => {
    const res = await request(h.port, '/app/v1/health', { token: 'not-the-token' });
    expect(res.status).toBe(401);
  });

  it('401s an undeclared-capability route without a token (401 before 404)', async () => {
    const res = await request(h.port, '/app/v1/uploads', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('404s an unknown path only WITH a valid token', async () => {
    const res = await request(h.port, '/app/v1/definitely-not-a-route', { token: TOKEN });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not found' });
  });

  it('declared routes answer with a valid token; MCP rejects per the spec otherwise', async () => {
    // mcp-tools is DECLARED since Stage 27: POST /mcp answers (the SDK's 415
    // here — no JSON content-type on an empty body — not a gating 404).
    const mcp = await request(h.port, '/app/v1/mcp', { token: TOKEN, method: 'POST' });
    expect(mcp.status).toBe(415);
    // Stage 34 (deliberate change from the Stage 27 blanket 405): GET is now
    // the streamable-HTTP SSE stream — but the spec requires the client to
    // list text/event-stream in Accept, so a plain GET (fetch's */*) → 406.
    // The stream itself is exercised in ui-list-changed.test.ts.
    const get = await request(h.port, '/app/v1/mcp', { token: TOKEN });
    expect(get.status).toBe(406);
    // Everything else (DELETE = "terminate session") stays 405.
    const del = await request(h.port, '/app/v1/mcp', { token: TOKEN, method: 'DELETE' });
    expect(del.status).toBe(405);
    // The files routes are DECLARED since Stage 26: they answer (with their
    // own errors here — no multipart body / unknown id), never a gating 404
    // that would make the manifest a lie in the other direction.
    const uploads = await request(h.port, '/app/v1/uploads', { token: TOKEN, method: 'POST' });
    expect(uploads.status).toBe(400);
    const download = await request(h.port, '/app/v1/files/not-a-real-id', { token: TOKEN });
    expect(download.status).toBe(404); // unknown id — the mapping, not gating
  });
});

describe('health + manifest', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startTransport();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves the health shape', async () => {
    const res = await request(h.port, '/app/v1/health', { token: TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; uptimeSec: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.0.0-test');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('declares capabilities EXACTLY ["chat","files","mcp-tools","mcp-apps-ui"] — served for real, nothing unserved', async () => {
    const res = await request(h.port, '/app/v1/manifest', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schema: 1,
      agent: { name: 'nightshift-assistant', version: '0.0.0-test' },
      contract: { name: 'app-ingress', version: 1 },
      capabilities: ['chat', 'files', 'mcp-tools', 'mcp-apps-ui'],
    });
  });
});

describe('POST /app/v1/messages', () => {
  it('400s a malformed body (inbound-message.json) and non-JSON', async () => {
    const h = await startTransport();
    try {
      const malformed = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify({ schema: 1, text: 'missing everything else' }),
      });
      expect(malformed.status).toBe(400);
      const notJson = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: 'not json at all',
      });
      expect(notJson.status).toBe(400);
      expect(h.relayCalls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('403s a foreign personId (invariant 4: vestigial but validated)', async () => {
    const h = await startTransport();
    try {
      const res = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify(wireMsg({ personId: 'not-the-owner' })),
      });
      expect(res.status).toBe(403);
      expect(h.relayCalls).toHaveLength(0);
      expect(await outboxEvents(h.port)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('202s BEFORE relay() — a relay that never resolves cannot hold the request', async () => {
    const h = await startTransport(() => new Promise<AssistantReply>(() => undefined));
    try {
      const msg = wireMsg();
      const res = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify(msg),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, messageId: msg.messageId });
      // Acceptance is durable: the ack row landed even though relay hangs.
      const events = await outboxEvents(h.port);
      expect(events.map((e) => e.type)).toEqual(['ack']);
      expect(events[0]?.payload).toEqual({ messageId: msg.messageId });
    } finally {
      await h.close();
    }
  });

  it('emits ack then a schema-shaped reply; local file paths never leak', async () => {
    const h = await startTransport();
    try {
      const msg = wireMsg();
      await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify(msg),
      });
      let events: AppEvent[] = [];
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !events.some((e) => e.type === 'reply')) {
        events = await outboxEvents(h.port);
        if (!events.some((e) => e.type === 'reply')) await new Promise((r) => setTimeout(r, 25));
      }
      expect(events.map((e) => e.type)).toEqual(['ack', 'reply']);
      // The wire AssistantReply: files carries servable ids ONLY — the
      // relay's local paths are dropped, never exposed to the client.
      expect(events[1]?.payload).toEqual({
        schema: 1,
        text: 'echo: hello from the app',
        files: [],
        sessionId: 'sess-app-1',
        rotated: false,
      });
      // Internal seam got the internal shape (attachments stay empty — no
      // upload ids exist until the files capability lands).
      expect(h.relayCalls[0]?.messageId).toBe(msg.messageId);
      expect(h.relayCalls[0]?.attachments).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('dedups a re-POST in-process: 202 again, relay once, nothing new emitted', async () => {
    const h = await startTransport(() => new Promise<AssistantReply>(() => undefined));
    try {
      const msg = wireMsg();
      const body = JSON.stringify(msg);
      const first = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body,
      });
      expect(first.status).toBe(202);
      const again = await request(h.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body,
      });
      expect(again.status).toBe(202);
      expect(await outboxEvents(h.port)).toHaveLength(1); // the one ack
      await waitFor(() => h.relayCalls.length === 1, 500).catch(() => undefined);
      expect(h.relayCalls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('dedups ACROSS a restart — the ack row, not process memory, is the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightshift-app-'));
    const dbPath = join(dir, 'app.db');
    const msg = wireMsg();
    try {
      // Life 1: accept the message (hanging relay — only the ack row lands).
      const life1 = await startTransport(
        () => new Promise<AssistantReply>(() => undefined),
        openDatabase(dbPath),
      );
      const first = await request(life1.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify(msg),
      });
      expect(first.status).toBe(202);
      await life1.close();

      // Life 2: same DB, fresh process state. The retry must not re-run the turn.
      const life2 = await startTransport(echoRelay, openDatabase(dbPath));
      const retry = await request(life2.port, '/app/v1/messages', {
        token: TOKEN,
        method: 'POST',
        body: JSON.stringify(msg),
      });
      expect(retry.status).toBe(202);
      await new Promise((r) => setTimeout(r, 100));
      expect(life2.relayCalls).toHaveLength(0);
      expect(await outboxEvents(life2.port)).toHaveLength(1); // still just the ack
      await life2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /app/v1/outbox', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startTransport();
  });
  afterEach(async () => {
    await h.close();
  });

  it('400s a non-integer cursor', async () => {
    const res = await request(h.port, '/app/v1/outbox?after=not-a-number', { token: TOKEN });
    expect(res.status).toBe(400);
  });

  it('serves events strictly after the cursor, ascending', async () => {
    h.outbox.append('notice', { schema: 1, text: 'one', files: [] });
    h.outbox.append('notice', { schema: 1, text: 'two', files: [] });
    h.outbox.append('notice', { schema: 1, text: 'three', files: [] });
    const all = await outboxEvents(h.port, 0);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3]);
    const page = await outboxEvents(h.port, 1);
    expect(page.map((e) => e.id)).toEqual([2, 3]);
    expect(await outboxEvents(h.port, 3)).toEqual([]);
    // Page shape (outbox-page.json): { schema: 1, events }.
    const res = await request(h.port, '/app/v1/outbox', { token: TOKEN });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schema).toBe(1);
  });
});

describe('GET /app/v1/events (SSE)', () => {
  it('resumes from Last-Event-ID with exactly the missed rows, then goes live (invariant 2)', async () => {
    const h = await startTransport();
    try {
      h.outbox.append('notice', { schema: 1, text: 'one', files: [] });
      h.outbox.append('notice', { schema: 1, text: 'two', files: [] });
      h.outbox.append('notice', { schema: 1, text: 'three', files: [] });
      // A live append lands while (or shortly after) the stream connects —
      // either way the client must see exactly ids 2,3,4 from cursor 1.
      const liveTimer = setTimeout(() => {
        h.outbox.append('notice', { schema: 1, text: 'four', files: [] });
      }, 150);
      const streamed = await readSse(h.port, 1, 3);
      clearTimeout(liveTimer);
      expect(streamed.map((e) => e.envelope.id)).toEqual([2, 3, 4]);
      // The SSE id: field IS the envelope id — one cursor concept.
      for (const e of streamed) expect(e.sseId).toBe(e.envelope.id);
      // Cursor equivalence: ?after=1 yields the identical sequence.
      const paged = await outboxEvents(h.port, 1);
      expect(paged.map((e) => e.id)).toEqual(streamed.map((e) => e.envelope.id));
    } finally {
      await h.close();
    }
  });
});

describe('containment: a synchronous route failure never escapes the dispatch (PR #67)', () => {
  it('answers 500 with the error shape and keeps serving — the daemon never dies', async () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    const log = makeTestLogger();
    // An outbox whose reads throw synchronously — standing in for any future
    // synchronous defect inside a route handler.
    const broken: AppOutbox = {
      append: () => {
        throw new Error('sync boom');
      },
      after: () => {
        throw new Error('sync boom');
      },
      onAppend: () => () => undefined,
      hasAck: () => false,
    };
    const files = createAppFiles(db, log, {
      uploadsDir: join(tmpdir(), 'nightshift-unused-uploads'),
      roots: [],
    });
    const config = makeConfig({ appTransportEnabled: true, appToken: TOKEN, appPort: 0 });
    const transport = createAppTransport({
      config,
      log,
      outbox: broken,
      files,
      mcp: makeAppMcp(db, log, config),
      uiNotify: createUiNotifyHub(log),
      relay: echoRelay,
      version: '0.0.0-test',
    });
    const port = await transport.listen();
    try {
      const res = await request(port, '/app/v1/outbox', { token: TOKEN });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'internal error' });
      expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('handler failed'))).toBe(
        true,
      );
      // Contained: the same transport still serves the next request.
      const health = await request(port, '/app/v1/health', { token: TOKEN });
      expect(health.status).toBe(200);
    } finally {
      await transport.close();
      db.close();
    }
  });
});

describe('outbox durability (ADR 0010: row committed before any live emit)', () => {
  it('a failing live listener loses nothing — the row is durable and resumable', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    const log = makeTestLogger();
    const outbox = createAppOutbox(db, log);
    const seen: number[] = [];
    outbox.onAppend(() => {
      throw new Error('injected live-emit failure');
    });
    outbox.onAppend((e) => seen.push(e.id));
    const event = outbox.append('reply', { schema: 1, text: 'survives', files: [] });
    // The row survived the throwing listener AND later listeners still ran.
    expect(outbox.after(0).map((e) => e.id)).toEqual([event.id]);
    expect(seen).toEqual([event.id]);
    expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('live emit'))).toBe(true);
    db.close();
  });

  it('hasAck reflects only durable ack rows', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    const outbox = createAppOutbox(db, makeTestLogger());
    expect(outbox.hasAck('msg-a')).toBe(false);
    outbox.append('ack', { messageId: 'msg-a' });
    outbox.append('reply', { schema: 1, text: 'not an ack for msg-b', files: [] });
    expect(outbox.hasAck('msg-a')).toBe(true);
    expect(outbox.hasAck('msg-b')).toBe(false);
    db.close();
  });
});

describe('migrations 0007_app_outbox + 0008_app_files', () => {
  it('applies on a fresh DB (idempotently) with the ADR 0010 schema', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    migrate(db, MIGRATIONS_DIR); // second apply must be a no-op, not a crash
    const cols = db.prepare('PRAGMA table_info(app_outbox)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'type',
      'payload',
      'created_at',
      'delivered_at',
    ]);
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1);
    expect(cols.find((c) => c.name === 'delivered_at')?.notnull).toBe(0); // nullable
    // 0008 (Stage 26): the durable id→path mapping behind /uploads + /files.
    const fileCols = db.prepare('PRAGMA table_info(app_files)').all() as Array<{ name: string }>;
    expect(fileCols.map((c) => c.name)).toEqual(['id', 'path', 'created_at']);
    const head = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(head.v).toBe(10); // ladder head: 0010_ui_state (Stage 37)
    db.close();
  });

  it('applies on a DB standing at 0006 (additive only — nothing else changes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightshift-mig-'));
    try {
      // A migrations dir holding only 0001–0006 simulates the pre-stage DB.
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (/^000[1-6]_/.test(f)) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      }
      const db = openDatabase(':memory:');
      migrate(db, dir);
      const before = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number;
      };
      expect(before.v).toBe(6);
      const tablesBefore = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all();

      migrate(db, MIGRATIONS_DIR);
      const after = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
        v: number;
      };
      expect(after.v).toBe(10);
      const tablesAfter = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      // Exactly the new app-transport tables (0007/0008) plus the Stage 31
      // ui-registry pair (0009) and the Stage 37 ui_state table (0010);
      // every pre-existing one untouched.
      expect(tablesAfter.map((t) => t.name)).toEqual(
        [
          ...(tablesBefore as Array<{ name: string }>).map((t) => t.name),
          'app_outbox',
          'app_files',
          'ui_resources',
          'ui_grants',
          'ui_state',
        ].sort(),
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Probe an ABSENT listener. Plain fetch would hang for the full TCP timeout on
 * hosts where an unbound loopback port swallows SYNs instead of refusing (WSL2
 * with Windows port-proxying does exactly that), so the probe aborts fast:
 * refused OR no answer within the window both mean "nothing is serving".
 */
const expectNothingServing = async (port: number): Promise<void> => {
  await expect(
    fetch(`http://127.0.0.1:${port}/app/v1/health`, { signal: AbortSignal.timeout(750) }),
  ).rejects.toThrow();
};

describe('createApp wiring (dark flag + fail-closed startup)', () => {
  it('flag off → no app transport, nothing serving on the app port', async () => {
    const log = makeTestLogger();
    const app = createApp(makeConfig({ appTransportEnabled: false, appPort: 3781 }), log);
    await app.listen();
    try {
      expect(app.appTransport).toBeNull();
      await expectNothingServing(3781);
    } finally {
      await app.close();
    }
  });

  it('flag on + token unset → app listener refuses (fail closed), daemon healthy', async () => {
    const log = makeTestLogger();
    const app = createApp(
      makeConfig({ appTransportEnabled: true, appToken: '', appPort: 3781 }),
      log,
    );
    const port = await app.listen(); // the DAEMON still starts
    try {
      expect(app.appTransport).toBeNull();
      await expectNothingServing(3781);
      expect(
        log.entries.some(
          (e) => e.level === 'error' && e.msg.includes('app transport refused to start'),
        ),
      ).toBe(true);
      // The main loopback server is alive and serving.
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('flag on + token set → the app listener serves /app/v1/ beside the daemon', async () => {
    const log = makeTestLogger();
    const app = createApp(
      makeConfig({ appTransportEnabled: true, appToken: TOKEN, appPort: 0 }),
      log,
    );
    await app.listen();
    try {
      expect(app.appTransport).not.toBeNull();
      const port = app.appTransport?.port();
      expect(port).not.toBeNull();
      const res = await fetch(`http://127.0.0.1:${port}/app/v1/manifest`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const manifest = (await res.json()) as { capabilities: string[] };
      expect(manifest.capabilities).toEqual(['chat', 'files', 'mcp-tools', 'mcp-apps-ui']);
    } finally {
      await app.close();
    }
  });
});

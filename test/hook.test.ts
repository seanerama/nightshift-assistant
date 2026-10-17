/**
 * Stage 39 hook ingress (contracts/hook-ingress.md v1, ADR 0018): the dark
 * flag (routes absent = the plain 404), 401 before 404/405/400/413 on every
 * /hook/v1 path, fail closed on an unset token, the sync-or-poll reply, the
 * "[via hook: <source>]" tag + owner personId, durable idempotency, body caps
 * and validation, the POST/GET token buckets + pending cap, filesOmitted (no
 * paths), boot reconciliation, retention prune, and the log invariant (never
 * token, text, or reply).
 *
 * Two harnesses: createApp + app.listen() on port 0 with the agent stub (the
 * real loopback server and relay seam), and the handler alone over a tiny
 * node:http server with an injected relay + clock — for the cases the stub
 * cannot produce (reply files, a rejecting relay) and for clock-driven rate
 * limiting (the POST burst is 3, so validation sweeps need refill).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { createHookHandler, HOOK_LOST_TEXT } from '../src/transport/hook.js';
import type { AssistantReply, InboundMessage } from '../src/types.js';
import { MIGRATIONS_DIR, makeConfig, makeTestLogger, type TestLogger, waitFor } from './helpers.js';

const TOKEN = 'test-hook-token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface HookResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
  raw: string;
}

const call = async (
  base: string,
  path: string,
  opts: {
    method?: string;
    token?: string | null;
    body?: unknown;
    rawBody?: string;
    contentType?: string;
    signal?: AbortSignal;
  } = {},
): Promise<HookResponse> => {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/json';
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // non-JSON body — assertions use raw
  }
  return { status: res.status, headers: res.headers, body: parsed, raw };
};

const hookConfig = (overrides: Partial<Config> = {}): Partial<Config> => ({
  hookIngressEnabled: true,
  hookToken: TOKEN,
  ...overrides,
});

// ── Harness 1: the real app (loopback server + session relay + agent stub) ──

describe('hook ingress through createApp (real server, stub agent)', () => {
  let app: App | null;
  let log: TestLogger;
  let base: string;
  let tmpDir: string;
  let agentLog: string;

  const startApp = async (overrides: Partial<Config> = {}): Promise<void> => {
    log = makeTestLogger();
    app = createApp(makeConfig({ dbPath: join(tmpDir, 'test.db'), ...overrides }), log);
    const port = await app.listen();
    base = `http://127.0.0.1:${port}`;
  };

  const agentCalls = (): Array<{ input: string }> =>
    existsSync(agentLog)
      ? readFileSync(agentLog, 'utf8')
          .trim()
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as { input: string })
      : [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-hook-test-'));
    agentLog = join(tmpDir, 'agent.jsonl');
    process.env.AGENT_STUB_LOG = agentLog;
    delete process.env.AGENT_STUB_DELAY_MS;
    app = null;
  });

  afterEach(async () => {
    delete process.env.AGENT_STUB_LOG;
    delete process.env.AGENT_STUB_DELAY_MS;
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flag off ⇒ /hook/v1/* is the plain 404, byte-identical to an unknown path', async () => {
    // Even with a token configured, the flag alone decides presence.
    await startApp({ hookIngressEnabled: false, hookToken: TOKEN });
    const unknown = await call(base, '/definitely-not-a-route', { token: null });
    expect(unknown.status).toBe(404);
    for (const path of ['/hook/v1/messages', '/hook/v1/messages/abc', '/hook/v1', '/hook/v1/x']) {
      const res = await call(base, path, { body: { text: 'hi' } });
      expect(res.status).toBe(404);
      expect(res.raw).toBe(unknown.raw);
      expect(res.headers.get('content-type')).toBe(unknown.headers.get('content-type'));
    }
    expect(agentCalls()).toHaveLength(0);
  });

  it('flag on, missing/wrong token ⇒ 401 on every path and method (401 precedes 404/405/400/413)', async () => {
    await startApp(hookConfig());
    const cases: Array<{ path: string; method?: string; body?: unknown; rawBody?: string }> = [
      { path: '/hook/v1/messages', body: { text: 'hi' } },
      { path: '/hook/v1/messages', rawBody: '{not json' }, // would be 400
      { path: '/hook/v1/messages', rawBody: 'x'.repeat(20 * 1024) }, // would be 413
      { path: '/hook/v1/messages', method: 'GET' }, // would be 405
      { path: '/hook/v1/messages/some-id' }, // would be 404
      { path: '/hook/v1/messages/some-id', method: 'DELETE' }, // would be 405
      { path: '/hook/v1/x' }, // would be 404
      { path: '/hook/v1' },
    ];
    for (const token of [null, 'wrong-token', `${TOKEN}x`, '']) {
      for (const c of cases) {
        const res = await call(base, c.path, { ...c, token });
        expect(res.status, `${c.method ?? 'auto'} ${c.path} token=${token}`).toBe(401);
        expect(res.body).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    expect(agentCalls()).toHaveLength(0);
    // The unchanged doors are untouched by the new prefix.
    expect((await call(base, '/health', { token: null })).status).toBe(200);
  });

  it('flag on + token unset ⇒ 401 everywhere, one startup error, daemon healthy', async () => {
    await startApp({ hookIngressEnabled: true, hookToken: '' });
    const startupErrors = log.entries.filter(
      (e) => e.level === 'error' && e.msg.includes('NIGHTSHIFT_HOOK_TOKEN'),
    );
    expect(startupErrors).toHaveLength(1);
    for (const token of [null, '', 'anything']) {
      for (const path of ['/hook/v1/messages', '/hook/v1/messages/x', '/hook/v1/nope']) {
        const res = await call(base, path, { token, body: { text: 'hi' } });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false, error: 'unauthorized' });
      }
    }
    expect((await call(base, '/health', { token: null })).status).toBe(200);
    expect(agentCalls()).toHaveLength(0);
  });

  it('happy path: 200 completed with the reply; tagged text reaches the agent', async () => {
    await startApp(hookConfig());
    const res = await call(base, '/hook/v1/messages', { body: { text: 'hello there' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('completed');
    expect(String(res.body.messageId)).toMatch(UUID_RE); // server-generated key, no prefix
    expect(res.body.reply).toEqual({
      text: 'pong: [via hook: hook]\nhello there',
      rotated: false,
      filesOmitted: 0,
    });
    const calls = agentCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('[via hook: hook]\nhello there');

    // A caller label replaces the default tag.
    const labeled = await call(base, '/hook/v1/messages', {
      body: { text: 'from my phone', source: 'shortcuts.v2' },
    });
    expect(labeled.status).toBe(200);
    expect((labeled.body.reply as { text: string }).text).toBe(
      'pong: [via hook: shortcuts.v2]\nfrom my phone',
    );
    // An invalid label never reaches the agent.
    const bad = await call(base, '/hook/v1/messages', {
      body: { text: 'x', source: 'Bad Source' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    expect(agentCalls()).toHaveLength(2);

    // The durable row matches the wire.
    const row = app?.db
      .prepare('SELECT * FROM hook_messages WHERE message_id = ?')
      .get(String(res.body.messageId)) as { status: string; source: string; completed_at: string };
    expect(row.status).toBe('completed');
    expect(row.source).toBe('hook');
    expect(row.completed_at).not.toBeNull();
  });

  it('slow turn + wait:1 ⇒ 202 pending + poll path; the poll later reads completed', async () => {
    process.env.AGENT_STUB_DELAY_MS = '2000';
    await startApp(hookConfig());
    const t0 = Date.now();
    const res = await call(base, '/hook/v1/messages', {
      body: { text: 'take your time', messageId: 'slow-1', wait: 1 },
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      status: 'pending',
      messageId: 'slow-1',
      poll: '/hook/v1/messages/slow-1',
    });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1900);

    const pending = await call(base, '/hook/v1/messages/slow-1');
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');

    let polled: HookResponse | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      polled = await call(base, '/hook/v1/messages/slow-1');
      if (polled.body.status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(polled?.status).toBe(200);
    expect(polled?.body).toEqual({
      ok: true,
      status: 'completed',
      messageId: 'slow-1',
      reply: { text: 'pong: [via hook: hook]\ntake your time', rotated: false, filesOmitted: 0 },
    });
    // Unknown id (after auth) ⇒ 404.
    const unknown = await call(base, '/hook/v1/messages/never-submitted');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: 'not found' });
  });

  it('wait:0 ⇒ immediate 202 even for a fast turn', async () => {
    process.env.AGENT_STUB_DELAY_MS = '600';
    await startApp(hookConfig());
    const t0 = Date.now();
    const res = await call(base, '/hook/v1/messages', { body: { text: 'later', wait: 0 } });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    expect(res.body.poll).toBe(`/hook/v1/messages/${String(res.body.messageId)}`);
    await waitFor(() => agentCalls().length === 1);
  });

  it('idempotency: the same messageId twice ⇒ one relay call, the same result', async () => {
    await startApp(hookConfig());
    const body = { text: 'only once', messageId: 'caller-key:42' };
    const first = await call(base, '/hook/v1/messages', { body });
    const second = await call(base, '/hook/v1/messages', { body: { ...body, text: 'different' } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body.messageId).toBe('caller-key:42');
    expect(agentCalls()).toHaveLength(1);
  });

  it('boot reconciliation: a pre-seeded pending row becomes failed with the "lost" text', async () => {
    const dbPath = join(tmpDir, 'test.db');
    const seed = openDatabase(dbPath);
    migrate(seed, MIGRATIONS_DIR);
    seed
      .prepare(
        "INSERT INTO hook_messages (message_id, source, status, created_at) VALUES ('orphan', 'cron', 'pending', ?)",
      )
      .run(new Date().toISOString());
    seed.close();

    await startApp(hookConfig());
    const res = await call(base, '/hook/v1/messages/orphan');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: 'failed',
      messageId: 'orphan',
      reply: { text: HOOK_LOST_TEXT, rotated: false, filesOmitted: 0 },
    });
    expect(HOOK_LOST_TEXT).toBe('lost: the daemon restarted before this turn finished');
    // A re-POST of a failed id starts no new turn either.
    const again = await call(base, '/hook/v1/messages', {
      body: { text: 'x', messageId: 'orphan' },
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('failed');
    expect(agentCalls()).toHaveLength(0);
  });

  it('logs never carry the token, the turn text, or the reply text', async () => {
    await startApp(hookConfig());
    const secretText = 'zebra-correct-horse-battery';
    await call(base, '/hook/v1/messages', {
      token: 'wrong-zebra-token',
      body: { text: secretText },
    });
    const ok = await call(base, '/hook/v1/messages', {
      body: { text: secretText, source: 'audit' },
    });
    expect(ok.status).toBe(200);
    await call(base, `/hook/v1/messages/${String(ok.body.messageId)}`);
    await call(base, '/hook/v1/messages', { body: { text: '' } }); // 400
    await waitFor(() => log.entries.some((e) => e.msg === 'hook turn settled'));

    const dump = JSON.stringify(log.entries);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('wrong-zebra-token');
    expect(dump).not.toContain(secretText);
    expect(dump).not.toContain('pong:');
    // ...but the operational fields are there.
    const settled = log.entries.find((e) => e.msg === 'hook turn settled');
    expect(settled?.fields).toMatchObject({ messageId: ok.body.messageId, source: 'audit' });
    expect(typeof settled?.fields.latencyMs).toBe('number');
    expect(log.entries.some((e) => e.fields.code === 401)).toBe(true);
  });
});

// ── Harness 2: the handler alone (injected relay + clock) ───────────────────

interface Direct {
  base: string;
  db: Database.Database;
  log: TestLogger;
  relayCalls: InboundMessage[];
  /** Advance the injected clock (refills the token buckets). */
  advance(ms: number): void;
  close(): Promise<void>;
}

const reply = (text: string, files: string[] = []): AssistantReply => ({
  schema: 1,
  text,
  files,
  sessionId: 'sess-hook',
  rotated: false,
});

async function startDirect(
  relay: (msg: InboundMessage) => Promise<AssistantReply> = async (m) => reply(`echo ${m.text}`),
  overrides: Partial<Config> = {},
): Promise<Direct> {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  const log = makeTestLogger();
  let t = Date.parse('2026-10-16T12:00:00.000Z');
  const relayCalls: InboundMessage[] = [];
  const handler = createHookHandler({
    config: makeConfig(hookConfig(overrides)),
    log,
    db,
    relay: (msg) => {
      relayCalls.push(msg);
      return relay(msg);
    },
    now: () => new Date(t),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    log,
    relayCalls,
    advance: (ms) => {
      t += ms;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

describe('hook handler (direct: injected relay + clock)', () => {
  let h: Direct | null = null;

  afterEach(async () => {
    if (h !== null) await h.close();
    h = null;
  });

  it('builds the InboundMessage per contract (hook: id, owner personId, tag, no attachments)', async () => {
    h = await startDirect();
    const res = await call(h.base, '/hook/v1/messages', {
      body: { text: 'hi', messageId: 'k1', source: 'n8n' },
    });
    expect(res.status).toBe(200);
    expect(h.relayCalls).toHaveLength(1);
    const msg = h.relayCalls[0];
    expect(msg?.schema).toBe(1);
    expect(msg?.messageId).toBe('hook:k1');
    expect(msg?.personId).toBe('owner-person-id');
    expect(msg?.text).toBe('[via hook: n8n]\nhi');
    expect(msg?.attachments).toEqual([]);
    expect(Number.isNaN(Date.parse(msg?.receivedAt ?? ''))).toBe(false);
  });

  it('reply files ⇒ filesOmitted count; no local path ever appears in the body', async () => {
    h = await startDirect(async () =>
      reply('here you go', ['/home/owner/projects/secret/report.pdf', '/tmp/other.png']),
    );
    const res = await call(h.base, '/hook/v1/messages', {
      body: { text: 'files?', messageId: 'f1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.reply).toEqual({ text: 'here you go', rotated: false, filesOmitted: 2 });
    expect(res.raw).not.toContain('/home/owner');
    expect(res.raw).not.toContain('report.pdf');
    const polled = await call(h.base, '/hook/v1/messages/f1');
    expect(polled.raw).not.toContain('report.pdf');
    expect((polled.body.reply as { filesOmitted: number }).filesOmitted).toBe(2);
  });

  it('a rejecting relay (defensive) ⇒ 200 status:"failed"', async () => {
    h = await startDirect(async () => {
      throw new Error('boom with private detail');
    });
    const res = await call(h.base, '/hook/v1/messages', { body: { text: 'x', messageId: 'r1' } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.raw).not.toContain('private detail');
    expect(JSON.stringify(h.log.entries)).not.toContain('private detail');
  });

  it('413 over 16 KiB; 400 on bad JSON / content-type / text / source / messageId / wait', async () => {
    const hd = await startDirect();
    h = hd;
    const post = async (opts: Parameters<typeof call>[2]): Promise<HookResponse> => {
      hd.advance(60_000); // refill the POST bucket between probes
      return call(hd.base, '/hook/v1/messages', opts);
    };
    const big = await post({ body: { text: 'a'.repeat(7000), pad: 'b'.repeat(10 * 1024) } });
    expect(big.status).toBe(413);
    expect(big.body.ok).toBe(false);

    const cases: Array<[string, Parameters<typeof call>[2]]> = [
      ['bad JSON', { rawBody: '{"text": ' }],
      ['non-object JSON', { rawBody: '["text"]' }],
      ['null JSON', { rawBody: 'null' }],
      ['wrong content-type', { body: { text: 'hi' }, contentType: 'text/plain' }],
      ['missing text', { body: { source: 'x' } }],
      ['empty text', { body: { text: '' } }],
      ['non-string text', { body: { text: 42 } }],
      ['text > 8000', { body: { text: 'a'.repeat(8001) } }],
      ['source uppercase', { body: { text: 'hi', source: 'Hook' } }],
      ['source too long', { body: { text: 'hi', source: `a${'b'.repeat(32)}` } }],
      ['messageId bad char', { body: { text: 'hi', messageId: 'a/b' } }],
      ['messageId too long', { body: { text: 'hi', messageId: 'a'.repeat(129) } }],
      ['messageId empty', { body: { text: 'hi', messageId: '' } }],
      ['wait negative', { body: { text: 'hi', wait: -1 } }],
      ['wait fractional', { body: { text: 'hi', wait: 1.5 } }],
      ['wait over max', { body: { text: 'hi', wait: 56 } }],
      ['wait string', { body: { text: 'hi', wait: '5' } }],
    ];
    for (const [name, opts] of cases) {
      const res = await post(opts);
      expect(res.status, name).toBe(400);
      expect(res.body.ok, name).toBe(false);
      expect(typeof res.body.error, name).toBe('string');
    }
    expect(hd.relayCalls).toHaveLength(0);

    // Boundaries accepted: exactly 8000 chars, max-length ids, wait at max.
    const edge = await post({
      body: {
        text: 'a'.repeat(8000),
        source: `a${'b'.repeat(31)}`,
        messageId: 'Z'.repeat(128),
        wait: 55,
      },
    });
    expect(edge.status).toBe(200);

    // Authenticated method / route errors.
    hd.advance(60_000);
    const getOnPost = await call(hd.base, '/hook/v1/messages');
    expect(getOnPost.status).toBe(405);
    expect(getOnPost.headers.get('allow')).toBe('POST');
    const postOnGet = await call(hd.base, '/hook/v1/messages/x', { body: { text: 'hi' } });
    expect(postOnGet.status).toBe(405);
    expect(postOnGet.headers.get('allow')).toBe('GET');
    const unknown = await call(hd.base, '/hook/v1/elsewhere');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ ok: false, error: 'not found' });
  });

  it('POST burst exceeded ⇒ 429 + Retry-After; unauthenticated requests consume nothing', async () => {
    const hd = await startDirect();
    h = hd;
    // A flood of unauthenticated requests first — all 401, none billed.
    for (let i = 0; i < 10; i++) {
      const res = await call(hd.base, '/hook/v1/messages', { token: null, body: { text: 'x' } });
      expect(res.status).toBe(401);
    }
    for (let i = 0; i < 3; i++) {
      const res = await call(hd.base, '/hook/v1/messages', { body: { text: `ok ${i}` } });
      expect(res.status).toBe(200);
    }
    const limited = await call(hd.base, '/hook/v1/messages', { body: { text: 'one too many' } });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ ok: false, error: 'rate limited' });
    expect(limited.headers.get('retry-after')).toBe('10'); // 6/min ⇒ one token per 10s
    expect(hd.relayCalls).toHaveLength(3);

    // Polls have their own bucket: still available after the POST burst.
    expect((await call(hd.base, '/hook/v1/messages/nope')).status).toBe(404);

    // Refill: 10s later exactly one more POST is admitted.
    hd.advance(10_000);
    expect((await call(hd.base, '/hook/v1/messages', { body: { text: 'refilled' } })).status).toBe(
      200,
    );
    expect((await call(hd.base, '/hook/v1/messages', { body: { text: 'again' } })).status).toBe(
      429,
    );
  });

  it('GET poll bucket: burst exhausted ⇒ 429 + Retry-After', async () => {
    const hd = await startDirect();
    h = hd;
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await call(hd.base, '/hook/v1/messages/x')).status);
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(codes[10]).toBe(429);
    const again = await call(hd.base, '/hook/v1/messages/x');
    expect(again.headers.get('retry-after')).toBe('1'); // 60/min ⇒ one per second
  });

  it('pending cap ⇒ 429 for a NEW turn; re-POST of a pending id still answers its state', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hd = await startDirect(
      async () => {
        await gate;
        return reply('done');
      },
      { hookMaxPending: 1 },
    );
    h = hd;
    const first = await call(hd.base, '/hook/v1/messages', {
      body: { text: 'hold', messageId: 'p1', wait: 0 },
    });
    expect(first.status).toBe(202);
    const capped = await call(hd.base, '/hook/v1/messages', {
      body: { text: 'second', messageId: 'p2', wait: 0 },
    });
    expect(capped.status).toBe(429);
    expect(capped.body).toEqual({ ok: false, error: 'too many pending hook turns' });
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
    hd.advance(60_000);
    const rePost = await call(hd.base, '/hook/v1/messages', {
      body: { text: 'hold', messageId: 'p1', wait: 0 },
    });
    expect(rePost.status).toBe(202);
    expect(hd.relayCalls).toHaveLength(1);

    release?.();
    await waitFor(
      () =>
        (
          hd.db.prepare("SELECT status FROM hook_messages WHERE message_id = 'p1'").get() as {
            status: string;
          }
        ).status === 'completed',
    );
    // Cap freed ⇒ a new turn is admitted again.
    const after = await call(hd.base, '/hook/v1/messages', {
      body: { text: 'next', messageId: 'p3' },
    });
    expect(after.status).toBe(200);
  });

  it('a client disconnect mid-wait cancels nothing: the turn completes and is pollable', async () => {
    const hd = await startDirect(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return reply('finished anyway');
    });
    h = hd;
    await expect(
      call(hd.base, '/hook/v1/messages', {
        body: { text: 'bye', messageId: 'gone-1', wait: 10 },
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
    await waitFor(() => {
      const row = hd.db
        .prepare("SELECT status FROM hook_messages WHERE message_id = 'gone-1'")
        .get() as { status: string } | undefined;
      return row?.status === 'completed';
    });
    const polled = await call(hd.base, '/hook/v1/messages/gone-1');
    expect((polled.body.reply as { text: string }).text).toBe('finished anyway');
  });

  it('retention: completed/failed rows past HOOK_RETENTION_DAYS are pruned on insert; pending never', async () => {
    const hd = await startDirect();
    h = hd;
    const old = new Date(
      Date.parse('2026-10-16T12:00:00.000Z') - 8 * 24 * 3600 * 1000,
    ).toISOString();
    const recent = new Date(
      Date.parse('2026-10-16T12:00:00.000Z') - 1 * 24 * 3600 * 1000,
    ).toISOString();
    const insert = hd.db.prepare(
      'INSERT INTO hook_messages (message_id, source, status, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('old-done', 'hook', 'completed', old);
    insert.run('old-failed', 'hook', 'failed', old);
    insert.run('old-pending', 'hook', 'pending', old);
    insert.run('recent-done', 'hook', 'completed', recent);
    const res = await call(hd.base, '/hook/v1/messages', {
      body: { text: 'new', messageId: 'n1' },
    });
    expect(res.status).toBe(200);
    const ids = (
      hd.db.prepare('SELECT message_id FROM hook_messages ORDER BY message_id').all() as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id);
    expect(ids).toEqual(['n1', 'old-pending', 'recent-done']);
  });

  it('a percent-encoded poll id resolves to the same row', async () => {
    h = await startDirect();
    await call(h.base, '/hook/v1/messages', { body: { text: 'x', messageId: 'a:b' } });
    const res = await call(h.base, '/hook/v1/messages/a%3Ab');
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('a:b');
    expect((await call(h.base, '/hook/v1/messages/%E0%A4%A')).status).toBe(404);
  });
});

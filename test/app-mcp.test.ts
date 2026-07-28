/**
 * Stage 27 app MCP endpoint (contracts/app-ingress.md, ADR 0012): POST
 * /app/v1/mcp behind the app bearer gate (401 first), stateless streamable
 * HTTP via the official SDK, and EXACTLY five tools — each a thin door over
 * the same App.jobs/App.sessions internals the control API uses. Requests
 * here are deliberately harness-shaped (accept: application/json only, no
 * session header, initialize without clientInfo) — what the pinned
 * agent-app-conformance run certifies is what these tests drive. The parity
 * guard submits the SAME typed payload through the MCP tool and the control
 * API handler and asserts one JobRecord shape comes back (drift = bug, ADR
 * 0012).
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { InboundMessage } from '../src/types.js';
import { makeConfig, makeTestLogger, WORKER_STUB, waitFor } from './helpers.js';

const APP_TOKEN = 'test-app-mcp-token';
const API_TOKEN = 'test-api-token';

/** The certified five, in advertised order — status FIRST (no-arg, read-only).
 * Stage 37 made the catalog flag-conditional: this const is the EXACT flag-off
 * catalog (byte-identical to the certified surface), and the flag-on catalog
 * appends STATE_TOOLS — both pinned below (a deliberate Stage 37 pin update:
 * "exactly five" became "exactly five per flag state"). */
const FIVE_TOOLS = ['status', 'jobs_list', 'jobs_submit', 'jobs_kill', 'session_rotate'];

/** Stage 37 (contracts/ui-state.md): appended AFTER the five, flag on only. */
const STATE_TOOLS = ['ui_state_get', 'ui_state_set'];

/** contracts/job-lifecycle.md — the exact JobRecord keys (no more, no fewer). */
const JOB_RECORD_KEYS = [
  'attempts',
  'createdAt',
  'endedAt',
  'id',
  'logPath',
  'pid',
  'retryOf',
  'schema',
  'sentinelPath',
  'sessionId',
  'startedAt',
  'status',
  'title',
  'type',
  'workdir',
];

/** contracts/assistant-session.md — the exact RotationRecord keys. */
const ROTATION_RECORD_KEYS = [
  'closedSessionId',
  'newSessionId',
  'reason',
  'rotatedAt',
  'schema',
  'summaryPath',
  'transcriptPath',
];

const inbound = (text: string): InboundMessage => ({
  schema: 1,
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  personId: 'owner-person-id',
  text,
  attachments: [],
  receivedAt: new Date().toISOString(),
});

interface RpcResponse {
  status: number;
  body: {
    result?: {
      protocolVersion?: string;
      tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
}

describe('app MCP endpoint (/app/v1/mcp, Stage 27)', () => {
  let tmpDir: string;
  let workdir: string;
  let app: App | null;
  let apiBase: string;
  let appBase: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        jobsEnabled: true,
        jobKillGraceSec: 1,
        controlEnabled: true,
        apiToken: API_TOKEN,
        appTransportEnabled: true,
        appToken: APP_TOKEN,
        appPort: 0,
        ...overrides,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const apiPort = await a.listen();
    apiBase = `http://127.0.0.1:${apiPort}`;
    appBase = `http://127.0.0.1:${a.appTransport?.port()}`;
    app = a;
    return a;
  };

  /** Harness-shaped JSON-RPC POST: accept json ONLY, no MCP session headers. */
  const rpc = async (
    method: string,
    params?: unknown,
    opts: { token?: string | null } = {},
  ): Promise<RpcResponse> => {
    const token = opts.token === undefined ? APP_TOKEN : opts.token;
    const res = await fetch(`${appBase}/app/v1/mcp`, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    return { status: res.status, body: (await res.json()) as RpcResponse['body'] };
  };

  /** tools/call → the parsed JSON body a tool door answers with. */
  const toolCall = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = await rpc('tools/call', { name, arguments: args });
    expect(res.status).toBe(200);
    const content = res.body.result?.content;
    expect(Array.isArray(content)).toBe(true);
    const text = content?.[0]?.text;
    expect(typeof text).toBe('string');
    return {
      isError: res.body.result?.isError === true,
      body: JSON.parse(text as string) as Record<string, unknown>,
    };
  };

  const apiCall = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const rawSubmit = (instruction: string): Record<string, unknown> => ({
    schema: 1,
    type: 'test',
    title: 'mcp job',
    instruction,
    workdir,
    env: 'minimal',
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-mcp-'));
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir);
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('auth (401 precedes everything)', () => {
    it('401s without / with a wrong token, using the app error shape', async () => {
      await makeApp();
      const none = await fetch(`${appBase}/app/v1/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(none.status).toBe(401);
      expect(await none.json()).toEqual({ ok: false, error: 'unauthorized' });
      const wrong = await rpc('tools/list', undefined, { token: 'not-the-token' });
      expect(wrong.status).toBe(401);
    });

    it('serves with the token: harness-shaped initialize (no clientInfo) completes', async () => {
      await makeApp();
      const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      expect(res.status).toBe(200);
      expect(typeof res.body.result?.protocolVersion).toBe('string');
    });
  });

  describe('tools/list (Stage 37: a function of the generative-ui flag)', () => {
    it('flag OFF (default): EXACTLY the certified five, status first, each with a schema', async () => {
      await makeApp();
      const res = await rpc('tools/list');
      expect(res.status).toBe(200);
      const tools = res.body.result?.tools ?? [];
      // The certified surface, byte-identical: exact names, exact order —
      // and NO ui-state tools anywhere in the list.
      expect(tools.map((t) => t.name)).toEqual(FIVE_TOOLS);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
      }
    });

    it('flag ON: the five + ui_state_get/ui_state_set appended — status still first', async () => {
      await makeApp({ generativeUiEnabled: true });
      const res = await rpc('tools/list');
      expect(res.status).toBe(200);
      const tools = res.body.result?.tools ?? [];
      expect(tools.map((t) => t.name)).toEqual([...FIVE_TOOLS, ...STATE_TOOLS]);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
      }
    });

    it('flag OFF: the five entries are IDENTICAL to what flag ON advertises for them', async () => {
      // Byte-identity guard: turning the flag on must only APPEND — the
      // certified five entries themselves may not change in any way.
      await makeApp();
      const off = (await rpc('tools/list')).body.result?.tools ?? [];
      await app?.close();
      app = null;
      await makeApp({ generativeUiEnabled: true });
      const on = (await rpc('tools/list')).body.result?.tools ?? [];
      expect(JSON.stringify(on.slice(0, FIVE_TOOLS.length))).toBe(JSON.stringify(off));
    });
  });

  describe('round-trip against the real internals', () => {
    it('jobs_submit → jobs_list shows it → jobs_kill → killed (frozen JobRecord throughout)', async () => {
      const a = await makeApp();
      const submitted = await toolCall('jobs_submit', rawSubmit('MODE=sleep SLEEP_MS=60000'));
      expect(submitted.isError).toBe(false);
      expect(submitted.body.ok).toBe(true);
      const job = submitted.body.job as Record<string, unknown>;
      // The frozen shape, exactly: no added fields, no renames (ADR 0012).
      expect(Object.keys(job).sort()).toEqual(JOB_RECORD_KEYS);
      const id = job.id as string;

      const listed = await toolCall('jobs_list');
      expect((listed.body.jobs as Array<{ id: string }>).map((j) => j.id)).toContain(id);

      const killed = await toolCall('jobs_kill', { id });
      expect(killed.isError).toBe(false);
      const killedJob = killed.body.job as Record<string, unknown>;
      expect(killedJob.status).toBe('killed');
      expect(Object.keys(killedJob).sort()).toEqual(JOB_RECORD_KEYS);
      expect(a.jobs.get(id)?.status).toBe('killed');

      const filtered = await toolCall('jobs_list', { status: 'killed' });
      expect((filtered.body.jobs as Array<{ id: string }>).map((j) => j.id)).toContain(id);

      // The control API sees the identical record — one truth, two doors.
      const viaApi = (await (await apiCall('GET', `/api/v1/jobs/${id}`)).json()) as {
        job: Record<string, unknown>;
      };
      expect(viaApi.job).toEqual(a.jobs.get(id));
    });

    it('session_rotate returns the frozen RotationRecord and really rotates', async () => {
      const a = await makeApp();
      await a.sessions.relay(inbound('hello')); // materialize a session to rotate
      const before = a.sessions.info().id;

      const rotated = await toolCall('session_rotate', { reason: 'manual' });
      expect(rotated.isError).toBe(false);
      expect(rotated.body.ok).toBe(true);
      const rotation = rotated.body.rotation as Record<string, unknown>;
      expect(Object.keys(rotation).sort()).toEqual(ROTATION_RECORD_KEYS);
      expect(rotation.reason).toBe('manual');
      expect(rotation.closedSessionId).toBe(before);
      expect(rotation.newSessionId).not.toBe(before);

      // Empty arguments work too (rotate takes no required fields).
      const again = await toolCall('session_rotate');
      expect(again.isError).toBe(false);
    });

    it('status mirrors the control API status — same fields, same values', async () => {
      const a = await makeApp();
      await a.sessions.relay(inbound('hello'));
      const submitted = await toolCall('jobs_submit', rawSubmit('MODE=success'));
      const id = (submitted.body.job as { id: string }).id;
      await waitFor(() => a.jobs.get(id)?.status === 'succeeded');

      const viaMcp = (await toolCall('status')).body;
      const viaApi = (await (await apiCall('GET', '/api/v1/status')).json()) as Record<
        string,
        unknown
      >;
      // Identical field set; identical values except uptimeSec (two clocks,
      // both counting the same daemon life).
      expect(Object.keys(viaMcp).sort()).toEqual(Object.keys(viaApi).sort());
      const { uptimeSec: mcpUptime, ...mcpRest } = viaMcp;
      const { uptimeSec: apiUptime, ...apiRest } = viaApi;
      expect(mcpRest).toEqual(apiRest);
      expect(mcpUptime).toBeGreaterThanOrEqual(0);
      expect(apiUptime).toBeGreaterThanOrEqual(0);
      expect(viaMcp.jobs).toEqual({ queued: 0, running: 0, succeeded: 1, failed: 0, killed: 0 });
      expect((viaMcp.session as { id: string }).id).toBe('sess-canned-1');
    });
  });

  describe('parity guard (ADR 0012: drift = bug by definition)', () => {
    it('the SAME typed { type, params } payload lands identically through both doors', async () => {
      const a = await makeApp({ typesEnabled: true });
      const payload = { type: 'story', params: { idea: 'MODE=success bedtime turtles' } };

      const viaApiRes = await apiCall('POST', '/api/v1/jobs', payload);
      expect(viaApiRes.status).toBe(200);
      const viaApi = ((await viaApiRes.json()) as { job: Record<string, unknown> }).job;

      const viaMcp = (await toolCall('jobs_submit', payload)).body.job as Record<string, unknown>;

      // One shape (the frozen JobRecord) and one rendering: same keys, same
      // registry-derived type/title/workdir — only per-job identity differs.
      expect(Object.keys(viaMcp).sort()).toEqual(JOB_RECORD_KEYS);
      expect(Object.keys(viaMcp).sort()).toEqual(Object.keys(viaApi).sort());
      expect(viaMcp.type).toBe(viaApi.type);
      expect(viaMcp.title).toBe(viaApi.title);
      expect(viaMcp.workdir).toBe(viaApi.workdir);

      await waitFor(() => a.jobs.get(viaApi.id as string)?.status === 'succeeded');
      await waitFor(() => a.jobs.get(viaMcp.id as string)?.status === 'succeeded');
    });

    it('rejects the same bad inputs with the same messages the control API 400s with', async () => {
      await makeApp();

      const badEnv = await toolCall('jobs_submit', { ...rawSubmit('MODE=success'), env: 'full' });
      expect(badEnv.isError).toBe(true);
      expect(badEnv.body.error).toContain('env must be exactly');

      const untyped = await toolCall('jobs_submit', { params: { idea: 'x' } });
      expect(untyped.isError).toBe(true);
      expect(untyped.body.error).toContain('typed submit requires "type"');

      const unknownJob = await toolCall('jobs_kill', { id: 'no-such-id' });
      expect(unknownJob.isError).toBe(true);
      expect(unknownJob.body.error).toContain('no such job');

      const badFilter = await toolCall('jobs_list', { status: 'exploded' });
      expect(badFilter.isError).toBe(true);
      expect(badFilter.body.error).toContain('invalid status filter');

      const badReason = await toolCall('session_rotate', { reason: 'daily' });
      expect(badReason.isError).toBe(true);
      expect(badReason.body.error).toContain('invalid rotation reason');
    });

    it('jobs disabled → jobs_submit carries the control API JobError message', async () => {
      await makeApp({ jobsEnabled: false });
      const res = await toolCall('jobs_submit', rawSubmit('MODE=success'));
      expect(res.isError).toBe(true);
      expect(res.body.error).toContain('job runner is disabled');
    });
  });

  describe('protocol edges', () => {
    it('an unknown tool is a JSON-RPC error, not a tool result', async () => {
      await makeApp();
      const res = await rpc('tools/call', { name: 'jobs_promote', arguments: {} });
      expect(res.status).toBe(200);
      expect(res.body.result).toBeUndefined();
      expect(res.body.error?.code).toBe(-32602);
      expect(res.body.error?.message).toContain('unknown tool');
    });

    it('non-JSON body → the SDK answers a JSON-RPC parse error, contained', async () => {
      await makeApp();
      const res = await fetch(`${appBase}/app/v1/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${APP_TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32700);
      // Contained: the endpoint still serves.
      const list = await rpc('tools/list');
      expect(list.status).toBe(200);
    });
  });
});

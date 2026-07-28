/**
 * Stage 37 ui-state store (contracts/ui-state.md frozen v1, ADR 0016): the
 * per-resource-name JSON document behind ui_state_get/ui_state_set, the
 * /api/v1/ui/state/<name> control doors, and `nightshift ui state`. Module
 * semantics against an in-memory migrated DB (round-trip, null-before-first-
 * set, full replace, 404/422 discipline, the ADR 0015 version-independence
 * symmetry); the MCP tool doors + flag-conditional catalog against a real app
 * (flag off = the certified five, tool names unknown); door/tool shared truth
 * (one table, two faces); the grant-flow integration (the grantable universe
 * now includes the two names); and the CLI verbs against a scratch daemon.
 * The "exactly five" catalog pins live in test/app-mcp.test.ts (updated
 * deliberately this stage).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { createUiRegistry, type UiRegistry, UiRegistryError } from '../src/ui/registry.js';
import { createUiState, UI_STATE_MAX_BYTES, type UiState } from '../src/ui/state.js';
import { MIGRATIONS_DIR, makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/nightshift', import.meta.url));
const APP_TOKEN = 'test-app-ui-state-token';
const API_TOKEN = 'test-api-token';

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);

const caught = (fn: () => unknown): UiRegistryError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UiRegistryError);
    return err as UiRegistryError;
  }
  throw new Error('expected a UiRegistryError');
};

// ── module semantics (in-memory migrated DB) ────────────────────────────────

describe('ui-state module (src/ui/state.ts, contracts/ui-state.md)', () => {
  let db: Database.Database;
  let registry: UiRegistry;
  let state: UiState;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    registry = createUiRegistry(db);
    state = createUiState(db);
    registry.install({ name: 'page', html: GOOD_HTML, requestedTools: ['ui_state_get'] });
  });

  afterEach(() => {
    db.close();
  });

  it('null/null before the first set — a registered name with no document', () => {
    expect(state.get('page')).toEqual({ name: 'page', value: null, updatedAt: null });
  });

  it('set→get round-trips objects, arrays, and scalars (updatedAt ISO)', () => {
    const cases: unknown[] = [
      { habits: ['water', 'stretch'], checks: { '2026-07-28': [true, false] } },
      ['a', 1, null, { nested: true }],
      42,
      'plain string',
      true,
      null, // a deliberately-set null is a real document (updatedAt non-null)
    ];
    for (const value of cases) {
      const set = state.set('page', value);
      expect(set.name).toBe('page');
      expect(new Date(set.updatedAt).toISOString()).toBe(set.updatedAt);
      const got = state.get('page');
      expect(got.value, JSON.stringify(value)).toEqual(value);
      expect(got.updatedAt).toBe(set.updatedAt);
    }
  });

  it('set is a FULL replace — no merge, last-write-wins', () => {
    state.set('page', { a: 1, b: 2 });
    state.set('page', { b: 3 });
    expect(state.get('page').value).toEqual({ b: 3 }); // `a` gone — replaced, not merged
  });

  it('unknown resource name → 404-class on BOTH get and set (registry is the namespace authority)', () => {
    expect(caught(() => state.get('no-such-page')).status).toBe(404);
    expect(caught(() => state.set('no-such-page', { x: 1 })).status).toBe(404);
    // `jobs` is reserved, never registrable — as unknown as any other name.
    expect(caught(() => state.get('jobs')).status).toBe(404);
    // Nothing was written for the refused names.
    expect((db.prepare('SELECT COUNT(*) AS n FROM ui_state').get() as { n: number }).n).toBe(0);
  });

  it('serialized cap: exactly 65536 bytes fits, one more byte → 422; prior state untouched', () => {
    // JSON.stringify adds two quote bytes around a string scalar.
    const exactlyAtCap = 'x'.repeat(UI_STATE_MAX_BYTES - 2);
    expect(state.set('page', exactlyAtCap).updatedAt).toEqual(expect.any(String));

    const oneOver = 'x'.repeat(UI_STATE_MAX_BYTES - 1);
    const err = caught(() => state.set('page', oneOver));
    expect(err.status).toBe(422);
    expect(err.message).toContain('too large');
    expect(state.get('page').value).toBe(exactlyAtCap); // the refused write changed nothing
  });

  it('non-JSON-serializable values → 422, nothing written', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [circular, 9n, undefined, Symbol('nope'), () => 0]) {
      const err = caught(() => state.set('page', value));
      expect(err.status).toBe(422);
      expect(err.message).toContain('not JSON-serializable');
    }
    expect(state.get('page')).toEqual({ name: 'page', value: null, updatedAt: null });
  });

  it('state attaches to the NAME (ADR 0015 symmetry): install-v2 and activate-v1 never touch it', () => {
    const set = state.set('page', { streak: 7 });
    // Iteration: v2 of the same name — state unchanged.
    registry.install({ name: 'page', html: GOOD_HTML, requestedTools: ['ui_state_set'] });
    expect(state.get('page')).toEqual({
      name: 'page',
      value: { streak: 7 },
      updatedAt: set.updatedAt,
    });
    // Rollback: re-activate v1 — state STILL unchanged.
    expect(registry.activate('page', 1)).not.toBeNull();
    expect(state.get('page')).toEqual({
      name: 'page',
      value: { streak: 7 },
      updatedAt: set.updatedAt,
    });
  });
});

// ── doors + MCP + grants against a real app ─────────────────────────────────

interface RpcResponse {
  status: number;
  body: {
    result?: {
      tools?: Array<{ name: string }>;
      resources?: Array<{ uri: string; _meta?: Record<string, unknown> }>;
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
}

describe('ui-state doors, MCP tools, and grants (Stage 37)', () => {
  let tmpDir: string;
  let app: App | null;
  let apiBase: string;
  let appBase: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        jobsEnabled: true,
        controlEnabled: true,
        apiToken: API_TOKEN,
        appTransportEnabled: true,
        appToken: APP_TOKEN,
        appPort: 0,
        generativeUiEnabled: true,
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

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Harness-shaped JSON-RPC POST: accept json ONLY, no MCP session headers. */
  const rpc = async (method: string, params?: unknown): Promise<RpcResponse> => {
    const res = await fetch(`${appBase}/app/v1/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${APP_TOKEN}`,
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
    const text = res.body.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    return {
      isError: res.body.result?.isError === true,
      body: JSON.parse(text as string) as Record<string, unknown>,
    };
  };

  const install = async (name: string, requestedTools: string[] = []): Promise<void> => {
    const res = await call('POST', '/api/v1/ui/resources', {
      name,
      html: GOOD_HTML,
      requestedTools,
      provenance: 'ui-state test',
    });
    expect(res.status).toBe(200);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-state-'));
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('control doors (GET/POST /api/v1/ui/state/<name>)', () => {
    it('GET before any set → { ok, name, value: null, updatedAt: null }', async () => {
      await makeApp();
      await install('tracker');
      const res = await call('GET', '/api/v1/ui/state/tracker');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        name: 'tracker',
        value: null,
        updatedAt: null,
      });
    });

    it('POST { value } → { ok, name, updatedAt }; GET round-trips; a second POST replaces', async () => {
      await makeApp();
      await install('tracker');
      const value = { habits: ['water'], checks: {} };
      const set = await call('POST', '/api/v1/ui/state/tracker', { value });
      expect(set.status).toBe(200);
      const setBody = (await set.json()) as { ok: boolean; name: string; updatedAt: string };
      expect(setBody.ok).toBe(true);
      expect(setBody.name).toBe('tracker');
      expect(new Date(setBody.updatedAt).toISOString()).toBe(setBody.updatedAt);

      const got = await call('GET', '/api/v1/ui/state/tracker');
      expect(await got.json()).toEqual({
        ok: true,
        name: 'tracker',
        value,
        updatedAt: setBody.updatedAt,
      });

      // Full replace — the first document is entirely gone.
      expect((await call('POST', '/api/v1/ui/state/tracker', { value: [1, 2] })).status).toBe(200);
      const replaced = (await (await call('GET', '/api/v1/ui/state/tracker')).json()) as {
        value: unknown;
      };
      expect(replaced.value).toEqual([1, 2]);
    });

    it('unknown resource name → 404 on GET and POST', async () => {
      await makeApp();
      const got = await call('GET', '/api/v1/ui/state/no-such-page');
      expect(got.status).toBe(404);
      expect(((await got.json()) as { error: string }).error).toContain('no-such-page');
      const set = await call('POST', '/api/v1/ui/state/no-such-page', { value: 1 });
      expect(set.status).toBe(404);
    });

    it('body discipline → 400: missing value key, non-object body, malformed JSON', async () => {
      await makeApp();
      await install('tracker');
      for (const body of [{}, { val: 1 }, [1, 2], 'str', 7, null]) {
        const res = await call('POST', '/api/v1/ui/state/tracker', body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain('requires body');
      }
      const raw = await fetch(`${apiBase}/api/v1/ui/state/tracker`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(raw.status).toBe(400);
      // Nothing landed through any of it.
      const got = (await (await call('GET', '/api/v1/ui/state/tracker')).json()) as {
        updatedAt: unknown;
      };
      expect(got.updatedAt).toBeNull();
    });

    it('oversize serialized value → 422 through the door', async () => {
      await makeApp();
      await install('tracker');
      const res = await call('POST', '/api/v1/ui/state/tracker', {
        value: 'x'.repeat(UI_STATE_MAX_BYTES),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toContain('too large');
    });

    it('flag off → 404 with the rest of the family; wrong method → 404', async () => {
      await makeApp({ generativeUiEnabled: false });
      for (const [method, body] of [
        ['GET', undefined],
        ['POST', { value: 1 }],
      ] as const) {
        const res = await call(method, '/api/v1/ui/state/tracker', body);
        expect(res.status, method).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: 'not found' });
      }
      await app?.close();
      app = null;
      await makeApp();
      await install('tracker');
      expect((await call('DELETE', '/api/v1/ui/state/tracker')).status).toBe(404);
    });

    it('route interplay regression: /resources/<name> show + activate still work beside /state/<name>', async () => {
      await makeApp();
      await install('tracker');
      await install('tracker'); // v2
      expect((await call('POST', '/api/v1/ui/state/tracker', { value: { v: 1 } })).status).toBe(
        200,
      );

      const show = await call('GET', '/api/v1/ui/resources/tracker');
      expect(show.status).toBe(200);
      const shown = (await show.json()) as { active: number; versions: unknown[] };
      expect(shown.active).toBe(2);
      expect(shown.versions).toHaveLength(2);

      const one = await call('GET', '/api/v1/ui/resources/tracker/1');
      expect(one.status).toBe(200);

      const act = await call('POST', '/api/v1/ui/resources/tracker/activate', { version: 1 });
      expect(act.status).toBe(200);

      // And the state doors were untouched by the resource verbs.
      const got = (await (await call('GET', '/api/v1/ui/state/tracker')).json()) as {
        value: unknown;
      };
      expect(got.value).toEqual({ v: 1 });
    });
  });

  describe('MCP tools (flag ON): thin doors over the same truth', () => {
    it('ui_state_set → ui_state_get round-trip via tools/call (contract shapes exactly)', async () => {
      await makeApp();
      await install('tracker');

      const before = await toolCall('ui_state_get', { name: 'tracker' });
      expect(before.isError).toBe(false);
      expect(before.body).toEqual({ ok: true, name: 'tracker', value: null, updatedAt: null });

      const value = { habits: ['water', 'stretch'], streak: 3 };
      const set = await toolCall('ui_state_set', { name: 'tracker', value });
      expect(set.isError).toBe(false);
      expect(Object.keys(set.body).sort()).toEqual(['name', 'ok', 'updatedAt']);
      expect(set.body.name).toBe('tracker');

      const after = await toolCall('ui_state_get', { name: 'tracker' });
      expect(after.body).toEqual({
        ok: true,
        name: 'tracker',
        value,
        updatedAt: set.body.updatedAt,
      });
    });

    it('shared truth: door-written state is tool-visible and tool-written state is door-visible', async () => {
      await makeApp();
      await install('tracker');

      // Door writes → tool reads.
      expect(
        (await call('POST', '/api/v1/ui/state/tracker', { value: { seeded: true } })).status,
      ).toBe(200);
      expect((await toolCall('ui_state_get', { name: 'tracker' })).body.value).toEqual({
        seeded: true,
      });

      // Tool writes → door reads (full replace again).
      const set = await toolCall('ui_state_set', { name: 'tracker', value: { fromPage: 1 } });
      expect(set.isError).toBe(false);
      const viaDoor = (await (await call('GET', '/api/v1/ui/state/tracker')).json()) as {
        value: unknown;
      };
      expect(viaDoor.value).toEqual({ fromPage: 1 });
    });

    it('isError discipline: unknown name, oversize, missing args — never a protocol error', async () => {
      await makeApp();
      await install('tracker');

      const unknownGet = await toolCall('ui_state_get', { name: 'no-such-page' });
      expect(unknownGet.isError).toBe(true);
      expect(unknownGet.body.error).toContain('no-such-page');

      const unknownSet = await toolCall('ui_state_set', { name: 'no-such-page', value: 1 });
      expect(unknownSet.isError).toBe(true);

      const oversize = await toolCall('ui_state_set', {
        name: 'tracker',
        value: 'x'.repeat(UI_STATE_MAX_BYTES),
      });
      expect(oversize.isError).toBe(true);
      expect(oversize.body.error).toContain('too large');

      const noName = await toolCall('ui_state_get');
      expect(noName.isError).toBe(true);
      expect(noName.body.error).toContain('requires "name"');

      const noValue = await toolCall('ui_state_set', { name: 'tracker' });
      expect(noValue.isError).toBe(true);
      expect(noValue.body.error).toContain('requires "value"');

      // The endpoint still serves afterwards (contained, like every isError).
      expect((await toolCall('ui_state_get', { name: 'tracker' })).isError).toBe(false);
    });
  });

  describe('MCP flag OFF: the tools are ABSENT, not disabled', () => {
    it('tools/call on ui_state_get/ui_state_set → JSON-RPC -32602 unknown tool', async () => {
      await makeApp({ generativeUiEnabled: false });
      for (const name of ['ui_state_get', 'ui_state_set']) {
        const res = await rpc('tools/call', { name, arguments: { name: 'x', value: 1 } });
        expect(res.status).toBe(200);
        expect(res.body.result).toBeUndefined();
        expect(res.body.error?.code).toBe(-32602);
        expect(res.body.error?.message).toContain('unknown tool');
      }
    });
  });

  describe('grant-flow integration (the generative-ui flow, unchanged)', () => {
    it('a page may REQUEST the state tools (no 422); _meta [] → grant both → both, in requested order', async () => {
      await makeApp();
      // Before Stage 37 this install 422'd ("unknown requested tool") — the
      // grantable universe now includes the two state-tool names.
      await install('tracker', ['ui_state_get', 'ui_state_set']);
      const uri = 'ui://nightshift/tracker@v1';

      const listedTools = async (): Promise<unknown> => {
        const res = await rpc('resources/list');
        return (res.body.result?.resources ?? []).find((r) => r.uri === uri)?._meta?.['ui/tools'];
      };

      expect(await listedTools()).toEqual([]); // zero-trust start

      for (const tool of ['ui_state_set', 'ui_state_get']) {
        const res = await call('POST', '/api/v1/ui/grants', {
          name: 'tracker',
          tool,
          approvalText: `yes — ${tool} (whole-namespace trust, per the contract caveat)`,
        });
        expect(res.status, tool).toBe(200);
      }
      // Order follows requestedTools (the intersection filter), not grant order.
      expect(await listedTools()).toEqual(['ui_state_get', 'ui_state_set']);
    });
  });
});

// ── CLI (`nightshift ui state`) against a scratch daemon ────────────────────

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
}

describe('nightshift ui state (CLI, Stage 37)', () => {
  let tmpDir: string;
  let app: App;
  let cliEnv: Record<string, string>;

  const cli = (args: string[]): Promise<CliResult> => runCli(args, cliEnv);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-state-cli-'));
    app = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: API_TOKEN,
        generativeUiEnabled: true,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const port = await app.listen();
    cliEnv = {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_API_TOKEN: API_TOKEN,
      NIGHTSHIFT_PORT: String(port),
    };
    // A registered name for the state to attach to (the CLI seeding path).
    const fixture = fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url));
    const installed = await cli(['ui', 'install', fixture, '--name', 'tracker']);
    expect(installed.code).toBe(0);
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('get before any set: exit 0, never-set rendering; --json carries the null/null body', async () => {
    const res = await cli(['ui', 'state', 'tracker']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('name:      tracker');
    expect(res.stdout).toContain('never set');

    const raw = await cli(['ui', 'state', 'tracker', '--json']);
    expect(raw.code).toBe(0);
    expect(JSON.parse(raw.stdout)).toEqual({
      ok: true,
      name: 'tracker',
      value: null,
      updatedAt: null,
    });
  });

  it('--set replaces the document; get and --json read it back (the seeding round-trip)', async () => {
    const set = await cli(['ui', 'state', 'tracker', '--set', '{"habits":["water","stretch"]}']);
    expect(set.stderr).toBe('');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('State set.');
    expect(set.stdout).toContain('name:      tracker');

    const got = await cli(['ui', 'state', 'tracker']);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain('{"habits":["water","stretch"]}');

    const raw = await cli(['ui', 'state', 'tracker', '--json']);
    const body = JSON.parse(raw.stdout) as { ok: boolean; value: unknown; updatedAt: string };
    expect(body.ok).toBe(true);
    expect(body.value).toEqual({ habits: ['water', 'stretch'] });
    expect(body.updatedAt).toEqual(expect.any(String));

    // Full replace via the CLI too — scalars are legal documents.
    expect((await cli(['ui', 'state', 'tracker', '--set', '42'])).code).toBe(0);
    const replaced = JSON.parse((await cli(['ui', 'state', 'tracker', '--json'])).stdout) as {
      value: unknown;
    };
    expect(replaced.value).toBe(42);
  });

  it('--set with invalid JSON fails LOCALLY (exit 1, nothing sent); unknown name relays the 404 error', async () => {
    const bad = await cli(['ui', 'state', 'tracker', '--set', '{not json']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--set is not valid JSON');
    // Nothing reached the daemon — the document is still unset.
    const got = await cli(['ui', 'state', 'tracker', '--json']);
    expect((JSON.parse(got.stdout) as { updatedAt: unknown }).updatedAt).toBeNull();

    const unknown = await cli(['ui', 'state', 'no-such-page']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no registered resource');

    const noName = await cli(['ui', 'state']);
    expect(noName.code).toBe(1);
    expect(noName.stderr).toContain('ui state requires a name');
  });

  it('USAGE documents both forms', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('ui state <name>');
    expect(help.stdout).toContain("ui state <name> --set '<json>'");
  });
});

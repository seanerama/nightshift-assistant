/**
 * Stage 31 MCP mapping (contracts/generative-ui.md over contracts/
 * app-ingress.md): flag-on daemon against a scratch DB — install the good
 * fixture through the control door, then over POST /app/v1/mcp assert
 * resources/list carries ui://nightshift/<name>@v1 beside the hand-authored
 * jobs entry with _meta["ui/tools"]: [] (zero-trust — no grants exist this
 * stage) and resources/read returns the EXACT installed HTML. Flag off:
 * the resource surface is byte-identical to Stage 28 — the jobs entry only,
 * and registered-shaped uris stay unknown. Harness-shaped requests (accept:
 * application/json only, no session headers), matching test/app-mcp.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const APP_TOKEN = 'test-app-ui-mcp-token';
const API_TOKEN = 'test-api-token';

const JOBS_URI = 'ui://nightshift/jobs@v1';
const GOOD_NAME = 'good-fixture';
const GOOD_URI = `ui://nightshift/${GOOD_NAME}@v1`;

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);

interface ResourceDescriptor {
  uri: string;
  name?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

interface RpcResponse {
  status: number;
  body: {
    result?: {
      tools?: Array<{ name: string }>;
      resources?: ResourceDescriptor[];
      contents?: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        _meta?: Record<string, unknown>;
      }>;
    };
    error?: { code: number; message: string };
  };
}

describe('generative-ui MCP mapping (/app/v1/mcp, Stage 31)', () => {
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

  /** Install the good fixture through the control door (what `nightshift ui install` calls). */
  const installGood = async (): Promise<void> => {
    const res = await fetch(`${apiBase}/api/v1/ui/resources`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: GOOD_NAME,
        html: GOOD_HTML,
        requestedTools: ['jobs_list'],
        provenance: 'ui-mcp test',
      }),
    });
    expect(res.status).toBe(200);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-mcp-'));
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('flag on', () => {
    it('resources/list = jobs@v1 + the installed row with _meta["ui/tools"]: []', async () => {
      await makeApp();
      await installGood();
      const res = await rpc('resources/list');
      expect(res.status).toBe(200);
      const resources = res.body.result?.resources ?? [];
      expect(resources.map((r) => r.uri)).toEqual([JOBS_URI, GOOD_URI]);

      const installed = resources.find((r) => r.uri === GOOD_URI);
      expect(installed?.name).toBe(GOOD_NAME);
      expect(installed?.mimeType).toBe('text/html');
      // Zero-trust: requestedTools were declared but NOTHING is granted —
      // the descriptor allowlist is an empty array (present, not absent).
      expect(installed?._meta?.['ui/tools']).toEqual([]);

      // The hand-authored jobs entry is untouched beside it.
      const jobs = resources.find((r) => r.uri === JOBS_URI);
      expect(jobs?._meta?.['ui/tools']).toEqual(['jobs_list', 'jobs_kill', 'jobs_submit']);
    });

    it('resources/read returns the EXACT installed HTML with the empty allowlist', async () => {
      await makeApp();
      await installGood();
      const res = await rpc('resources/read', { uri: GOOD_URI });
      expect(res.status).toBe(200);
      const contents = res.body.result?.contents ?? [];
      expect(contents).toHaveLength(1);
      expect(contents[0]?.uri).toBe(GOOD_URI);
      expect(contents[0]?.mimeType).toBe('text/html');
      expect(contents[0]?.text).toBe(GOOD_HTML); // byte-identical round trip
      expect(contents[0]?._meta?.['ui/tools']).toEqual([]);
    });

    it('an unregistered @vN uri is still a JSON-RPC error', async () => {
      await makeApp();
      await installGood();
      const res = await rpc('resources/read', { uri: `ui://nightshift/${GOOD_NAME}@v2` });
      expect(res.status).toBe(200);
      expect(res.body.result).toBeUndefined();
      expect(res.body.error?.code).toBe(-32602);
      expect(res.body.error?.message).toContain('unknown resource');
    });

    it('the tools surface (flag on): the five Stage 27 doors + the two Stage 37 state tools', async () => {
      // Stage 37 pin update (deliberate): this file runs flag ON, where the
      // catalog is now five + two (flag OFF stays exactly five — pinned in
      // test/app-mcp.test.ts). Installing pages still never moves it.
      await makeApp();
      await installGood();
      const res = await rpc('tools/list');
      expect((res.body.result?.tools ?? []).map((t) => t.name)).toEqual([
        'status',
        'jobs_list',
        'jobs_submit',
        'jobs_kill',
        'session_rotate',
        'ui_state_get',
        'ui_state_set',
      ]);
    });
  });

  describe('flag off — byte-identical to Stage 28', () => {
    it('resources/list carries ONLY the hand-authored jobs entry', async () => {
      await makeApp({ generativeUiEnabled: false });
      const res = await rpc('resources/list');
      expect(res.status).toBe(200);
      const resources = res.body.result?.resources ?? [];
      expect(resources.map((r) => r.uri)).toEqual([JOBS_URI]);
      expect(resources[0]?._meta?.['ui/tools']).toEqual(['jobs_list', 'jobs_kill', 'jobs_submit']);
    });

    it('a registered-shaped uri reads as unknown (the registry is dark)', async () => {
      await makeApp({ generativeUiEnabled: false });
      const res = await rpc('resources/read', { uri: GOOD_URI });
      expect(res.body.error?.code).toBe(-32602);
      expect(res.body.error?.message).toContain('unknown resource');
    });
  });
});

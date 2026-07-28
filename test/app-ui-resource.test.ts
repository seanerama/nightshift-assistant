/**
 * Stage 28 UI resource (contracts/app-ingress.md, ADR 0012): the MCP server
 * behind POST /app/v1/mcp additionally serves ONE resource —
 * ui://nightshift/jobs@v1, a single-file HTML jobs dashboard whose resource
 * descriptor carries _meta["ui/tools"] = ["jobs_list", "jobs_kill",
 * "jobs_submit"], the allowlist the client shell derives per
 * nightshift-client/contracts/ui-bridge.md (the convention lives in the
 * CLIENT repo; the file header records that provenance).
 *
 * Two halves:
 *  - STATIC conformance on the HTML file itself. These are deliberately crude
 *    greps — honest, cheap tripwires for the ui-bridge hard constraints (no
 *    network, no storage, no external references, provenance header). The
 *    BEHAVIORAL proof is MCP Inspector + the client shell (docs/smoke/
 *    stage-28.md), not these regexes.
 *  - MCP integration through the real transport, harness-shaped requests
 *    (accept: application/json only, no session headers), matching
 *    test/app-mcp.test.ts conventions: resources/list, resources/read, the
 *    tools surface unchanged, and the bearer gate in front of it all.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import { makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const APP_TOKEN = 'test-app-ui-token';

const UI_RESOURCE_URI = 'ui://nightshift/jobs@v1';

/** EXACTLY these three, exact names — the client-side allowlist (ADR 0012). */
const UI_TOOLS = ['jobs_list', 'jobs_kill', 'jobs_submit'];

/** Stage 27's frozen five, in advertised order — must be untouched by Stage 28. */
const FIVE_TOOLS = ['status', 'jobs_list', 'jobs_submit', 'jobs_kill', 'session_rotate'];

const HTML_PATH = fileURLToPath(
  new URL('../src/transport/app/resources/jobs-v1.html', import.meta.url),
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

describe('app UI resource (ui://nightshift/jobs@v1, Stage 28)', () => {
  describe('static conformance on the HTML file (crude greps — see module header)', () => {
    const html = readFileSync(HTML_PATH, 'utf8');

    it('opens with a header comment citing the CLIENT-repo ui-bridge contract', () => {
      // Provenance is a stage requirement: the _meta["ui/tools"] convention
      // lives in nightshift-client, not in this repo or the contract repo.
      expect(html.startsWith('<!--')).toBe(true);
      const header = html.slice(0, html.indexOf('-->'));
      expect(header).toContain('nightshift-client/contracts/ui-bridge.md');
      expect(header).toContain('ui/tools');
    });

    it('has no network escape hatches (ui-bridge: postMessage is the ONLY channel)', () => {
      expect(html).not.toMatch(/fetch\s*\(/i);
      expect(html).not.toMatch(/XMLHttpRequest/i);
      expect(html).not.toMatch(/WebSocket/i);
      expect(html).not.toMatch(/EventSource/i);
      expect(html).not.toMatch(/navigator\.sendBeacon/i);
    });

    it('has no storage (no localStorage/sessionStorage/indexedDB/cookies)', () => {
      expect(html).not.toMatch(/localStorage/i);
      expect(html).not.toMatch(/sessionStorage/i);
      expect(html).not.toMatch(/indexedDB/i);
      expect(html).not.toMatch(/document\.cookie/i);
    });

    it('is one self-contained file: no external src=/href=, no CSS imports/urls', () => {
      // Nothing in this file references anything outside it — not even data:
      // URIs are needed; the dashboard is text, CSS, and inline script only.
      expect(html).not.toMatch(/\bsrc\s*=/i);
      expect(html).not.toMatch(/\bhref\s*=/i);
      expect(html).not.toMatch(/@import/i);
      expect(html).not.toMatch(/\burl\s*\(/i);
    });

    it('speaks the ui-bridge and degrades without it', () => {
      // The outbound channel and the standalone "tools unavailable" state.
      expect(html).toContain('window.ReactNativeWebView.postMessage');
      expect(html).toContain('tools/call');
      expect(html).toContain('ui/ready');
      expect(html).toContain('Tools unavailable');
      // The dashboard drives exactly the declared tools.
      for (const tool of UI_TOOLS) expect(html).toContain(`'${tool}'`);
      // The frozen JobRecord statuses appear as filter options.
      for (const s of ['queued', 'running', 'succeeded', 'failed', 'killed']) {
        expect(html).toContain(`<option value="${s}">`);
      }
    });
  });

  describe('MCP integration (through the real app transport)', () => {
    let tmpDir: string;
    let app: App | null;
    let appBase: string;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-'));
      app = createApp(
        makeConfig({
          agentBin: WORKER_STUB,
          jobsEnabled: true,
          appTransportEnabled: true,
          appToken: APP_TOKEN,
          appPort: 0,
        }),
        makeTestLogger(),
        { appDir: tmpDir, home: tmpDir },
      );
      await app.listen();
      appBase = `http://127.0.0.1:${app.appTransport?.port()}`;
    });

    afterEach(async () => {
      if (app !== null) await app.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

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

    it('resources/list advertises the uri with _meta["ui/tools"] ON THE DESCRIPTOR', async () => {
      const res = await rpc('resources/list');
      expect(res.status).toBe(200);
      const resources = res.body.result?.resources ?? [];
      // Exactly one resource in v1 — more resources are a later stage.
      expect(resources.map((r) => r.uri)).toEqual([UI_RESOURCE_URI]);
      const [ui] = resources;
      expect(ui?.mimeType).toBe('text/html');
      // The location the client shell reads (nightshift-client
      // src/ui-bridge/allowlist.ts): the DESCRIPTOR's _meta, key "ui/tools",
      // exactly the three names. Anywhere else = empty allowlist, fail closed.
      expect(ui?._meta?.['ui/tools']).toEqual(UI_TOOLS);
    });

    it('resources/read returns the on-disk HTML as text/html with _meta intact', async () => {
      const res = await rpc('resources/read', { uri: UI_RESOURCE_URI });
      expect(res.status).toBe(200);
      const contents = res.body.result?.contents ?? [];
      expect(contents).toHaveLength(1);
      const [body] = contents;
      expect(body?.uri).toBe(UI_RESOURCE_URI);
      expect(body?.mimeType).toBe('text/html');
      // Served VERBATIM — byte-identical to the repo file the static half vets.
      expect(body?.text).toBe(readFileSync(HTML_PATH, 'utf8'));
      expect(body?._meta?.['ui/tools']).toEqual(UI_TOOLS);
    });

    it('resources/read on an unknown uri is a JSON-RPC error, not empty contents', async () => {
      const res = await rpc('resources/read', { uri: 'ui://nightshift/jobs@v2' });
      expect(res.status).toBe(200);
      expect(res.body.result).toBeUndefined();
      expect(res.body.error?.code).toBe(-32602);
      expect(res.body.error?.message).toContain('unknown resource');
    });

    it('tools/list still advertises EXACTLY the five Stage 27 doors, unchanged', async () => {
      const res = await rpc('tools/list');
      expect(res.status).toBe(200);
      expect((res.body.result?.tools ?? []).map((t) => t.name)).toEqual(FIVE_TOOLS);
    });

    it('the bearer gate is in front of the resource surface (401, app error shape)', async () => {
      // Inherited from the app transport dispatch (401 precedes 404) — proven,
      // not assumed: no token and a wrong token both refuse resources/*.
      const none = await fetch(`${appBase}/app/v1/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }),
      });
      expect(none.status).toBe(401);
      expect(await none.json()).toEqual({ ok: false, error: 'unauthorized' });

      const wrong = await rpc('resources/read', { uri: UI_RESOURCE_URI }, { token: 'nope' });
      expect(wrong.status).toBe(401);
    });
  });
});

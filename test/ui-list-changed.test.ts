/**
 * Stage 34 list_changed (contracts/generative-ui.md §MCP, ADR 0015): GET
 * /app/v1/mcp is the streamable-HTTP spec's optional SSE stream for
 * server-initiated messages, and every registry mutation through the control
 * doors — register (install), activate, grant, revoke — broadcasts exactly
 * one notifications/resources/list_changed frame to EVERY open stream.
 * Best-effort by spec: zero listeners is normal (mutations unchanged), a
 * vanished client is pruned and never fails the next mutation, and a FAILED
 * mutation emits nothing. The gate order is the app transport's own: 401
 * precedes everything; wrong/missing Accept → 406 (the SDK transport's
 * rejection for the identical case); the stream exists whenever the app
 * transport is up, regardless of the generative-ui flag (it is part of the
 * MCP transport — with the flag off there is simply nothing that can
 * mutate). The certified POST path is exercised byte-identically by
 * app-mcp.test.ts / app-transport.test.ts and the CI conformance job.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeConfig, makeTestLogger, WORKER_STUB, waitFor } from './helpers.js';

const APP_TOKEN = 'test-app-list-changed-token';
const API_TOKEN = 'test-api-token';

/** The one notification the hub carries — valid JSON-RPC, no id (a notification). */
const LIST_CHANGED = {
  jsonrpc: '2.0',
  method: 'notifications/resources/list_changed',
};

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);

/** One open GET /app/v1/mcp stream: parsed data frames + teardown handles. */
interface Stream {
  /** JSON-parsed `data:` payloads, in arrival order (comments ignored). */
  frames: unknown[];
  status: number;
  contentType: string | null;
  /** Abort the fetch — from the daemon's side the client just vanishes. */
  destroy(): void;
}

describe('generative-ui list_changed (Stage 34, GET /app/v1/mcp)', () => {
  let tmpDir: string;
  let app: App | null;
  let apiBase: string;
  let appBase: string;
  const openStreams: Stream[] = [];

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

  /** Control-door call (loopback server) — the mutations ride this door. */
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /**
   * Open an authenticated GET stream and collect its frames in the
   * background, parsing like a real SSE client: `data:` lines are the
   * payload, `:` comment keep-alives are ignored.
   */
  const openStream = async (
    init: { token?: string | null; accept?: string } = {},
  ): Promise<Stream> => {
    const token = init.token === undefined ? APP_TOKEN : init.token;
    const controller = new AbortController();
    const res = await fetch(`${appBase}/app/v1/mcp`, {
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        accept: init.accept ?? 'text/event-stream',
      },
      signal: controller.signal,
    });
    const stream: Stream = {
      frames: [],
      status: res.status,
      contentType: res.headers.get('content-type'),
      destroy: () => controller.abort(),
    };
    if (res.status === 200 && res.body !== null) {
      const body = res.body;
      void (async (): Promise<void> => {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for await (const chunk of body) {
            buffer += decoder.decode(chunk as Uint8Array, { stream: true });
            let split = buffer.indexOf('\n\n');
            while (split !== -1) {
              const frame = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              split = buffer.indexOf('\n\n');
              const dataLines = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim());
              if (dataLines.length > 0) stream.frames.push(JSON.parse(dataLines.join('\n')));
            }
          }
        } catch {
          // AbortError / connection drop — teardown, not a test failure.
        }
      })();
    }
    openStreams.push(stream);
    return stream;
  };

  const install = async (name: string, html = GOOD_HTML): Promise<Response> =>
    call('POST', '/api/v1/ui/resources', {
      name,
      html,
      requestedTools: ['jobs_list'],
      provenance: 'list-changed test',
    });

  /** Let any in-flight (over-)broadcast land before asserting exact counts. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-lc-'));
    app = null;
  });

  afterEach(async () => {
    for (const s of openStreams.splice(0)) s.destroy();
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('gates (the app transport posture, unchanged)', () => {
    it('401s a GET without a bearer — before anything else', async () => {
      await makeApp();
      const res = await fetch(`${appBase}/app/v1/mcp`, {
        headers: { accept: 'text/event-stream' },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('406s a GET whose Accept does not list text/event-stream (MCP spec)', async () => {
      await makeApp();
      const res = await fetch(`${appBase}/app/v1/mcp`, {
        headers: { authorization: `Bearer ${APP_TOKEN}`, accept: 'application/json' },
      });
      expect(res.status).toBe(406);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('text/event-stream');
    });

    it('APP_TRANSPORT_ENABLED off → the whole transport (stream included) is absent', async () => {
      const a = await makeApp({ appTransportEnabled: false });
      expect(a.appTransport).toBeNull();
    });

    it('the stream opens with the generative-ui flag OFF — it is part of the MCP transport', async () => {
      await makeApp({ generativeUiEnabled: false });
      const stream = await openStream();
      expect(stream.status).toBe(200);
      expect(stream.contentType).toContain('text/event-stream');
    });
  });

  describe('broadcast on the four mutations', () => {
    it('emits EXACTLY one valid JSON-RPC frame per mutation, to EVERY open stream', async () => {
      await makeApp();
      const one = await openStream();
      const two = await openStream();
      expect(one.status).toBe(200);
      expect(two.status).toBe(200);

      // The four mutation doors (contracts/generative-ui.md §MCP): register
      // (twice — a fresh name and its next version), activate (rollback),
      // grant, revoke. Five committed mutations → five frames.
      expect((await install('lc-page')).status).toBe(200);
      expect((await install('lc-page')).status).toBe(200); // v2 (register again)
      expect(
        (await call('POST', '/api/v1/ui/resources/lc-page/activate', { version: 1 })).status,
      ).toBe(200);
      expect(
        (
          await call('POST', '/api/v1/ui/grants', {
            name: 'lc-page',
            tool: 'jobs_list',
            approvalText: 'owner said yes',
          })
        ).status,
      ).toBe(200);
      expect(
        (await call('POST', '/api/v1/ui/grants/revoke', { name: 'lc-page', tool: 'jobs_list' }))
          .status,
      ).toBe(200);

      await waitFor(() => one.frames.length >= 5 && two.frames.length >= 5);
      await settle(); // exactly five — no double-emit per mutation
      for (const stream of [one, two]) {
        expect(stream.frames).toHaveLength(5);
        for (const frame of stream.frames) expect(frame).toEqual(LIST_CHANGED);
      }
    });

    it('a FAILED mutation emits nothing (broadcast is after commit only)', async () => {
      await makeApp();
      const stream = await openStream();
      expect(stream.status).toBe(200);
      // Invalid HTML → 422, nothing written, nothing broadcast.
      const rejected = await install('lc-bad', '<div>not a valid ui page</div>');
      expect(rejected.status).toBe(422);
      // Unknown version → 404 on activate, nothing broadcast.
      const missing = await call('POST', '/api/v1/ui/resources/lc-bad/activate', { version: 7 });
      expect(missing.status).toBe(404);
      await settle();
      expect(stream.frames).toHaveLength(0);
    });

    it('zero listeners: mutations succeed unchanged with no open stream', async () => {
      await makeApp();
      const res = await install('lc-quiet');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; resource: { version: number } };
      expect(body.ok).toBe(true);
      expect(body.resource.version).toBe(1);
    });

    it('a client that vanishes mid-stream is pruned; the next mutation does not throw', async () => {
      await makeApp();
      const doomed = await openStream();
      const survivor = await openStream();
      expect(doomed.status).toBe(200);
      expect(survivor.status).toBe(200);

      doomed.destroy(); // hard client abort — the daemon just sees the socket close
      await settle();

      // The very next mutation must succeed (write-after-end guarded)…
      expect((await install('lc-prune')).status).toBe(200);
      // …and the surviving stream still receives its frame.
      await waitFor(() => survivor.frames.length >= 1);
      expect(survivor.frames[0]).toEqual(LIST_CHANGED);
      // A second mutation keeps flowing — the daemon is unharmed.
      expect((await install('lc-prune')).status).toBe(200);
      await waitFor(() => survivor.frames.length >= 2);
      await settle();
      expect(survivor.frames).toHaveLength(2);
      expect(doomed.frames).toHaveLength(0);
    });
  });
});

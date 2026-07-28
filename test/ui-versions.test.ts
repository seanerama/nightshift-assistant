/**
 * Stage 32 round trip (contracts/generative-ui.md, ADR 0015, design §Stage B)
 * over a real flag-on app: install `tracker` v1 → install the same name again
 * (v2 active, v1 retained) → activate v1 (rollback) — and at EVERY step
 * assert, over POST /app/v1/mcp, that resources/list advertises exactly the
 * active uri and resources/read returns the correct bytes for BOTH @v1 and
 * @v2; plus, against the app's own SQLite handle, the invariant that no name
 * ever has two active rows. Transactionality is proven through the public
 * door: a failed (invalid-HTML) install against the existing name changes
 * neither the active pointer nor the version count. Door unit coverage lives
 * in test/ui-api.test.ts; registry unit coverage in test/ui-registry.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import { makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const APP_TOKEN = 'test-app-ui-versions-token';
const API_TOKEN = 'test-api-token';

const JOBS_URI = 'ui://nightshift/jobs@v1';
const NAME = 'tracker';
const V1_URI = `ui://nightshift/${NAME}@v1`;
const V2_URI = `ui://nightshift/${NAME}@v2`;

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);
const BAD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/bad-no-network.html', import.meta.url)),
  'utf8',
);
// A distinct-but-valid v2 page so the two versions' bytes are distinguishable.
const GOOD_HTML_V2 = GOOD_HTML.replace('</body>', '<p>v2 iteration</p></body>');

describe('generative-ui versions & rollback round trip (Stage 32)', () => {
  let tmpDir: string;
  let app: App | null;
  let apiBase: string;
  let appBase: string;

  const makeApp = async (): Promise<App> => {
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

  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  /** Harness-shaped JSON-RPC POST, matching test/ui-mcp.test.ts. */
  const rpc = async (
    method: string,
    params?: unknown,
  ): Promise<{
    result?: {
      resources?: Array<{ uri: string; _meta?: Record<string, unknown> }>;
      contents?: Array<{ uri: string; text?: string }>;
    };
    error?: { code: number; message: string };
  }> => {
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
    expect(res.status).toBe(200);
    return (await res.json()) as Awaited<ReturnType<typeof rpc>>;
  };

  /** The SQL-level invariant: never two active rows per name (assert after EVERY mutation). */
  const assertOneActivePerName = (): void => {
    const offenders = (app as App).db
      .prepare(
        'SELECT name, COUNT(*) AS n FROM ui_resources WHERE active = 1 GROUP BY name HAVING n > 1',
      )
      .all();
    expect(offenders).toEqual([]);
  };

  /** resources/list must advertise EXACTLY jobs + the one active tracker uri. */
  const assertListShows = async (activeUri: string): Promise<void> => {
    const list = await rpc('resources/list');
    expect((list.result?.resources ?? []).map((r) => r.uri)).toEqual([JOBS_URI, activeUri]);
  };

  /** resources/read must return the exact installed bytes for a uri, active or not. */
  const assertReads = async (uri: string, html: string): Promise<void> => {
    const read = await rpc('resources/read', { uri });
    const contents = read.result?.contents ?? [];
    expect(contents, uri).toHaveLength(1);
    expect(contents[0]?.uri).toBe(uri);
    expect(contents[0]?.text, uri).toBe(html);
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-versions-'));
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('install v1 → install v2 → rollback to v1, observed over MCP at every step', async () => {
    await makeApp();

    // Step 1 — install `tracker` v1.
    const v1 = await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML });
    expect(v1.status).toBe(200);
    expect((v1.body.resource as { version: number; active: boolean }).version).toBe(1);
    assertOneActivePerName();
    await assertListShows(V1_URI);
    await assertReads(V1_URI, GOOD_HTML);

    // Step 2 — install the same name again: v2 active, v1 retained.
    const v2 = await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML_V2 });
    expect(v2.status).toBe(200);
    expect(v2.body.resource as { version: number; active: boolean }).toMatchObject({
      version: 2,
      active: true,
    });
    assertOneActivePerName();
    await assertListShows(V2_URI);
    // BOTH versions readable — a listed client can always read what it saw
    // listed, and rollback needs the old bytes.
    await assertReads(V1_URI, GOOD_HTML);
    await assertReads(V2_URI, GOOD_HTML_V2);

    // Step 3 — rollback: activate v1 again. Nothing deleted, pointer flipped.
    const rollback = await api('POST', `/api/v1/ui/resources/${NAME}/activate`, { version: 1 });
    expect(rollback.status).toBe(200);
    expect(rollback.body.resource as { version: number; active: boolean }).toMatchObject({
      version: 1,
      active: true,
    });
    assertOneActivePerName();
    await assertListShows(V1_URI);
    await assertReads(V1_URI, GOOD_HTML);
    await assertReads(V2_URI, GOOD_HTML_V2);

    // The control-door view agrees: two versions, v1 active.
    const show = await api('GET', `/api/v1/ui/resources/${NAME}`);
    expect(show.status).toBe(200);
    expect(show.body.active).toBe(1);
    expect(
      (show.body.versions as Array<{ version: number; active: boolean }>).map((v) => [
        v.version,
        v.active,
      ]),
    ).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('a failed install against the existing name is a no-op: pointer + count untouched', async () => {
    await makeApp();
    await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML });
    await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML_V2 });

    const failed = await api('POST', '/api/v1/ui/resources', { name: NAME, html: BAD_HTML });
    expect(failed.status).toBe(422);
    assertOneActivePerName();
    // Version count unchanged (still two rows), active pointer still v2.
    const show = await api('GET', `/api/v1/ui/resources/${NAME}`);
    expect((show.body.versions as unknown[]).length).toBe(2);
    expect(show.body.active).toBe(2);
    await assertListShows(V2_URI);
  });

  it('the public API cannot create a second active row: every mutation holds the invariant', async () => {
    await makeApp();
    // Interleave every mutating door the family exposes and re-check the
    // SQL invariant after each — including repeated activates of the SAME
    // version and rapid alternation, the paths a pointer bug would hit.
    await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML });
    assertOneActivePerName();
    await api('POST', '/api/v1/ui/resources', { name: NAME, html: GOOD_HTML_V2 });
    assertOneActivePerName();
    await api('POST', '/api/v1/ui/resources', { name: 'other-page', html: GOOD_HTML });
    assertOneActivePerName();
    for (const version of [1, 1, 2, 1, 2, 2]) {
      const res = await api('POST', `/api/v1/ui/resources/${NAME}/activate`, { version });
      expect(res.status).toBe(200);
      assertOneActivePerName();
    }
    // Failed mutations (404 activate, 422 install) also leave it intact.
    await api('POST', `/api/v1/ui/resources/${NAME}/activate`, { version: 9 });
    assertOneActivePerName();
    await api('POST', '/api/v1/ui/resources', { name: NAME, html: BAD_HTML });
    assertOneActivePerName();
  });
});

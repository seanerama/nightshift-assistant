/**
 * Stage 33 zero-trust grants (contracts/generative-ui.md, ADR 0015): the
 * /api/v1/ui/grants + /grants/revoke doors, the durable ui_grants history
 * (rows never deleted — revoke sets revoked_at; re-grant is a NEW row), and
 * the live intersection granted(name) ∩ requestedTools(version) in
 * _meta["ui/tools"] at BOTH resources/list and resources/read time. The
 * hand-authored jobs@v1 never consults the grants table; flag off → the
 * grant doors 404 with the rest of the family. Registry-level grant
 * semantics (UiRegistryError statuses, grantedTools()) are unit-covered at
 * the bottom against an in-memory migrated DB.
 */

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
import { MIGRATIONS_DIR, makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const APP_TOKEN = 'test-app-ui-grants-token';
const API_TOKEN = 'test-api-token';

const JOBS_URI = 'ui://nightshift/jobs@v1';
const JOBS_META_TOOLS = ['jobs_list', 'jobs_kill', 'jobs_submit'];
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
      resources?: ResourceDescriptor[];
      contents?: Array<{ uri: string; text?: string; _meta?: Record<string, unknown> }>;
    };
    error?: { code: number; message: string };
  };
}

interface UiGrantJson {
  name: string;
  tool: string;
  approvalText: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface GrantRow {
  name: string;
  tool: string;
  approval_text: string;
  granted_at: string;
  revoked_at: string | null;
}

describe('generative-ui grants (Stage 33, contracts/generative-ui.md)', () => {
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

  const install = async (name: string, requestedTools: string[]): Promise<void> => {
    const res = await call('POST', '/api/v1/ui/resources', {
      name,
      html: GOOD_HTML,
      requestedTools,
      provenance: 'ui-grants test',
    });
    expect(res.status).toBe(200);
  };

  const grant = (
    name: string,
    tool: string,
    approvalText = `approved: ${tool}`,
  ): Promise<Response> => call('POST', '/api/v1/ui/grants', { name, tool, approvalText });

  const revoke = (name: string, tool: string): Promise<Response> =>
    call('POST', '/api/v1/ui/grants/revoke', { name, tool });

  /** The _meta["ui/tools"] a uri carries on resources/list. */
  const listedTools = async (uri: string): Promise<unknown> => {
    const res = await rpc('resources/list');
    expect(res.status).toBe(200);
    const entry = (res.body.result?.resources ?? []).find((r) => r.uri === uri);
    expect(entry, uri).toBeDefined();
    return entry?._meta?.['ui/tools'];
  };

  /** The _meta["ui/tools"] a uri carries on resources/read. */
  const readTools = async (uri: string): Promise<unknown> => {
    const res = await rpc('resources/read', { uri });
    expect(res.status).toBe(200);
    return res.body.result?.contents?.[0]?._meta?.['ui/tools'];
  };

  /** The full ui_grants history, oldest first — the durable approval record. */
  const grantRows = (): GrantRow[] =>
    app?.db
      .prepare(
        'SELECT name, tool, approval_text, granted_at, revoked_at FROM ui_grants ORDER BY id',
      )
      .all() as GrantRow[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-grants-'));
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('lifecycle over the doors + MCP (flag on)', () => {
    it('[] → grant → ["jobs_list"] → revoke → [] → re-grant → ["jobs_list"], history durable', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);

      // Zero-trust start: requested but not granted → PRESENT and EMPTY.
      expect(await listedTools(GOOD_URI)).toEqual([]);
      expect(await readTools(GOOD_URI)).toEqual([]);

      // Grant: the frozen UiGrantRecord comes back, and _meta goes live at
      // BOTH list and read time.
      const granted = await grant(GOOD_NAME, 'jobs_list', 'yes — jobs_list is fine');
      expect(granted.status).toBe(200);
      const grantBody = (await granted.json()) as { ok: boolean; grant: UiGrantJson };
      expect(grantBody.ok).toBe(true);
      expect(grantBody.grant.name).toBe(GOOD_NAME);
      expect(grantBody.grant.tool).toBe('jobs_list');
      expect(grantBody.grant.approvalText).toBe('yes — jobs_list is fine');
      expect(grantBody.grant.revokedAt).toBeNull();
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(await readTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(grantRows()).toHaveLength(1);
      expect(grantRows()[0]?.revoked_at).toBeNull();

      // Revoke: immediate on the next list/read; the row is RETAINED with
      // revoked_at set — never deleted.
      const revoked = await revoke(GOOD_NAME, 'jobs_list');
      expect(revoked.status).toBe(200);
      const revokeBody = (await revoked.json()) as { ok: boolean; grant: UiGrantJson };
      expect(revokeBody.grant.revokedAt).toEqual(expect.any(String));
      expect(await listedTools(GOOD_URI)).toEqual([]);
      expect(await readTools(GOOD_URI)).toEqual([]);
      expect(grantRows()).toHaveLength(1);
      expect(grantRows()[0]?.revoked_at).toEqual(expect.any(String));

      // Re-grant after revoke: a NEW row — the approval history is durable.
      expect((await grant(GOOD_NAME, 'jobs_list', 'approved again')).status).toBe(200);
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(await readTools(GOOD_URI)).toEqual(['jobs_list']);
      const history = grantRows();
      expect(history).toHaveLength(2);
      expect(history[0]?.approval_text).toBe('yes — jobs_list is fine');
      expect(history[0]?.revoked_at).toEqual(expect.any(String));
      expect(history[1]?.approval_text).toBe('approved again');
      expect(history[1]?.revoked_at).toBeNull();
    });

    it('granting an already-granted (name, tool) is idempotent — ok, no second active row', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);
      const first = (await (await grant(GOOD_NAME, 'jobs_list', 'first approval')).json()) as {
        grant: UiGrantJson;
      };
      const again = await grant(GOOD_NAME, 'jobs_list', 'second approval text');
      expect(again.status).toBe(200);
      const body = (await again.json()) as { ok: boolean; grant: UiGrantJson };
      expect(body.ok).toBe(true);
      // The EXISTING grant comes back — original approval text and timestamp.
      expect(body.grant).toEqual(first.grant);
      expect(grantRows()).toHaveLength(1);
      expect(grantRows()[0]?.approval_text).toBe('first approval');
    });
  });

  describe('intersection: granted(name) ∩ requestedTools(version)', () => {
    it('page requests [jobs_list, jobs_kill], only jobs_list granted → _meta exactly ["jobs_list"]', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list', 'jobs_kill']);
      expect((await grant(GOOD_NAME, 'jobs_list')).status).toBe(200);
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(await readTools(GOOD_URI)).toEqual(['jobs_list']);
    });

    it('a grant OUTSIDE the requested set is recorded but absent from _meta (name-level grant, version-level intersection)', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list', 'jobs_kill']);
      expect((await grant(GOOD_NAME, 'jobs_list')).status).toBe(200);
      // `status` is a real MCP tool the version does not request: legal to
      // grant (it attaches to the NAME), invisible in this version's _meta.
      expect((await grant(GOOD_NAME, 'status')).status).toBe(200);
      expect(
        grantRows()
          .map((r) => r.tool)
          .sort(),
      ).toEqual(['jobs_list', 'status']);
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(await readTools(GOOD_URI)).toEqual(['jobs_list']);

      // The control door's record shows the same computed intersection.
      const res = await call('GET', '/api/v1/ui/resources');
      const { resources } = (await res.json()) as {
        resources: Array<{ name: string; grantedTools: string[] }>;
      };
      expect(resources.find((r) => r.name === GOOD_NAME)?.grantedTools).toEqual(['jobs_list']);
    });

    it('grants attach to the NAME across versions (ADR 0015): v2 carries the grant ∩ its own requested set; rollback keeps it', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);
      expect((await grant(GOOD_NAME, 'jobs_list')).status).toBe(200);
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);

      // Iteration (Stage 32 next-version install): v2 of the SAME name asks
      // for more. The carried name-level grant applies with NO re-prompt —
      // no new ui_grants row — and the never-granted addition stays absent.
      await install(GOOD_NAME, ['jobs_list', 'jobs_kill']);
      const v2Uri = `ui://nightshift/${GOOD_NAME}@v2`;
      expect(await listedTools(v2Uri)).toEqual(['jobs_list']); // exactly — jobs_kill absent
      expect(await readTools(v2Uri)).toEqual(['jobs_list']);
      expect(grantRows()).toHaveLength(1); // the ONE original approval, nothing re-asked

      // Rollback to v1 (Stage 32 activate): the active record still carries
      // the grant — revocation state rides the NAME, activation the version.
      const act = await call('POST', `/api/v1/ui/resources/${GOOD_NAME}/activate`, { version: 1 });
      expect(act.status).toBe(200);
      expect(await listedTools(GOOD_URI)).toEqual(['jobs_list']);
      expect(await readTools(GOOD_URI)).toEqual(['jobs_list']);
    });
  });

  describe('error discipline', () => {
    it('unknown tool → 422; unknown resource name → 404; revoke of a never-granted tool → 404', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);

      const badTool = await grant(GOOD_NAME, 'jobs_promote');
      expect(badTool.status).toBe(422);
      expect(((await badTool.json()) as { error: string }).error).toContain('unknown tool');

      const badName = await grant('no-such-page', 'jobs_list');
      expect(badName.status).toBe(404);
      expect(((await badName.json()) as { error: string }).error).toContain('no-such-page');

      const neverGranted = await revoke(GOOD_NAME, 'jobs_list');
      expect(neverGranted.status).toBe(404);
      expect(((await neverGranted.json()) as { error: string }).error).toContain('no active grant');

      // Revoke shares the 404/422 discipline for its own inputs.
      expect((await revoke('no-such-page', 'jobs_list')).status).toBe(404);
      expect((await revoke(GOOD_NAME, 'jobs_promote')).status).toBe(422);
      expect(grantRows()).toEqual([]); // nothing was ever written
    });

    it('body-shape errors → 400 (shape errors, not registry 404/422s)', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);
      const cases: Array<[string, unknown]> = [
        ['/api/v1/ui/grants', {}],
        ['/api/v1/ui/grants', { name: GOOD_NAME }],
        ['/api/v1/ui/grants', { name: GOOD_NAME, tool: 'jobs_list' }], // approvalText missing
        ['/api/v1/ui/grants', { name: GOOD_NAME, tool: 'jobs_list', approvalText: 7 }],
        ['/api/v1/ui/grants', { name: 5, tool: 'jobs_list', approvalText: 'ok' }],
        ['/api/v1/ui/grants/revoke', {}],
        ['/api/v1/ui/grants/revoke', { name: GOOD_NAME }],
        ['/api/v1/ui/grants/revoke', { name: GOOD_NAME, tool: 9 }],
      ];
      for (const [path, body] of cases) {
        const res = await call('POST', path, body);
        expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      }
      // Malformed JSON is a 400 too.
      const raw = await fetch(`${apiBase}/api/v1/ui/grants`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: '{not json',
      });
      expect(raw.status).toBe(400);
      expect(grantRows()).toEqual([]);
    });
  });

  describe('hand-authored jobs@v1 never consults the grants table', () => {
    it('jobs descriptor and read _meta are byte-identical regardless of ui_grants contents', async () => {
      await makeApp();
      await install(GOOD_NAME, ['jobs_list']);

      const before = await rpc('resources/list');
      const jobsBefore = (before.body.result?.resources ?? []).find((r) => r.uri === JOBS_URI);
      expect(jobsBefore?._meta?.['ui/tools']).toEqual(JOBS_META_TOOLS);

      // The grant door itself refuses `jobs` (not a registry name) …
      expect((await grant('jobs', 'session_rotate')).status).toBe(404);
      // … so poison the table directly: rows for `jobs` AND a real grant on
      // the registered resource. The static allowlist must not move.
      app?.db
        .prepare(
          `INSERT INTO ui_grants (name, tool, approval_text, granted_at, revoked_at)
           VALUES ('jobs', 'session_rotate', 'sneaky', '2026-01-01T00:00:00Z', NULL)`,
        )
        .run();
      expect((await grant(GOOD_NAME, 'jobs_list')).status).toBe(200);

      const after = await rpc('resources/list');
      const jobsAfter = (after.body.result?.resources ?? []).find((r) => r.uri === JOBS_URI);
      expect(JSON.stringify(jobsAfter)).toBe(JSON.stringify(jobsBefore)); // byte-identical
      const read = await rpc('resources/read', { uri: JOBS_URI });
      expect(read.body.result?.contents?.[0]?._meta?.['ui/tools']).toEqual(JOBS_META_TOOLS);
    });
  });

  describe('flag off — the grant doors are ABSENT with the rest of the family', () => {
    it('POST /api/v1/ui/grants and /grants/revoke → 404', async () => {
      await makeApp({ generativeUiEnabled: false });
      for (const path of ['/api/v1/ui/grants', '/api/v1/ui/grants/revoke']) {
        const res = await call('POST', path, { name: GOOD_NAME, tool: 'jobs_list' });
        expect(res.status, path).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: 'not found' });
      }
    });
  });
});

describe('ui registry grant unit semantics (in-memory DB)', () => {
  let db: Database.Database;
  let registry: UiRegistry;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    registry = createUiRegistry(db);
    registry.install({ name: 'page', html: GOOD_HTML, requestedTools: ['jobs_list'] });
  });

  afterEach(() => {
    db.close();
  });

  it('grantedTools() reflects active (unrevoked) grants only — name-level, not intersected', () => {
    expect(registry.grantedTools('page')).toEqual([]);
    registry.grant('page', 'jobs_list', 'ok');
    registry.grant('page', 'status', 'ok'); // not requested — still name-level granted
    expect([...registry.grantedTools('page')].sort()).toEqual(['jobs_list', 'status']);
    registry.revoke('page', 'status');
    expect(registry.grantedTools('page')).toEqual(['jobs_list']);
    // The record's grantedTools stays the intersection with requestedTools.
    expect(registry.list()[0]?.grantedTools).toEqual(['jobs_list']);
  });

  it('error statuses ride UiRegistryError: 404 unknown name / no active grant, 422 unknown tool', () => {
    const caught = (fn: () => unknown): UiRegistryError => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(UiRegistryError);
        return err as UiRegistryError;
      }
      throw new Error('expected a UiRegistryError');
    };
    expect(caught(() => registry.grant('nope', 'jobs_list', 'x')).status).toBe(404);
    expect(caught(() => registry.grant('page', 'not_a_tool', 'x')).status).toBe(422);
    expect(caught(() => registry.revoke('page', 'jobs_list')).status).toBe(404);
    expect(caught(() => registry.revoke('nope', 'jobs_list')).status).toBe(404);
    expect(caught(() => registry.revoke('page', 'not_a_tool')).status).toBe(422);
    // `jobs` is reserved, never registered — a grant addressed to it is 404.
    expect(caught(() => registry.grant('jobs', 'jobs_list', 'x')).status).toBe(404);
  });

  it('idempotent while active; re-grant after revoke is a NEW row; rows never deleted', () => {
    const first = registry.grant('page', 'jobs_list', 'first');
    const dup = registry.grant('page', 'jobs_list', 'ignored duplicate');
    expect(dup).toEqual(first);
    const count = (): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM ui_grants').get() as { n: number }).n;
    expect(count()).toBe(1);
    registry.revoke('page', 'jobs_list');
    expect(count()).toBe(1); // revoked, retained
    const regrant = registry.grant('page', 'jobs_list', 'second era');
    expect(regrant.revokedAt).toBeNull();
    expect(regrant.approvalText).toBe('second era');
    expect(count()).toBe(2); // durable history
  });
});

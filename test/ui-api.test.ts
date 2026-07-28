/**
 * Stage 31 /api/v1/ui/* doors (contracts/generative-ui.md, additive on
 * control-api v1) against a real app instance: dry-run validate, register
 * (422 + machine-readable verdict on invalid, NOTHING written), the
 * queryable list, and the gates — NIGHTSHIFT_GENERATIVE_UI_ENABLED off →
 * the WHOLE family 404s (feature absent, not 403-disabled) while the control
 * kill-switch and bearer auth behave exactly as on the rest of the surface.
 * Registry semantics themselves are unit-covered in test/ui-registry.test.ts;
 * the MCP mapping in test/ui-mcp.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { UiVerdict } from '../src/ui/validator.js';
import { makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const TOKEN = 'test-api-token';

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);
const BAD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/bad-no-storage.html', import.meta.url)),
  'utf8',
);

interface UiResourceJson {
  name: string;
  version: number;
  active: boolean;
  requestedTools: string[];
  grantedTools: string[];
  provenance: string;
  createdAt: string;
  htmlBytes: number;
  html?: string;
}

describe('generative-ui doors (/api/v1/ui/*, Stage 31)', () => {
  let tmpDir: string;
  let app: App | null;
  let baseUrl: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        generativeUiEnabled: true,
        ...overrides,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const port = await a.listen();
    baseUrl = `http://127.0.0.1:${port}`;
    app = a;
    return a;
  };

  const call = (
    method: string,
    path: string,
    opts: { token?: string | null; body?: unknown } = {},
  ): Promise<Response> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  };

  const listResources = async (): Promise<UiResourceJson[]> => {
    const res = await call('GET', '/api/v1/ui/resources');
    expect(res.status).toBe(200);
    return ((await res.json()) as { resources: UiResourceJson[] }).resources;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-api-'));
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('flag off (NIGHTSHIFT_GENERATIVE_UI_ENABLED unset/false) — feature ABSENT', () => {
    it('every ui door 404s with a valid token — 404, not 403 (the dark posture)', async () => {
      await makeApp({ generativeUiEnabled: false });
      for (const [method, path] of [
        ['POST', '/api/v1/ui/validate'],
        ['POST', '/api/v1/ui/resources'],
        ['GET', '/api/v1/ui/resources'],
      ] as const) {
        const res = await call(method, path, method === 'GET' ? {} : { body: { html: GOOD_HTML } });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.json()).toEqual({ ok: false, error: 'not found' });
      }
    });

    it('the rest of the control surface is undisturbed: /api/v1/status answers', async () => {
      await makeApp({ generativeUiEnabled: false });
      expect((await call('GET', '/api/v1/status')).status).toBe(200);
    });
  });

  describe('shared control-api gates still front the family', () => {
    it('control kill-switch off → 403 (before the ui flag is consulted)', async () => {
      await makeApp({ controlEnabled: false });
      const res = await call('GET', '/api/v1/ui/resources');
      expect(res.status).toBe(403);
    });

    it('bearer auth → 401 without / with a wrong token', async () => {
      await makeApp();
      expect((await call('GET', '/api/v1/ui/resources', { token: null })).status).toBe(401);
      expect((await call('GET', '/api/v1/ui/resources', { token: 'nope' })).status).toBe(401);
    });
  });

  describe('POST /api/v1/ui/validate (dry-run — never writes)', () => {
    it('valid page → 200 { ok: true, verdict.valid: true }', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/ui/validate', { body: { html: GOOD_HTML } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, verdict: { valid: true, violations: [] } });
    });

    it('invalid page → 422 with the machine-readable verdict — and no row appears', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/ui/validate', { body: { html: BAD_HTML } });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { ok: boolean; error: string; verdict: UiVerdict };
      expect(body.ok).toBe(false);
      expect(body.error).toContain('no-storage');
      expect(body.verdict.valid).toBe(false);
      expect(body.verdict.violations.map((v) => v.rule)).toEqual(['no-storage']);
      expect(await listResources()).toEqual([]);
    });

    it('missing/typed-wrong html → 400', async () => {
      await makeApp();
      expect((await call('POST', '/api/v1/ui/validate', { body: {} })).status).toBe(400);
      expect((await call('POST', '/api/v1/ui/validate', { body: { html: 5 } })).status).toBe(400);
    });
  });

  describe('POST /api/v1/ui/resources (register) + GET (list)', () => {
    it('good install → 200 with the v1 active record; list shows it, html omitted', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/ui/resources', {
        body: {
          name: 'good-fixture',
          html: GOOD_HTML,
          requestedTools: ['jobs_list'],
          provenance: 'ui-api test',
        },
      });
      expect(res.status).toBe(200);
      const { ok, resource } = (await res.json()) as { ok: boolean; resource: UiResourceJson };
      expect(ok).toBe(true);
      expect(resource.name).toBe('good-fixture');
      expect(resource.version).toBe(1);
      expect(resource.active).toBe(true);
      expect(resource.requestedTools).toEqual(['jobs_list']);
      expect(resource.grantedTools).toEqual([]); // zero-trust: nothing granted this stage
      expect(resource.htmlBytes).toBe(Buffer.byteLength(GOOD_HTML, 'utf8'));
      expect(resource.html).toBeUndefined();

      const listed = await listResources();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe('good-fixture');
      expect(listed[0]?.html).toBeUndefined();
    });

    it('invalid page → 422 { ok:false, error, verdict } and the table stays EMPTY', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/ui/resources', {
        body: { name: 'bad-fixture', html: BAD_HTML },
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { ok: boolean; error: string; verdict: UiVerdict };
      expect(body.ok).toBe(false);
      expect(body.verdict.violations.map((v) => v.rule)).toEqual(['no-storage']);
      expect(await listResources()).toEqual([]);
    });

    it('reserved name `jobs` and malformed names → 422, nothing written', async () => {
      await makeApp();
      for (const name of ['jobs', 'Bad-Name', 'x', '9starts-with-digit']) {
        const res = await call('POST', '/api/v1/ui/resources', {
          body: { name, html: GOOD_HTML },
        });
        expect(res.status, name).toBe(422);
        const body = (await res.json()) as { ok: boolean; verdict?: UiVerdict };
        expect(body.ok, name).toBe(false);
        expect(body.verdict, name).toBeUndefined(); // not a validation failure — no verdict
      }
      expect(await listResources()).toEqual([]);
    });

    it('requestedTools outside the frozen MCP catalog → 422', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/ui/resources', {
        body: { name: 'good-fixture', html: GOOD_HTML, requestedTools: ['jobs_promote'] },
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toContain('unknown requested tool');
      expect(await listResources()).toEqual([]);
    });

    it('re-install of a taken name refuses cleanly (Stage 32 scope) — registry uncorrupted', async () => {
      await makeApp();
      expect(
        (
          await call('POST', '/api/v1/ui/resources', {
            body: { name: 'good-fixture', html: GOOD_HTML },
          })
        ).status,
      ).toBe(200);
      const again = await call('POST', '/api/v1/ui/resources', {
        body: { name: 'good-fixture', html: GOOD_HTML },
      });
      expect(again.status).toBe(422);
      expect(((await again.json()) as { error: string }).error).toContain('already registered');
      // UNIQUE holds and nothing changed: still exactly the one active v1.
      const listed = await listResources();
      expect(listed.map((r) => [r.name, r.version, r.active])).toEqual([['good-fixture', 1, true]]);
    });

    it('body discipline: missing name/html → 400 (shape errors, not registry 422s)', async () => {
      await makeApp();
      expect(
        (await call('POST', '/api/v1/ui/resources', { body: { html: GOOD_HTML } })).status,
      ).toBe(400);
      expect(
        (await call('POST', '/api/v1/ui/resources', { body: { name: 'good-fixture' } })).status,
      ).toBe(400);
      expect(
        (
          await call('POST', '/api/v1/ui/resources', {
            body: { name: 'good-fixture', html: GOOD_HTML, requestedTools: 'jobs_list' },
          })
        ).status,
      ).toBe(400);
    });
  });
});

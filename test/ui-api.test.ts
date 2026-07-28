/**
 * Stages 31–32 /api/v1/ui/* doors (contracts/generative-ui.md, additive on
 * control-api v1) against a real app instance: dry-run validate, register
 * (422 + machine-readable verdict on invalid, NOTHING written; a taken name
 * gets the NEXT version), the queryable list, the versioned sub-resources
 * (show-all, show-one-with-html, activate) with their 404s, and the gates —
 * NIGHTSHIFT_GENERATIVE_UI_ENABLED off → the WHOLE family 404s (feature
 * absent, not 403-disabled) while the control kill-switch and bearer auth
 * behave exactly as on the rest of the surface. Registry semantics themselves
 * are unit-covered in test/ui-registry.test.ts; the MCP mapping in
 * test/ui-mcp.test.ts; the full round trip in test/ui-versions.test.ts.
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
        // Stage 32 doors 404 identically when dark — absent, like the family.
        ['GET', '/api/v1/ui/resources/some-name'],
        ['GET', '/api/v1/ui/resources/some-name/1'],
        ['POST', '/api/v1/ui/resources/some-name/activate'],
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

    it('re-install of a taken name assigns the NEXT version, active (Stage 32)', async () => {
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
      expect(again.status).toBe(200);
      const { resource } = (await again.json()) as { resource: UiResourceJson };
      expect([resource.version, resource.active]).toEqual([2, true]);
      // The list advertises the ACTIVE version only; v1 is retained beneath.
      const listed = await listResources();
      expect(listed.map((r) => [r.name, r.version, r.active])).toEqual([['good-fixture', 2, true]]);
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

  describe('versioned sub-resources (Stage 32: show / show-one / activate)', () => {
    /** Two installs of the same name → v1 (inactive) + v2 (active). */
    const installTwice = async (): Promise<void> => {
      for (let i = 0; i < 2; i += 1) {
        const res = await call('POST', '/api/v1/ui/resources', {
          body: { name: 'good-fixture', html: GOOD_HTML },
        });
        expect(res.status).toBe(200);
      }
    };

    it('GET /<name> → { ok, name, active, versions } — every version, html omitted', async () => {
      await makeApp();
      await installTwice();
      const res = await call('GET', '/api/v1/ui/resources/good-fixture');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        name: string;
        active: number;
        versions: UiResourceJson[];
      };
      expect(body.ok).toBe(true);
      expect(body.name).toBe('good-fixture');
      expect(body.active).toBe(2);
      expect(body.versions.map((v) => [v.version, v.active])).toEqual([
        [1, false],
        [2, true],
      ]);
      for (const version of body.versions) expect(version.html).toBeUndefined();
    });

    it('GET /<name>/<version> → the one record WITH html (the only html-serving door)', async () => {
      await makeApp();
      await installTwice();
      for (const version of [1, 2]) {
        const res = await call('GET', `/api/v1/ui/resources/good-fixture/${version}`);
        expect(res.status, `v${version}`).toBe(200);
        const { resource } = (await res.json()) as { resource: UiResourceJson };
        expect(resource.version).toBe(version);
        expect(resource.html).toBe(GOOD_HTML);
      }
    });

    it('POST /<name>/activate { version } → rollback; the pointer and list follow', async () => {
      await makeApp();
      await installTwice();
      const res = await call('POST', '/api/v1/ui/resources/good-fixture/activate', {
        body: { version: 1 },
      });
      expect(res.status).toBe(200);
      const { resource } = (await res.json()) as { resource: UiResourceJson };
      expect([resource.version, resource.active]).toEqual([1, true]);
      const listed = await listResources();
      expect(listed.map((r) => [r.name, r.version])).toEqual([['good-fixture', 1]]);
    });

    it('404s: unknown name on show, unknown version on show-one and activate', async () => {
      await makeApp();
      await installTwice();
      expect((await call('GET', '/api/v1/ui/resources/no-such-name')).status).toBe(404);
      expect((await call('GET', '/api/v1/ui/resources/good-fixture/3')).status).toBe(404);
      expect((await call('GET', '/api/v1/ui/resources/good-fixture/zero')).status).toBe(404);
      const res = await call('POST', '/api/v1/ui/resources/no-such-name/activate', {
        body: { version: 1 },
      });
      expect(res.status).toBe(404);
      const badVersion = await call('POST', '/api/v1/ui/resources/good-fixture/activate', {
        body: { version: 3 },
      });
      expect(badVersion.status).toBe(404);
      // Nothing moved: v2 is still the active version.
      const listed = await listResources();
      expect(listed.map((r) => [r.name, r.version])).toEqual([['good-fixture', 2]]);
    });

    it('activate body discipline: missing/non-integer/sub-1 version → 400', async () => {
      await makeApp();
      await installTwice();
      for (const body of [{}, { version: '1' }, { version: 1.5 }, { version: 0 }]) {
        const res = await call('POST', '/api/v1/ui/resources/good-fixture/activate', { body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('wrong method on the sub-resources → 404 (path style matches /api/v1/jobs/<id>)', async () => {
      await makeApp();
      await installTwice();
      expect((await call('POST', '/api/v1/ui/resources/good-fixture')).status).toBe(404);
      expect((await call('POST', '/api/v1/ui/resources/good-fixture/1')).status).toBe(404);
      expect((await call('GET', '/api/v1/ui/resources/good-fixture/activate')).status).toBe(404);
    });
  });
});

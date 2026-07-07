/**
 * POST /api/v1/promote (Stage 11, additive on control-api v1) against a real
 * app instance: the three gates in order (control kill-switch → bearer →
 * NIGHTSHIFT_PROMOTE_ENABLED), dry-run as the wire default (confirm absent →
 * planned, zero side effects), the async execute contract (immediate
 * 'running' record; 'live' lands in the background), and 400s for bad bodies
 * — the pipeline is the real one, with fixture servers + a git/gh PATH shim
 * at the seams.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { PromotionRecord } from '../src/types.js';
import {
  type CloudflareStub,
  type CoolifyStub,
  type HealthStub,
  makeConfig,
  makeTestLogger,
  makeToolShim,
  startCloudflareStub,
  startCoolifyStub,
  startHealthStub,
  WORKER_STUB,
  waitFor,
} from './helpers.js';

const TOKEN = 'promote-api-token';
const SLUG = 'subnet-study';

describe('POST /api/v1/promote', () => {
  let tmpDir: string;
  let contentDir: string;
  let app: App | null;
  let baseUrl: string;
  let coolify: CoolifyStub;
  let cloudflare: CloudflareStub;
  let health: HealthStub;
  let shim: ReturnType<typeof makeToolShim>;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        promoteEnabled: true,
        promote: {
          ...makeConfig().promote,
          coolifyApiUrl: coolify.baseUrl,
          cfApiBase: cloudflare.baseUrl,
          healthBase: health.baseUrl,
        },
        ...overrides,
      }),
      makeTestLogger(),
      {
        appDir: tmpDir,
        home: tmpDir,
        promote: { env: shim.env, healthRetries: 2, healthIntervalMs: 20, deployIntervalMs: 20 },
      },
    );
    const port = await a.listen();
    baseUrl = `http://127.0.0.1:${port}`;
    app = a;
    return a;
  };

  const call = (body: unknown, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/promote`, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const recordOf = (a: App, slug: string): PromotionRecord | null => {
    const row = a.db.prepare('SELECT status, steps FROM promotions WHERE slug = ?').get(slug) as
      | { status: PromotionRecord['status']; steps: string }
      | undefined;
    return row === undefined
      ? null
      : ({ status: row.status, steps: JSON.parse(row.steps) } as PromotionRecord);
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-promote-api-'));
    contentDir = join(tmpDir, 'projects', SLUG);
    mkdirSync(join(contentDir, 'guides'), { recursive: true });
    writeFileSync(join(contentDir, 'guides', 'chapter-01.html'), '<p>one</p>');
    coolify = await startCoolifyStub();
    cloudflare = await startCloudflareStub();
    health = await startHealthStub();
    shim = makeToolShim(tmpDir);
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    await coolify.close();
    await cloudflare.close();
    await health.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kill-switch: 403 with a clear error when NIGHTSHIFT_PROMOTE_ENABLED is off (control on)', async () => {
    await makeApp({ promoteEnabled: false });
    const res = await call({ path: contentDir, confirm: true });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('NIGHTSHIFT_PROMOTE_ENABLED');
    expect(shim.invocations()).toEqual([]); // fully dark — nothing ran
  });

  it('sits behind the control gates: control off → 403, bad bearer → 401', async () => {
    await makeApp({ controlEnabled: false });
    const dark = await call({ path: contentDir });
    expect(dark.status).toBe(403);
    expect(((await dark.json()) as { error: string }).error).toContain(
      'NIGHTSHIFT_CONTROL_ENABLED',
    );
    await app?.close();
    app = null;

    await makeApp();
    const unauthorized = await call({ path: contentDir }, 'wrong-token');
    expect(unauthorized.status).toBe(401);
  });

  it('confirm absent → DRY RUN: planned record + step plan, zero side effects', async () => {
    const a = await makeApp();
    const res = await call({ path: contentDir });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; promotion: PromotionRecord };
    expect(json.ok).toBe(true);
    expect(json.promotion.status).toBe('planned');
    expect(json.promotion.slug).toBe(SLUG);
    expect(json.promotion.steps).toHaveLength(7);
    expect(recordOf(a, SLUG)?.status).toBe('planned');
    expect(shim.invocations()).toEqual([]);
    expect(coolify.requests).toEqual([]);
    expect(existsSync(join(contentDir, '.git'))).toBe(false);
  });

  it('confirm:true → responds immediately with the running record; live lands async', async () => {
    const a = await makeApp();
    const res = await call({ path: contentDir, confirm: true, title: 'Subnet Study' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; promotion: PromotionRecord };
    expect(json.ok).toBe(true);
    expect(json.promotion.status).toBe('running'); // the async contract
    await waitFor(() => recordOf(a, SLUG)?.status === 'live');
    expect(recordOf(a, SLUG)?.steps.every((s) => s.ok)).toBe(true);
  });

  it('400s: missing path, non-string slug/title, non-boolean confirm, escaping path', async () => {
    await makeApp();
    for (const [body, fragment] of [
      [{}, 'path'],
      [{ path: contentDir, slug: 7 }, 'slug'],
      [{ path: contentDir, title: [] }, 'title'],
      [{ path: contentDir, confirm: 'yes' }, 'confirm'],
      [{ path: '/etc' }, 'must live inside'],
      [{ path: join(tmpDir, 'projects', 'nope') }, 'not found'],
    ] as const) {
      const res = await call(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(fragment);
    }
  });
});

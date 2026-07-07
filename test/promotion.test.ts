/**
 * Promotion pipeline (contracts/promotion.md; Stage 11): the testing matrix
 * against the REAL promoter — external seams only are stubbed (fixture HTTP
 * servers for Coolify/Cloudflare/health, a PATH-shimmed fake git/gh for the
 * repo step); the pipeline logic itself is never stubbed. Dry-run-by-default
 * with zero side effects, the 7-step happy path, secret-scan abort before
 * git, validation rejections, index.html generation, one-live-per-slug
 * re-promotion, and first-failure-stops semantics are all proven here.
 *
 * Stage 13 NOTE: these tests drive createPromoter DIRECTLY. Through the real
 * promote entry (the router, promotion-site.test.ts) this subdomain pipeline
 * is UNREACHABLE for the study/story fixtures used here — it is retained
 * solely for future app promotion, and its behavior must not regress.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { ensureIndexHtml } from '../src/promotion/index.js';
import { createPromoter, type Promoter, PromotionError } from '../src/promotion/pipeline.js';
import { scanForSecrets } from '../src/promotion/scan.js';
import { createPromotionStore } from '../src/promotion/store.js';
import {
  type CloudflareStub,
  type CoolifyStub,
  type HealthStub,
  MIGRATIONS_DIR,
  makeConfig,
  makeTestLogger,
  makeToolShim,
  startCloudflareStub,
  startCoolifyStub,
  startHealthStub,
  waitFor,
} from './helpers.js';

const SLUG = 'subnet-study';

describe('promotion pipeline', () => {
  let tmpDir: string;
  let contentDir: string;
  let db: Database.Database;
  let coolify: CoolifyStub;
  let cloudflare: CloudflareStub;
  let health: HealthStub;
  let shim: ReturnType<typeof makeToolShim>;
  let notices: string[];
  let config: Config;
  let promoter: Promoter;

  /** Seed a recognizable study project under <home>/projects. */
  const seedStudy = (dir: string): void => {
    mkdirSync(join(dir, 'guides'), { recursive: true });
    writeFileSync(
      join(dir, 'guides', 'chapter-01.html'),
      '<!doctype html><html><head><title>Chapter 1: Subnets</title></head><body>hi</body></html>',
    );
    writeFileSync(join(dir, 'guides', 'chapter-02.html'), '<!doctype html><p>two</p>');
    writeFileSync(join(dir, 'textbook.md'), '# Subnetting\n\nA book.\n');
  };

  const promote = (overrides: Partial<Parameters<Promoter['promote']>[0]> = {}) =>
    promoter.promote({ path: contentDir, confirm: false, ...overrides });

  const statusOf = (slug: string): string | undefined =>
    createPromotionStore(db).getBySlug(slug)?.status;

  const waitForFinal = async (slug: string): Promise<void> => {
    await waitFor(() => statusOf(slug) === 'live' || statusOf(slug) === 'failed');
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-promo-'));
    contentDir = join(tmpDir, 'projects', SLUG);
    seedStudy(contentDir);
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    coolify = await startCoolifyStub();
    cloudflare = await startCloudflareStub();
    health = await startHealthStub();
    shim = makeToolShim(tmpDir);
    notices = [];
    config = makeConfig({
      promoteEnabled: true,
      promote: {
        ...makeConfig().promote,
        coolifyApiUrl: coolify.baseUrl,
        cfApiBase: cloudflare.baseUrl,
        healthBase: health.baseUrl,
      },
    });
    promoter = createPromoter(
      {
        db,
        log: makeTestLogger(),
        config,
        notify: async (text) => {
          notices.push(text);
        },
      },
      {
        home: tmpDir,
        env: shim.env,
        healthRetries: 3,
        healthIntervalMs: 20,
        deployRetries: 3,
        deployIntervalMs: 20,
      },
    );
  });

  afterEach(async () => {
    db.close();
    await coolify.close();
    await cloudflare.close();
    await health.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('dry run (the default)', () => {
    it('returns the full 7-step plan with computed slug/url/repo and ZERO side effects', async () => {
      const record = await promote(); // confirm:false
      expect(record.status).toBe('planned');
      expect(record.slug).toBe(SLUG);
      expect(record.url).toBe(`https://${SLUG}.example.test`);
      expect(record.repoUrl).toBe(`https://github.com/seanerama/${SLUG}`);
      expect(record.steps.map((s) => s.name)).toEqual([
        'validate',
        'scan',
        'repo',
        'coolify',
        'route',
        'dns',
        'health',
      ]);
      for (const step of record.steps) expect(step.detail).toContain('planned');

      // ZERO side effects: no git dir, no index.html written, no tool
      // invocations, no fixture traffic.
      expect(existsSync(join(contentDir, '.git'))).toBe(false);
      expect(existsSync(join(contentDir, 'index.html'))).toBe(false);
      expect(shim.invocations()).toEqual([]);
      expect(coolify.requests).toEqual([]);
      expect(cloudflare.requests).toEqual([]);
      expect(health.requests).toEqual([]);

      // ...but the plan IS persisted as 'planned'.
      expect(statusOf(SLUG)).toBe('planned');
    });

    it('a dry run never demotes a live record', async () => {
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');

      const plan = await promote(); // dry-run again
      expect(plan.status).toBe('planned'); // the returned plan
      expect(statusOf(SLUG)).toBe('live'); // storage truth untouched
    });
  });

  describe('happy path (confirm:true)', () => {
    it('runs all 7 steps ok, lands live with repo/url, sends the 🚀 notice', async () => {
      const running = await promote({ confirm: true, title: 'Subnetting Study' });
      expect(running.status).toBe('running');

      await waitForFinal(SLUG);
      const record = promoter.get(SLUG);
      expect(record?.status).toBe('live');
      expect(record?.url).toBe(`https://${SLUG}.example.test`);
      expect(record?.repoUrl).toBe(`https://github.com/seanerama/${SLUG}`);
      expect(record?.endedAt).not.toBeNull();
      expect(record?.error).toBeNull();
      expect(record?.steps).toHaveLength(7);
      for (const step of record?.steps ?? []) expect(step.ok, step.name).toBe(true);

      // Repo step: init → add → commit → create (first promotion) via the shim.
      const calls = shim.invocations();
      expect(calls).toContain('git init -b main');
      expect(calls).toContain('git add -A');
      expect(calls.some((c) => c.startsWith('git commit -m'))).toBe(true);
      expect(
        calls.some((c) =>
          c.startsWith(
            `gh repo create seanerama/${SLUG} --public --source . --remote origin --push`,
          ),
        ),
      ).toBe(true);

      // Coolify: static-app create with the contract payload, then deploy + wait.
      const create = coolify.requests.find((r) => r.path === '/api/v1/applications/public');
      expect(create?.body).toMatchObject({
        project_uuid: 'proj-uuid',
        environment_name: 'production',
        server_uuid: 'server-uuid',
        name: SLUG,
        git_repository: `https://github.com/seanerama/${SLUG}`,
        git_branch: 'main',
        build_pack: 'static',
        ports_exposes: '80',
        domains: `https://${SLUG}.example.test`,
      });
      expect(coolify.requests.some((r) => r.path === '/api/v1/deploy')).toBe(true);
      expect(coolify.requests.some((r) => r.path === '/api/v1/deployments/dep-1')).toBe(true);

      // Cloudflare: ingress rule inserted BEFORE the catch-all + proxied CNAME.
      const put = cloudflare.requests.find((r) => r.method === 'PUT');
      const putIngress = (put?.body as { config: { ingress: Array<Record<string, unknown>> } })
        .config.ingress;
      expect(putIngress[0]).toMatchObject({
        hostname: `${SLUG}.example.test`,
        service: 'https://localhost:443',
        originRequest: { noTLSVerify: true },
      });
      expect(putIngress[1]).toMatchObject({ service: 'http_status:404' });
      const dns = cloudflare.requests.find((r) => r.path.endsWith('/dns_records'));
      expect(dns?.body).toMatchObject({
        type: 'CNAME',
        name: `${SLUG}.example.test`,
        content: 'cf-tunnel.cfargotunnel.com',
        proxied: true,
      });

      // Health hit the seam target; index.html was generated for the study.
      expect(health.requests.length).toBeGreaterThan(0);
      expect(existsSync(join(contentDir, 'index.html'))).toBe(true);
      const index = readFileSync(join(contentDir, 'index.html'), 'utf8');
      expect(index).toContain('Chapter 1: Subnets'); // label from the guide <title>
      expect(index).toContain('guides/chapter-02.html');
      expect(index).toContain('textbook.md');
      expect(index).toContain('Subnetting Study');

      // 🚀 completion notice with the live URL.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('🚀');
      expect(notices[0]).toContain('Subnetting Study');
      expect(notices[0]).toContain(`https://${SLUG}.example.test`);
      expect(notices[0]).toContain(`https://github.com/seanerama/${SLUG}`);
    });

    it('retries the health check until 200 within the bound', async () => {
      health.failFirst(2); // 3 retries configured — the third GET succeeds
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      expect(health.requests.length).toBe(3);
      const healthStep = promoter.get(SLUG)?.steps.find((s) => s.name === 'health');
      expect(healthStep?.detail).toContain('attempt 3/3');
    });

    it('recognizes story content (final video/PDF) and links it from the index', async () => {
      const storyDir = join(tmpDir, 'projects', 'brave-turtle');
      mkdirSync(storyDir, { recursive: true });
      writeFileSync(join(storyDir, 'brave-turtle-final.mp4'), 'not-really-video');
      writeFileSync(join(storyDir, 'brave-turtle.pdf'), 'not-really-pdf');

      await promoter.promote({ path: storyDir, confirm: true });
      await waitForFinal('brave-turtle');
      expect(statusOf('brave-turtle')).toBe('live');
      const index = readFileSync(join(storyDir, 'index.html'), 'utf8');
      expect(index).toContain('brave-turtle-final.mp4');
      expect(index).toContain('brave-turtle.pdf');
    });
  });

  describe('secret scan (abort BEFORE git)', () => {
    it('seeded .env-like and key-like files fail the scan step, hits listed, nothing left the box', async () => {
      writeFileSync(join(contentDir, '.env'), 'SECRET=hunter2-hunter2-hunter2\n');
      writeFileSync(join(contentDir, 'deploy-key.pem'), 'anything');
      writeFileSync(
        join(contentDir, 'notes.txt'),
        'aws creds are AKIAIOSFODNN7EXAMPLE do not share\n', // gitleaks:allow
      );

      await promote({ confirm: true });
      await waitForFinal(SLUG);

      const record = promoter.get(SLUG);
      expect(record?.status).toBe('failed');
      const scanStep = record?.steps.find((s) => s.name === 'scan');
      expect(scanStep?.ok).toBe(false);
      expect(scanStep?.detail).toContain('.env');
      expect(scanStep?.detail).toContain('deploy-key.pem');
      expect(scanStep?.detail).toContain('notes.txt');
      expect(record?.error).toContain('scan');

      // Aborted BEFORE the repo step: zero git/gh invocations, zero infra calls.
      expect(shim.invocations()).toEqual([]);
      expect(coolify.requests).toEqual([]);
      expect(cloudflare.requests).toEqual([]);

      // Later steps never ran; the failure notice went out.
      expect(record?.steps.map((s) => s.name)).toEqual(['validate', 'scan']);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('FAILED');
      expect(notices[0]).toContain('scan');
    });
  });

  describe('validate', () => {
    it('rejects a path outside $HOME/projects', async () => {
      const outside = join(tmpDir, 'elsewhere');
      mkdirSync(outside);
      await expect(promoter.promote({ path: outside, confirm: false })).rejects.toThrow(
        PromotionError,
      );
      await expect(promoter.promote({ path: '/etc', confirm: true })).rejects.toThrow(
        /must live inside/,
      );
      await expect(promoter.promote({ path: 'relative/dir', confirm: false })).rejects.toThrow(
        /absolute/,
      );
    });

    it('rejects unrecognized content (neither study nor story shape)', async () => {
      const empty = join(tmpDir, 'projects', 'mystery');
      mkdirSync(empty, { recursive: true });
      writeFileSync(join(empty, 'whatever.txt'), 'hello');
      await expect(promoter.promote({ path: empty, confirm: false })).rejects.toThrow(
        /unrecognized content/,
      );
    });

    it('never overwrites an existing index.html', async () => {
      writeFileSync(join(contentDir, 'index.html'), '<p>my own landing page</p>');
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      expect(readFileSync(join(contentDir, 'index.html'), 'utf8')).toBe(
        '<p>my own landing page</p>',
      );
      const validateStep = promoter.get(SLUG)?.steps.find((s) => s.name === 'validate');
      expect(validateStep?.detail).toContain('already present');
    });

    it('honors --slug and --title overrides', async () => {
      const record = await promote({ slug: 'My Fancy Slug!', title: 'Custom Title' });
      expect(record.slug).toBe('my-fancy-slug'); // slugified
      expect(record.title).toBe('Custom Title');
      expect(record.url).toBe('https://my-fancy-slug.example.test');
    });
  });

  describe('re-promote (one live promotion per slug)', () => {
    it('updates the same record and target: repo push (not create), Coolify redeploy (not re-create)', async () => {
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const first = promoter.get(SLUG);
      expect(first?.status).toBe('live');

      const createsAfterFirst = coolify.requests.filter(
        (r) => r.path === '/api/v1/applications/public',
      ).length;
      expect(createsAfterFirst).toBe(1);

      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const second = promoter.get(SLUG);
      expect(second?.status).toBe('live');
      expect(second?.id).toBe(first?.id); // same record, updated in place

      // Exactly one promotions row for the slug — never a duplicate.
      const rows = db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE slug = ?').get(SLUG) as {
        n: number;
      };
      expect(rows.n).toBe(1);

      // Repo step took the update path (gh repo view now succeeds → push).
      const calls = shim.invocations();
      expect(calls.filter((c) => c.startsWith('gh repo create')).length).toBe(1);
      expect(calls).toContain('git push -u origin HEAD');

      // Coolify reused the stored app: still ONE create, TWO deploys.
      expect(coolify.requests.filter((r) => r.path === '/api/v1/applications/public').length).toBe(
        1,
      );
      expect(coolify.requests.filter((r) => r.path === '/api/v1/deploy').length).toBe(2);
      const coolifyStep = second?.steps.find((s) => s.name === 'coolify');
      expect(coolifyStep?.detail).toContain('reusing app app-uuid-1');

      // Route step saw the rule already present — no duplicate ingress rule.
      const routeStep = second?.steps.find((s) => s.name === 'route');
      expect(routeStep?.detail).toContain('already exists');
      expect(cloudflare.ingress.filter((r) => r.hostname === `${SLUG}.example.test`).length).toBe(
        1,
      );
    });

    it('rejects a second confirm while the slug is already running', async () => {
      health.failFirst(2); // slow the first run down a little
      await promote({ confirm: true });
      await expect(promote({ confirm: true })).rejects.toThrow(/already running/);
      await waitForFinal(SLUG);
    });
  });

  describe('step failure stops the run', () => {
    it('Coolify 500 → record failed at coolify, route/dns/health never run, failure notice sent', async () => {
      coolify.failCreate(true);
      await promote({ confirm: true });
      await waitForFinal(SLUG);

      const record = promoter.get(SLUG);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('coolify');
      expect(record?.steps.map((s) => s.name)).toEqual(['validate', 'scan', 'repo', 'coolify']);
      const coolifyStep = record?.steps.find((s) => s.name === 'coolify');
      expect(coolifyStep?.ok).toBe(false);
      expect(coolifyStep?.detail).toContain('500');

      // Later steps not run: zero Cloudflare traffic, zero health probes.
      expect(cloudflare.requests).toEqual([]);
      expect(health.requests).toEqual([]);

      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('🚀');
      expect(notices[0]).toContain('FAILED');
      expect(notices[0]).toContain('coolify');
    });
  });
});

describe('scanForSecrets (unit)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightshift-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags every spec filename pattern', () => {
    for (const name of [
      '.env',
      '.env.production',
      'server.pem',
      'apikey.txt',
      'credentials.json',
      'service-account.json',
    ]) {
      writeFileSync(join(dir, name), 'plain');
    }
    const hits = scanForSecrets(dir);
    expect(hits.map((h) => h.file).sort()).toEqual([
      '.env',
      '.env.production',
      'apikey.txt',
      'credentials.json',
      'server.pem',
      'service-account.json',
    ]);
  });

  it('flags obvious token shapes in text content, once per file', () => {
    // gitleaks:allow — deliberate FIXTURE secrets testing our own scanner (AWS docs example key)
    writeFileSync(join(dir, 'a.md'), `token AKIAIOSFODNN7EXAMPLE plus ghp_${'a'.repeat(36)}`); // gitleaks:allow
    writeFileSync(join(dir, 'b.txt'), '-----BEGIN RSA PRIVATE KEY-----\nabc');
    writeFileSync(join(dir, 'c.js'), 'const apiKey = "sk-live-abcdefgh12345678";'); // gitleaks:allow
    const hits = scanForSecrets(dir);
    expect(hits.map((h) => h.file).sort()).toEqual(['a.md', 'b.txt', 'c.js']);
  });

  it('passes clean content, skips binaries and .git', () => {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), 'url = git@github.com:x/y.git');
    writeFileSync(join(dir, 'guide.html'), '<html><body>How subnet masks work</body></html>');
    writeFileSync(join(dir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(scanForSecrets(dir)).toEqual([]);
  });
});

describe('ensureIndexHtml (unit)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightshift-index-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('escapes the title and pretty-prints guide names lacking a <title>', () => {
    mkdirSync(join(dir, 'guides'));
    writeFileSync(join(dir, 'guides', 'chapter-01.html'), '<p>untitled guide</p>');
    const result = ensureIndexHtml(dir, 'Tags & <Angles>', 'study');
    expect(result.generated).toBe(true);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).toContain('Tags &amp; &lt;Angles&gt;');
    expect(html).toContain('>Chapter 01</a>');
  });
});

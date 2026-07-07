/**
 * Site promotion (contracts/site-promotion.md; Stage 13): the testing matrix
 * against the REAL router + site pipeline — external seams only are stubbed
 * (a REAL temp git website repo with a local bare origin, the bun stub behind
 * NIGHTSHIFT_BUN_PATH, a fixture health server); the pipeline logic itself is
 * never stubbed. Routing (study → site steps; story → explicit rejection;
 * the Stage 11 subdomain pipeline UNREACHABLE for study content), dry-run
 * with zero side effects, the 6-step happy path (dark-mode golden, extracted
 * chapter titles, textbook frontmatter), idempotent re-promote, dirty-repo
 * refusal, build-failure abort before push, pull --rebase on push, and the
 * bounded health poll are all proven here.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { PromotionError } from '../src/promotion/index.js';
import { createPromoter, type Promoter } from '../src/promotion/pipeline.js';
import { createPromotionRouter } from '../src/promotion/route.js';
import {
  convertGuideToDarkMode,
  createSitePromoter,
  extractChapterTitle,
  extractTextbookIntro,
  SITE_HEALTH_INTERVAL_MS,
  SITE_HEALTH_RETRIES,
} from '../src/promotion/site.js';
import { createPromotionStore } from '../src/promotion/store.js';
import {
  type CloudflareStub,
  type CoolifyStub,
  type HealthStub,
  MIGRATIONS_DIR,
  makeBunStub,
  makeConfig,
  makeTestLogger,
  makeToolShim,
  makeWebsiteRepo,
  startCloudflareStub,
  startCoolifyStub,
  startHealthStub,
  type WebsiteRepoFixture,
  waitFor,
} from './helpers.js';

const SLUG = 'subnet-study';

/** A guide as the SWS template emits it — light-mode CSS custom properties. */
const LIGHT_GUIDE = `<!doctype html>
<html><head><title>Chapter 1</title><style>
:root {
  --color-bg: #fafafa;
  --color-surface: #ffffff;
  --color-text: #1a1a1a;
  --color-muted: #6b7280;
  --color-primary: #2563eb;
  --color-primary-light: #dbeafe;
  --color-success: #16a34a;
  --color-success-light: #dcfce7;
  --color-error: #dc2626;
  --color-error-light: #fee2e2;
  --color-border: #e5e7eb;
  --color-quiz-bg: #f0f4ff;
  --color-keypoints-bg: #fffbeb;
  --color-keypoints-border: #f59e0b;
  --shadow: 0 1px 3px rgba(0,0,0,0.1);
}
</style></head><body>guide one</body></html>
`;

/** The golden expectation: every one of the reference's 15 swaps applied. */
const DARK_GUIDE = `<!doctype html>
<html><head><title>Chapter 1</title><style>
:root {
  --color-bg: #0a0a0f;
  --color-surface: #1a1d2e;
  --color-text: #e0e0e8;
  --color-muted: #9ca3af;
  --color-primary: #818cf8;
  --color-primary-light: #1e1b4b;
  --color-success: #4ade80;
  --color-success-light: #052e16;
  --color-error: #f87171;
  --color-error-light: #450a0a;
  --color-border: #2a2f42;
  --color-quiz-bg: #12151f;
  --color-keypoints-bg: #1a1700;
  --color-keypoints-border: #d97706;
  --shadow: 0 1px 3px rgba(0,0,0,0.4);
}
</style></head><body>guide one</body></html>
`;

describe('site promotion (router + pipeline)', () => {
  let tmpDir: string;
  let contentDir: string;
  let db: Database.Database;
  let website: WebsiteRepoFixture;
  let bun: ReturnType<typeof makeBunStub>;
  let health: HealthStub;
  let coolify: CoolifyStub;
  let cloudflare: CloudflareStub;
  let shim: ReturnType<typeof makeToolShim>;
  let notices: string[];
  let config: Config;
  let router: Promoter;

  /** Study output as the SWS pipeline leaves it. */
  const seedStudy = (dir: string): void => {
    mkdirSync(join(dir, 'guides'), { recursive: true });
    mkdirSync(join(dir, 'chapters'), { recursive: true });
    writeFileSync(join(dir, 'guides', 'chapter-01.html'), LIGHT_GUIDE);
    writeFileSync(
      join(dir, 'guides', 'chapter-02.html'),
      '<!doctype html><style>:root { --color-bg: #0a0a0f; }</style><p>already dark</p>',
    );
    writeFileSync(
      join(dir, 'chapters', 'chapter-01.md'),
      '## Chapter 1: Subnetting Basics\n\nBody.\n',
    );
    // chapter-02.md deliberately absent — the title falls back to the filename.
    writeFileSync(
      join(dir, 'textbook.md'),
      '# The Subnetting Book\n\nA field guide to carving networks into subnets without tears.\n\nMore prose.\n',
    );
  };

  const promote = (overrides: Partial<Parameters<Promoter['promote']>[0]> = {}) =>
    router.promote({ path: contentDir, confirm: false, ...overrides });

  const statusOf = (slug: string): string | undefined =>
    createPromotionStore(db).getBySlug(slug)?.status;

  const waitForFinal = async (slug: string): Promise<void> => {
    await waitFor(() => statusOf(slug) === 'live' || statusOf(slug) === 'failed');
  };

  const originLog = (): string => website.git(website.originDir, 'log', '--format=%s', 'main');

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-site-'));
    contentDir = join(tmpDir, 'projects', SLUG);
    seedStudy(contentDir);
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    website = makeWebsiteRepo(tmpDir);
    bun = makeBunStub(tmpDir);
    health = await startHealthStub();
    coolify = await startCoolifyStub();
    cloudflare = await startCloudflareStub();
    shim = makeToolShim(tmpDir);
    notices = [];
    config = makeConfig({
      promoteEnabled: true,
      promote: {
        ...makeConfig().promote,
        coolifyApiUrl: coolify.baseUrl,
        cfApiBase: cloudflare.baseUrl,
        healthBase: health.baseUrl,
        websiteRepo: website.repoDir,
        bunPath: bun.bunPath,
      },
    });
    const deps = {
      db,
      log: makeTestLogger(),
      config,
      notify: async (text: string) => {
        notices.push(text);
      },
    };
    // The REAL wiring shape (app.ts): router over the site pipeline and the
    // retained Stage 11 subdomain pipeline. The subdomain promoter gets the
    // git/gh shim + live fixture stubs so ANY reach into it is observable.
    router = createPromotionRouter({
      site: createSitePromoter(deps, {
        home: tmpDir,
        healthRetries: 3,
        healthIntervalMs: 20,
      }),
      subdomain: createPromoter(deps, { home: tmpDir, env: shim.env }),
      home: tmpDir,
    });
  });

  afterEach(async () => {
    db.close();
    await health.close();
    await coolify.close();
    await cloudflare.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('routing (the Stage 13 fix)', () => {
    it('study content plans the SITE pipeline — never the subdomain steps (regression)', async () => {
      const record = await promote(); // dry run
      expect(record.status).toBe('planned');
      expect(record.steps.map((s) => s.name)).toEqual([
        'validate',
        'scan',
        'stage',
        'build',
        'push',
        'health',
      ]);
      expect(record.url).toBe(`https://www.example.test/study-guides/${SLUG}`);
      expect(record.repoUrl).toBe(website.originDir); // the WEBSITE repo's remote
      // The reproduction bug: study content planning repo/coolify/route/dns.
      for (const name of ['repo', 'coolify', 'route', 'dns']) {
        expect(
          record.steps.some((s) => s.name === name),
          name,
        ).toBe(false);
      }
      expect(record.url).not.toContain(`${SLUG}.example.test`);
    });

    it('a confirmed study promotion never touches the subdomain infra (regression)', async () => {
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      // Zero Coolify/Cloudflare traffic, zero gh invocations — the subdomain
      // pipeline was UNREACHABLE for the study content.
      expect(coolify.requests).toEqual([]);
      expect(cloudflare.requests).toEqual([]);
      expect(shim.invocations()).toEqual([]);
    });

    it('story content is rejected EXPLICITLY: "story promotion not yet designed"', async () => {
      const storyDir = join(tmpDir, 'projects', 'brave-turtle');
      mkdirSync(storyDir, { recursive: true });
      writeFileSync(join(storyDir, 'brave-turtle-final.mp4'), 'not-really-video');
      await expect(router.promote({ path: storyDir, confirm: false })).rejects.toThrow(
        /story promotion not yet designed/,
      );
      await expect(router.promote({ path: storyDir, confirm: true })).rejects.toThrow(
        PromotionError,
      );
      expect(statusOf('brave-turtle')).toBeUndefined(); // nothing persisted
    });

    it('unrecognized content and escaping paths are rejected', async () => {
      const empty = join(tmpDir, 'projects', 'mystery');
      mkdirSync(empty, { recursive: true });
      writeFileSync(join(empty, 'whatever.txt'), 'hello');
      await expect(router.promote({ path: empty, confirm: false })).rejects.toThrow(
        /unrecognized content/,
      );
      await expect(router.promote({ path: '/etc', confirm: false })).rejects.toThrow(
        /must live inside/,
      );
      await expect(router.promote({ path: 'relative/dir', confirm: false })).rejects.toThrow(
        /absolute/,
      );
    });

    it('study-shaped content without guides/chapter-NN.html is rejected with the shape error', async () => {
      const textbookOnly = join(tmpDir, 'projects', 'book-only');
      mkdirSync(textbookOnly, { recursive: true });
      writeFileSync(join(textbookOnly, 'textbook.md'), '# Book\n\nText.\n');
      await expect(router.promote({ path: textbookOnly, confirm: false })).rejects.toThrow(
        /guides\/chapter-NN\.html/,
      );
    });
  });

  describe('dry run (the default)', () => {
    it('returns the full site plan (target url, files to write, yaml path) with ZERO side effects', async () => {
      const record = await promote();
      expect(record.status).toBe('planned');
      expect(record.slug).toBe(SLUG);
      const byName = new Map(record.steps.map((s) => [s.name, s.detail]));
      for (const detail of byName.values()) expect(detail).toContain('planned');
      expect(byName.get('stage')).toContain(`public/study-guides/${SLUG}`);
      expect(byName.get('stage')).toContain(`src/content/studyGuides/${SLUG}.yaml`);
      expect(byName.get('stage')).toContain(`src/content/textbooks/${SLUG}.md`);
      expect(byName.get('stage')).toContain('2 guide(s)');
      expect(byName.get('build')).toContain('run build');
      expect(byName.get('health')).toContain(`https://www.example.test/study-guides/${SLUG}`);

      // ZERO side effects: nothing written into the website repo, no git
      // movement, no bun, no health probes.
      expect(existsSync(join(website.repoDir, 'public', 'study-guides', SLUG))).toBe(false);
      expect(
        existsSync(join(website.repoDir, 'src', 'content', 'studyGuides', `${SLUG}.yaml`)),
      ).toBe(false);
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');
      expect(originLog()).toBe('seed website');
      expect(bun.invocations()).toEqual([]);
      expect(health.requests).toEqual([]);

      // ...but the plan IS persisted as 'planned'.
      expect(statusOf(SLUG)).toBe('planned');
    });

    it('a dry run never demotes a live record', async () => {
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      const plan = await promote();
      expect(plan.status).toBe('planned');
      expect(statusOf(SLUG)).toBe('live');
    });
  });

  describe('happy path (confirm:true)', () => {
    it('runs the 6 steps, stages guides/YAML/textbook, builds, pushes, lands live with the 🚀 notice', async () => {
      const running = await promote({ confirm: true, title: 'Subnetting Study' });
      expect(running.status).toBe('running');
      await waitForFinal(SLUG);

      const record = router.get(SLUG);
      expect(record?.status).toBe('live');
      expect(record?.url).toBe(`https://www.example.test/study-guides/${SLUG}`);
      expect(record?.repoUrl).toBe(website.originDir);
      expect(record?.error).toBeNull();
      expect(record?.steps.map((s) => s.name)).toEqual([
        'validate',
        'scan',
        'stage',
        'build',
        'push',
        'health',
      ]);
      for (const step of record?.steps ?? []) expect(step.ok, step.name).toBe(true);

      // Guides copied; the light one dark-converted (GOLDEN), the dark one untouched.
      const deployed = join(website.repoDir, 'public', 'study-guides', SLUG);
      expect(readFileSync(join(deployed, 'chapter-01.html'), 'utf8')).toBe(DARK_GUIDE);
      expect(readFileSync(join(deployed, 'chapter-02.html'), 'utf8')).toContain('already dark');
      const stageStep = record?.steps.find((s) => s.name === 'stage');
      expect(stageStep?.detail).toContain('dark-mode swapped: 1');

      // YAML: extracted chapter title, filename fallback, textbook-intro
      // description, order = existing highest (3) + 1.
      const yaml = readFileSync(
        join(website.repoDir, 'src', 'content', 'studyGuides', `${SLUG}.yaml`),
        'utf8',
      );
      expect(yaml).toContain('title: "Subnetting Study"');
      expect(yaml).toContain(`slug: "${SLUG}"`);
      expect(yaml).toContain(
        'description: "A field guide to carving networks into subnets without tears."',
      );
      expect(yaml).toContain('order: 4');
      expect(yaml).toContain('- title: "Subnetting Basics"'); // from chapters/chapter-01.md
      expect(yaml).toContain('htmlFile: "chapter-01.html"');
      expect(yaml).toContain('- title: "chapter-02"'); // no md → filename fallback
      expect(yaml).toContain('htmlFile: "chapter-02.html"');

      // Textbook companion: frontmatter title from the H1, slug wiring, body intact.
      const textbook = readFileSync(
        join(website.repoDir, 'src', 'content', 'textbooks', `${SLUG}.md`),
        'utf8',
      );
      expect(textbook.startsWith('---\ntitle: "The Subnetting Book"\n')).toBe(true);
      expect(textbook).toContain(`studyGuideSlug: "${SLUG}"`);
      expect(textbook).toContain('# The Subnetting Book');

      // Build ran through the BUN seam before anything was pushed.
      expect(bun.invocations()).toContain('bun run build');

      // Pushed: origin advanced with the reference-shaped commit message; the
      // pre-existing guide survived (shared-repo safety).
      expect(originLog().split('\n')[0]).toBe('Add Subnetting Study study guide (2 chapters)');
      expect(
        website.git(
          website.originDir,
          'ls-tree',
          '--name-only',
          'main',
          'src/content/studyGuides/',
        ),
      ).toContain('existing.yaml');
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');

      // Health polled the seam target; the 🚀 notice carries the www URL.
      expect(health.requests.length).toBeGreaterThan(0);
      expect(health.requests[0]?.path).toBe(`/study-guides/${SLUG}`);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('🚀');
      expect(notices[0]).toContain(`https://www.example.test/study-guides/${SLUG}`);
    });

    it('re-promote is idempotent: same row/id, same order, files overwritten, no refusal', async () => {
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const first = router.get(SLUG);
      expect(first?.status).toBe('live');

      // Content evolves between promotes.
      writeFileSync(
        join(contentDir, 'guides', 'chapter-02.html'),
        '<!doctype html><p>revised two</p>',
      );
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const second = router.get(SLUG);
      expect(second?.status).toBe('live');
      expect(second?.id).toBe(first?.id); // same record, updated in place

      const rows = db.prepare('SELECT COUNT(*) AS n FROM promotions WHERE slug = ?').get(SLUG) as {
        n: number;
      };
      expect(rows.n).toBe(1);

      // Overwritten in place: revised guide deployed, order KEPT (not bumped).
      const deployed = join(website.repoDir, 'public', 'study-guides', SLUG);
      expect(readFileSync(join(deployed, 'chapter-02.html'), 'utf8')).toContain('revised two');
      const yaml = readFileSync(
        join(website.repoDir, 'src', 'content', 'studyGuides', `${SLUG}.yaml`),
        'utf8',
      );
      expect(yaml).toContain('order: 4');
      // Two pushes landed on origin.
      expect(
        originLog()
          .split('\n')
          .filter((l) => l.startsWith('Add ')).length,
      ).toBe(2);
    });

    it('push pulls --rebase first: remote drift before AND during the build is integrated', async () => {
      // Drift 1 — BEFORE the promote (stage-step pull --rebase must fetch it).
      const clone = join(tmpDir, 'other-clone');
      website.git(tmpDir, 'clone', website.originDir, clone);
      writeFileSync(join(clone, 'manual-edit.md'), 'an operator edit\n');
      website.git(clone, 'add', '-A');
      website.git(
        clone,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=T',
        'commit',
        '-m',
        'manual edit',
      );
      website.git(clone, 'push', 'origin', 'main');

      // Drift 2 — DURING the build (push-step pull --rebase must integrate it):
      // the bun stub executes bun-hook between stage and push.
      const hookClone = join(tmpDir, 'hook-clone');
      writeFileSync(
        join(tmpDir, 'bun-hook'),
        [
          '#!/bin/sh',
          `git clone "${website.originDir}" "${hookClone}" 2>/dev/null`,
          `echo drift > "${hookClone}/drift-during-build.md"`,
          `git -C "${hookClone}" add -A`,
          `git -C "${hookClone}" -c user.email=t@t -c user.name=T commit -m "drift during build" -q`,
          `git -C "${hookClone}" push origin main -q`,
          `rm -f "${join(tmpDir, 'bun-hook')}"`, // once only — the retry build must not re-drift
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');

      // Everything integrated: both drift commits + ours are on origin, and
      // the local clone holds all three files.
      const log = originLog();
      expect(log).toContain('manual edit');
      expect(log).toContain('drift during build');
      expect(log).toContain('study guide');
      expect(existsSync(join(website.repoDir, 'manual-edit.md'))).toBe(true);
      expect(existsSync(join(website.repoDir, 'drift-during-build.md'))).toBe(true);
    });

    it('retries the health check until 200 within the bound; contract defaults are 20 × 15s', async () => {
      health.failFirst(2); // 3 retries configured — the third GET succeeds
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      const healthStep = router.get(SLUG)?.steps.find((s) => s.name === 'health');
      expect(healthStep?.detail).toContain('attempt 3/3');
      expect(SITE_HEALTH_RETRIES).toBe(20);
      expect(SITE_HEALTH_INTERVAL_MS).toBe(15_000);
    });

    it('a never-healthy target fails the run at health after the bound', async () => {
      health.failFirst(1000);
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const record = router.get(SLUG);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('health');
      expect(record?.steps.find((s) => s.name === 'health')?.detail).toContain('after 3 attempts');
    });
  });

  describe('shared-repo safety', () => {
    it('refuses a DIRTY website repo before writing anything, naming the files', async () => {
      writeFileSync(join(website.repoDir, 'work-in-progress.md'), 'manual edit underway\n');
      await promote({ confirm: true });
      await waitForFinal(SLUG);

      const record = router.get(SLUG);
      expect(record?.status).toBe('failed');
      const stageStep = record?.steps.find((s) => s.name === 'stage');
      expect(stageStep?.ok).toBe(false);
      expect(stageStep?.detail).toContain('uncommitted changes');
      expect(stageStep?.detail).toContain('work-in-progress.md');

      // NOTHING was written or built; the operator's file is untouched.
      expect(existsSync(join(website.repoDir, 'public', 'study-guides', SLUG))).toBe(false);
      expect(bun.invocations()).toEqual([]);
      expect(originLog()).toBe('seed website');
      expect(readFileSync(join(website.repoDir, 'work-in-progress.md'), 'utf8')).toContain(
        'manual edit underway',
      );
      expect(notices[0]).toContain('FAILED');
      expect(notices[0]).toContain('stage');
    });

    it('a failing build ABORTS before push and rolls the staged changes back', async () => {
      writeFileSync(join(tmpDir, 'bun-fail'), '');
      await promote({ confirm: true });
      await waitForFinal(SLUG);

      const record = router.get(SLUG);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('build');
      const buildStep = record?.steps.find((s) => s.name === 'build');
      expect(buildStep?.ok).toBe(false);
      expect(buildStep?.detail).toContain('injected build failure');
      expect(record?.steps.some((s) => s.name === 'push')).toBe(false); // never reached

      // A broken site never ships: origin untouched, repo rolled back clean.
      expect(originLog()).toBe('seed website');
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(website.repoDir, 'public', 'study-guides', SLUG))).toBe(false);
      expect(health.requests).toEqual([]);
      expect(notices[0]).toContain('FAILED');
      expect(notices[0]).toContain('build');
    });

    it('secret scan aborts BEFORE any repo write', async () => {
      writeFileSync(join(contentDir, '.env'), 'SECRET=hunter2-hunter2-hunter2\n');
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const record = router.get(SLUG);
      expect(record?.status).toBe('failed');
      expect(record?.steps.map((s) => s.name)).toEqual(['validate', 'scan']);
      expect(record?.steps.find((s) => s.name === 'scan')?.detail).toContain('.env');
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');
      expect(bun.invocations()).toEqual([]);
    });

    it('retry clears the Astro 5 data store (node_modules/.astro) — 2026-07-07 incident', async () => {
    // Simulate the live failure: a stale content-layer store makes the first
    // build render nothing for the new slug; only clearing node_modules/.astro
    // lets the retry succeed. Old code cleared repo/.astro only and failed here.
    mkdirSync(join(website.repoDir, 'node_modules', '.astro'), { recursive: true });
    writeFileSync(join(website.repoDir, 'node_modules', '.astro', 'data-store.json'), '{}');
    writeFileSync(join(tmpDir, 'bun-stale-store'), '');
    await promote({ confirm: true });
    await waitForFinal(SLUG);
    expect(statusOf(SLUG)).toBe('live');
    expect(existsSync(join(website.repoDir, 'node_modules', '.astro'))).toBe(false);
    const builds = bun.invocations().filter((l) => l.includes('run build'));
    expect(builds.length).toBe(2); // first build blind, retry after the clear
  });

  it('rejects a second confirm while the slug is already running', async () => {
      health.failFirst(2); // slow the first run down a little
      await promote({ confirm: true });
      await expect(promote({ confirm: true })).rejects.toThrow(/already running/);
      await waitForFinal(SLUG);
    });
  });

  describe('validate', () => {
    it('rejects when the website repo is missing or not a git clone', async () => {
      rmSync(join(website.repoDir, '.git'), { recursive: true, force: true });
      await expect(promote()).rejects.toThrow(/not a git clone/);
    });

    it('slug derivation strips the sws- prefix and normalizes; overrides honored', async () => {
      const swsDir = join(tmpDir, 'projects', 'sws-ccie-automation');
      seedStudy(swsDir);
      const derived = await router.promote({ path: swsDir, confirm: false });
      expect(derived.slug).toBe('ccie-automation');
      const overridden = await router.promote({
        path: swsDir,
        slug: 'My Fancy Slug!',
        title: 'Custom Title',
        confirm: false,
      });
      expect(overridden.slug).toBe('my-fancy-slug');
      expect(overridden.title).toBe('Custom Title');
      expect(overridden.url).toBe('https://www.example.test/study-guides/my-fancy-slug');
    });
  });
});

describe('dark-mode conversion (golden unit)', () => {
  it('applies every reference swap when the light-mode marker is present', () => {
    const result = convertGuideToDarkMode(LIGHT_GUIDE);
    expect(result.swapped).toBe(true);
    expect(result.html).toBe(DARK_GUIDE);
  });

  it('leaves already-dark or non-templated HTML byte-identical', () => {
    for (const html of [DARK_GUIDE, '<p>no custom properties at all</p>']) {
      const result = convertGuideToDarkMode(html);
      expect(result.swapped).toBe(false);
      expect(result.html).toBe(html);
    }
  });
});

describe('extraction helpers (unit)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightshift-extract-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extractChapterTitle strips the Chapter N prefix and falls back to plain headings', () => {
    const chapterMd = join(dir, 'a.md');
    writeFileSync(chapterMd, '## Chapter 12: VLSM in Practice\n\nBody\n');
    expect(extractChapterTitle(chapterMd)).toBe('VLSM in Practice');
    writeFileSync(chapterMd, '# Plain Title\n');
    expect(extractChapterTitle(chapterMd)).toBe('Plain Title');
    expect(extractChapterTitle(join(dir, 'missing.md'))).toBeNull();
  });

  it('extractTextbookIntro returns the first paragraph after the H1, flattened and capped', () => {
    const book = join(dir, 'textbook.md');
    writeFileSync(book, '# Title\n\n> a quote to skip\n\nFirst real\nparagraph here.\n\nSecond.\n');
    expect(extractTextbookIntro(book)).toBe('First real paragraph here.');
    writeFileSync(book, `# Title\n\n${'word '.repeat(100).trim()}\n`);
    const capped = extractTextbookIntro(book);
    expect(capped.length).toBeLessThanOrEqual(320);
    expect(capped.endsWith('…')).toBe(true);
    expect(extractTextbookIntro(join(dir, 'missing.md'))).toBe('');
  });
});

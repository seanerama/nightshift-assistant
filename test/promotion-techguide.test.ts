/**
 * Techguide promotion (contracts/site-promotion.md v1.1; Stage 17): the
 * matrix against the REAL router + site pipeline — external seams only are
 * stubbed (temp git website repo with a local bare origin, the bun stub, the
 * health fixture server). Proven here: detection PRECEDENCE (the techguide
 * marker beats residual sws artifacts in the same workdir — the misroute
 * hazard), layout detect (single vs hub vs malformed → validate error, never
 * guess), the guides YAML shape (title/slug/description/htmlFile/order with
 * next-free order allocation and order KEPT on re-promote), the dark-mode
 * guard (light palette converted, dark-native untouched), and the
 * CONTENT-asserting health check: follows redirects and passes only when the
 * body carries the staged <title> — a soft-404 200 body must FAIL.
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
import { createSitePromoter } from '../src/promotion/site.js';
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

const SLUG = 'git-bisect-basics';
const HUB_TITLE = 'Git Bisect — Field Guide';

/** tg output is dark-native: its own palette, no light marker — never touched. */
const DARK_NATIVE_INDEX = `<!doctype html>
<html><head><title>${HUB_TITLE}</title><style>
:root { --color-bg: #0a0a0f; --color-text: #e0e0e8; }
</style></head><body><h1>Hub</h1><a href="section-01-intro.html">Intro</a></body></html>
`;

/** A light-palette page (the standard marker) — the dark-mode guard must convert it. */
const LIGHT_SECTION = `<!doctype html>
<html><head><title>Intro</title><style>
:root { --color-bg: #fafafa; --color-text: #1a1a1a; }
</style></head><body>section one</body></html>
`;

const DARK_SECTION =
  '<!doctype html><html><head><title>Practice</title><style>:root { --color-bg: #0a0a0f; }</style></head><body>section two</body></html>\n';

/** A live body carrying the staged guide <title> — what a healthy deploy serves. */
const LIVE_BODY = `<!doctype html><html><head><title>${HUB_TITLE}</title></head><body>live</body></html>`;

describe('techguide promotion (router + site pipeline, Stage 17)', () => {
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

  /** Techguide output as the /tg pipeline leaves it (multi-page hub). */
  const seedTechguideHub = (dir: string): void => {
    mkdirSync(join(dir, 'guide'), { recursive: true });
    writeFileSync(
      join(dir, 'techguide-config.json'),
      JSON.stringify({
        topic: 'git bisect basics',
        variant: 'explainer',
        description: 'Find the exact commit that broke your build.',
      }),
    );
    writeFileSync(join(dir, 'guide', 'index.html'), DARK_NATIVE_INDEX);
    writeFileSync(join(dir, 'guide', 'section-01-intro.html'), LIGHT_SECTION);
    writeFileSync(join(dir, 'guide', 'section-02-practice.html'), DARK_SECTION);
  };

  /** Single-page techguide; config carries NO description (generated fallback). */
  const seedTechguideSingle = (dir: string): void => {
    mkdirSync(join(dir, 'guide'), { recursive: true });
    writeFileSync(join(dir, 'techguide-config.json'), JSON.stringify({ topic: 'one pager' }));
    writeFileSync(join(dir, 'guide', 'index.html'), LIGHT_SECTION.replace('Intro', 'One Pager'));
  };

  const promote = (overrides: Partial<Parameters<Promoter['promote']>[0]> = {}) =>
    router.promote({ path: contentDir, confirm: false, ...overrides });

  const statusOf = (slug: string): string | undefined =>
    createPromotionStore(db).getBySlug(slug)?.status;

  const waitForFinal = async (slug: string): Promise<void> => {
    await waitFor(() => statusOf(slug) === 'live' || statusOf(slug) === 'failed');
  };

  const originLog = (): string => website.git(website.originDir, 'log', '--format=%s', 'main');

  const readYaml = (): string =>
    readFileSync(join(website.repoDir, 'src', 'content', 'guides', `${SLUG}.yaml`), 'utf8');

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-techguide-'));
    contentDir = join(tmpDir, 'projects', SLUG);
    seedTechguideHub(contentDir);
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
    // retained Stage 11 subdomain pipeline — any reach into it is observable.
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

  describe('detection precedence (the misroute hazard)', () => {
    it('BOTH markers present: the techguide marker beats residual sws artifacts (regression)', async () => {
      // The tg skill is an sws fork — a tg workdir has been observed holding
      // chapters/ + guides/ + textbook.md mid-run. Study detection must never
      // capture it: wrong URL namespace + wrong YAML collection.
      mkdirSync(join(contentDir, 'guides'), { recursive: true });
      mkdirSync(join(contentDir, 'chapters'), { recursive: true });
      writeFileSync(join(contentDir, 'guides', 'chapter-01.html'), '<p>residual sws</p>');
      writeFileSync(join(contentDir, 'chapters', 'chapter-01.md'), '## Chapter 1: Residual\n');
      writeFileSync(join(contentDir, 'textbook.md'), '# Residual Book\n');

      const record = await promote(); // dry run
      expect(record.status).toBe('planned');
      expect(record.url).toBe(`https://www.example.test/guides/${SLUG}`);
      expect(record.url).not.toContain('study-guides');
      const byName = new Map(record.steps.map((s) => [s.name, s.detail]));
      expect(byName.get('validate')).toContain('techguide content');
      expect(byName.get('stage')).toContain(`public/guides/${SLUG}`);
      expect(byName.get('stage')).toContain(`src/content/guides/${SLUG}.yaml`);
      expect(byName.get('stage')).not.toContain('studyGuides');
    });

    it('study-only content still routes study (byte-identical Stage 13 behavior)', async () => {
      const studyDir = join(tmpDir, 'projects', 'plain-study');
      mkdirSync(join(studyDir, 'guides'), { recursive: true });
      writeFileSync(join(studyDir, 'guides', 'chapter-01.html'), '<p>one</p>');
      const record = await router.promote({ path: studyDir, confirm: false });
      expect(record.url).toBe('https://www.example.test/study-guides/plain-study');
    });

    it('guide/index.html WITHOUT the marker IS a techguide — netclaw regression (#43)', async () => {
      // The 2026-07-22 live failure: the tg skill wrote config.json (the sws
      // name) but never techguide-config.json; the artifact is the contract.
      const netclawDir = join(tmpDir, 'projects', 'netclaw-shape');
      mkdirSync(join(netclawDir, 'guide'), { recursive: true });
      writeFileSync(
        join(netclawDir, 'config.json'),
        JSON.stringify({ topic: 'netclaw', description: 'From the sws-named config.' }),
      );
      writeFileSync(join(netclawDir, 'guide', 'index.html'), DARK_NATIVE_INDEX);
      const plan = await router.promote({ path: netclawDir, confirm: false });
      expect(plan.status).toBe('planned');
      expect(plan.url).toContain('/guides/netclaw-shape');
      health.setBody(
        '<!doctype html><html><head><title>Git Bisect — Field Guide</title></head><body>live</body></html>',
      );
      await router.promote({ path: netclawDir, confirm: true });
      await waitForFinal('netclaw-shape');
      expect(statusOf('netclaw-shape')).toBe('live');
      // Description fell back to config.json (marker absent, not generated).
      const yaml = readFileSync(
        join(website.repoDir, 'src', 'content', 'guides', 'netclaw-shape.yaml'),
        'utf8',
      );
      expect(yaml).toContain('From the sws-named config.');
    });

    it('techguide-config.json WITHOUT guide/index.html is not a techguide', async () => {
      const halfDir = join(tmpDir, 'projects', 'half-guide');
      mkdirSync(halfDir, { recursive: true });
      writeFileSync(join(halfDir, 'techguide-config.json'), '{}');
      await expect(router.promote({ path: halfDir, confirm: false })).rejects.toThrow(
        /unrecognized content/,
      );
    });

    it('the unrecognized error now names BOTH accepted shapes', async () => {
      const empty = join(tmpDir, 'projects', 'mystery');
      mkdirSync(empty, { recursive: true });
      const rejection = router.promote({ path: empty, confirm: false });
      await expect(rejection).rejects.toThrow(/guides\/chapter-NN\.html or textbook\.md/);
      await router
        .promote({ path: empty, confirm: false })
        .catch((err: unknown) => expect((err as Error).message).toContain('guide/index.html'));
    });
  });

  describe('layout detect', () => {
    it('index.html alone → SINGLE PAGE: public/guides/<slug>.html and a .html URL', async () => {
      const singleDir = join(tmpDir, 'projects', 'one-pager');
      seedTechguideSingle(singleDir);
      const record = await router.promote({ path: singleDir, confirm: false });
      expect(record.url).toBe('https://www.example.test/guides/one-pager.html');
      const byName = new Map(record.steps.map((s) => [s.name, s.detail]));
      expect(byName.get('stage')).toContain(join('public', 'guides', 'one-pager.html'));
    });

    it('index.html + section-NN*.html → HUB: public/guides/<slug>/ and a clean URL', async () => {
      const record = await promote();
      expect(record.url).toBe(`https://www.example.test/guides/${SLUG}`);
      const byName = new Map(record.steps.map((s) => [s.name, s.detail]));
      expect(byName.get('validate')).toContain('hub, 3 page(s)');
    });

    it('any other guide/ shape is a validate error — never guessed', async () => {
      writeFileSync(join(contentDir, 'guide', 'appendix.html'), '<p>stray</p>');
      await expect(promote()).rejects.toThrow(/unrecognized guide\/ layout/);
      await expect(promote()).rejects.toThrow(/appendix\.html/);
      await expect(promote({ confirm: true })).rejects.toThrow(PromotionError);
      expect(statusOf(SLUG)).toBeUndefined(); // nothing persisted
    });

    it('a guide/index.html without a <title> is rejected (the health needle)', async () => {
      writeFileSync(
        join(contentDir, 'guide', 'index.html'),
        '<!doctype html><body>no title</body>',
      );
      await expect(promote()).rejects.toThrow(/no <title> in guide\/index\.html/);
    });
  });

  describe('dry run (the default)', () => {
    it('returns the full techguide plan with ZERO side effects', async () => {
      const record = await promote();
      expect(record.status).toBe('planned');
      expect(record.slug).toBe(SLUG);
      expect(record.repoUrl).toBe(website.originDir);
      expect(record.steps.map((s) => s.name)).toEqual([
        'validate',
        'scan',
        'stage',
        'build',
        'push',
        'health',
      ]);
      const byName = new Map(record.steps.map((s) => [s.name, s.detail]));
      for (const detail of byName.values()) expect(detail).toContain('planned');
      expect(byName.get('health')).toContain('following redirects');
      expect(byName.get('health')).toContain('staged <title>');

      // ZERO side effects: no repo writes, no git movement, no bun, no HTTP.
      expect(existsSync(join(website.repoDir, 'public', 'guides', SLUG))).toBe(false);
      expect(existsSync(join(website.repoDir, 'src', 'content', 'guides', `${SLUG}.yaml`))).toBe(
        false,
      );
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');
      expect(originLog()).toBe('seed website');
      expect(bun.invocations()).toEqual([]);
      expect(health.requests).toEqual([]);
      expect(statusOf(SLUG)).toBe('planned');
    });
  });

  describe('happy path (confirm:true)', () => {
    it('stages the hub, writes the guides YAML (order = next free), builds, pushes, lands live', async () => {
      health.setBody(LIVE_BODY);
      const running = await promote({ confirm: true });
      expect(running.status).toBe('running');
      await waitForFinal(SLUG);

      const record = router.get(SLUG);
      expect(record?.status).toBe('live');
      expect(record?.url).toBe(`https://www.example.test/guides/${SLUG}`);
      expect(record?.error).toBeNull();
      for (const step of record?.steps ?? []) expect(step.ok, step.name).toBe(true);

      // Hub copied; the dark-native pages byte-identical (the guard's "don't
      // fight a design it already has"), the light section converted.
      const deployed = join(website.repoDir, 'public', 'guides', SLUG);
      expect(readFileSync(join(deployed, 'index.html'), 'utf8')).toBe(DARK_NATIVE_INDEX);
      expect(readFileSync(join(deployed, 'section-02-practice.html'), 'utf8')).toBe(DARK_SECTION);
      const converted = readFileSync(join(deployed, 'section-01-intro.html'), 'utf8');
      expect(converted).toContain('--color-bg: #0a0a0f');
      expect(converted).not.toContain('#fafafa');
      const stageStep = record?.steps.find((s) => s.name === 'stage');
      expect(stageStep?.detail).toContain('dark-mode swapped: 1');

      // The guides content entry, exactly the reference shape (2ba563e):
      // title from the guide <title>, description from techguide-config.json,
      // htmlFile pointing at the hub, order = existing highest (7) + 1.
      expect(readYaml()).toBe(
        [
          `title: "${HUB_TITLE}"`,
          `slug: "${SLUG}"`,
          'description: "Find the exact commit that broke your build."',
          `htmlFile: "${SLUG}/index.html"`,
          'order: 8',
          '',
        ].join('\n'),
      );

      // Built through the bun seam, pushed with the reference commit subject,
      // and the pre-existing guide survived (shared-repo safety).
      expect(bun.invocations()).toContain('bun run build');
      expect(originLog().split('\n')[0]).toBe(`Add ${HUB_TITLE} technical guide`);
      expect(
        website.git(website.originDir, 'ls-tree', '--name-only', 'main', 'src/content/guides/'),
      ).toContain('existing-guide.yaml');
      expect(website.git(website.repoDir, 'status', '--porcelain')).toBe('');

      // Health probed /guides/<slug> and the 🚀 notice carries the guides URL.
      expect(health.requests[0]?.path).toBe(`/guides/${SLUG}`);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('🚀');
      expect(notices[0]).toContain(`https://www.example.test/guides/${SLUG}`);

      // The subdomain pipeline stayed unreachable: zero infra traffic.
      expect(coolify.requests).toEqual([]);
      expect(cloudflare.requests).toEqual([]);
      expect(shim.invocations()).toEqual([]);
    });

    it('single page: converted into public/guides/<slug>.html with a generated description', async () => {
      const singleDir = join(tmpDir, 'projects', 'one-pager');
      seedTechguideSingle(singleDir);
      health.setBody('<title>One Pager</title>');
      await router.promote({ path: singleDir, confirm: true });
      await waitForFinal('one-pager');
      expect(statusOf('one-pager')).toBe('live');

      const page = readFileSync(
        join(website.repoDir, 'public', 'guides', 'one-pager.html'),
        'utf8',
      );
      expect(page).toContain('--color-bg: #0a0a0f'); // light palette converted
      const yaml = readFileSync(
        join(website.repoDir, 'src', 'content', 'guides', 'one-pager.yaml'),
        'utf8',
      );
      expect(yaml).toContain('title: "One Pager"');
      expect(yaml).toContain('htmlFile: "one-pager.html"');
      expect(yaml).toContain('description: "Technical guide on One Pager."'); // generated
      expect(health.requests[0]?.path).toBe('/guides/one-pager.html');
    });

    it('re-promote is idempotent: same row/id, order KEPT even after later entries land', async () => {
      health.setBody(LIVE_BODY);
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const first = router.get(SLUG);
      expect(first?.status).toBe('live');
      expect(readYaml()).toContain('order: 8');

      // The collection grows between promotes (another guide lands at 12) —
      // a re-promote must KEEP order 8, not re-allocate max+1.
      writeFileSync(
        join(website.repoDir, 'src', 'content', 'guides', 'zz-later.yaml'),
        'title: "Later"\nslug: "zz-later"\ndescription: "d"\nhtmlFile: "zz-later.html"\norder: 12\n',
      );
      writeFileSync(join(website.repoDir, 'public', 'guides', 'zz-later.html'), '<p>l</p>');
      website.git(website.repoDir, 'add', '-A');
      website.git(website.repoDir, 'commit', '-m', 'another guide');
      website.git(website.repoDir, 'push', 'origin', 'main');

      // Content evolves too.
      writeFileSync(
        join(contentDir, 'guide', 'section-02-practice.html'),
        '<!doctype html><p>revised practice</p>',
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

      expect(readYaml()).toContain('order: 8'); // kept, NOT bumped to 13
      expect(
        readFileSync(
          join(website.repoDir, 'public', 'guides', SLUG, 'section-02-practice.html'),
          'utf8',
        ),
      ).toContain('revised practice');
      expect(
        originLog()
          .split('\n')
          .filter((l) => l.endsWith('technical guide')).length,
      ).toBe(2);
    });
  });

  describe('content-asserting health (the soft-404 trap)', () => {
    it('a bare 200 body WITHOUT the staged title FAILS the run after the bound', async () => {
      // The stub's default body is exactly the host's soft-404 shape: a 200
      // page that is not the guide. The old status-only check would pass here.
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const record = router.get(SLUG);
      expect(record?.status).toBe('failed');
      const healthStep = record?.steps.find((s) => s.name === 'health');
      expect(healthStep?.ok).toBe(false);
      expect(healthStep?.detail).toContain(`staged <title> "${HUB_TITLE}"`);
      expect(healthStep?.detail).toContain('soft-404');
      expect(healthStep?.detail).toContain('after 3 attempts');
      expect(health.requests.length).toBe(3); // it kept retrying — 200 never satisfied it
      expect(notices[0]).toContain('FAILED');
    });

    it('follows the host 308 redirect to the clean URL and asserts the title there', async () => {
      health.redirect(`/guides/${SLUG}`, `/guides/${SLUG}/`);
      health.setBody(LIVE_BODY);
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      const record = router.get(SLUG);
      expect(record?.status).toBe('live');
      expect(record?.steps.find((s) => s.name === 'health')?.detail).toContain(
        'carrying the staged <title>',
      );
      // Both hops observed: the 308 source and the redirect target.
      const paths = health.requests.map((r) => r.path);
      expect(paths).toContain(`/guides/${SLUG}`);
      expect(paths).toContain(`/guides/${SLUG}/`);
    });

    it('retries through 503s until the title-bearing 200 arrives', async () => {
      health.failFirst(2);
      health.setBody(LIVE_BODY);
      await promote({ confirm: true });
      await waitForFinal(SLUG);
      expect(statusOf(SLUG)).toBe('live');
      expect(router.get(SLUG)?.steps.find((s) => s.name === 'health')?.detail).toContain(
        'attempt 3/3',
      );
    });
  });
});

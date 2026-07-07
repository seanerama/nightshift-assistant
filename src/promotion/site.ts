/**
 * Website promotion pipeline (contracts/site-promotion.md v1, frozen): deploy
 * study output INTO the existing Astro website repo so it lands at
 * https://www.<NSAF_DOMAIN>/study-guides/<slug> — the Stage 13 fix for the
 * mis-specified Stage 11 behavior (study content must never get a per-study
 * subdomain).
 *
 * Ported from the old NSAF reference (flask-app/bot/commands.py:
 * _promote_study + its helpers, and deploy-study-guides.md): the dark-mode
 * CSS variable swaps, chapter-title extraction from chapters/chapter-NN.md,
 * the studyGuides YAML shape (title/slug/description/order/chapters), the
 * textbook frontmatter (title + studyGuideSlug), the bun build with the
 * stale-cache retry + git rollback, and the pull-rebase-then-push flow on the
 * shared repo. Where the reference and the contract disagree the contract
 * wins: re-promoting a slug OVERWRITES the same files (idempotent) instead of
 * refusing, and a bounded health poll (default 20 × 15s, sized for the host's
 * auto-deploy latency) closes the run.
 *
 * Gating: identical to pipeline.ts — confirm:false → DRY RUN (the 6 planned
 * steps are returned and persisted 'planned'; NOTHING executes: no repo
 * writes, no git, no bun, no HTTP). confirm:true → 'running' returned
 * immediately, the pipeline continues in the BACKGROUND, and completion/
 * failure lands as a 🚀 notice. Each step is recorded { name, ok, detail };
 * the first failure persists 'failed' + error and stops the run.
 *
 * Safety on the SHARED repo (manual edits happen there): refuse a dirty
 * website repo before writing anything (naming the files), pull --rebase
 * before staging AND again before push, and the build must pass locally
 * before anything is committed/pushed — a broken site never ships. Build
 * failures roll the repo back (reset --hard + clean -fd is safe exactly
 * because the tree was verified clean first).
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promotionFailureNotice, promotionLiveNotice } from '../notices.js';
import type { PromoteRequest, PromotionRecord, PromotionStep } from '../types.js';
import { confineToProjects, PromotionError, slugify, titleFromSlug } from './index.js';
import type { Promoter, PromoterDeps } from './pipeline.js';
import { scanForSecrets } from './scan.js';
import { createPromotionStore, type PromotionStore } from './store.js';

/** The contract's fixed step order (site-promotion.md "Schema / wire"). */
export const SITE_STEP_NAMES = ['validate', 'scan', 'stage', 'build', 'push', 'health'] as const;

/** Contract default: bounded wait sized for the host's auto-deploy latency. */
export const SITE_HEALTH_RETRIES = 20;
export const SITE_HEALTH_INTERVAL_MS = 15_000;

const FETCH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 300_000; // the reference's 5-minute bun bound
const MAX_LISTED_HITS = 10;

/**
 * The reference's _STUDY_GUIDE_DARK_MODE_SWAPS, verbatim: the CSS custom
 * properties the SWS guide template emits in light mode → the site's dark
 * palette. Applied only when the light-mode marker (--color-bg: #fafafa) is
 * present; already-dark guides copy through untouched.
 */
const DARK_MODE_SWAPS: ReadonlyArray<readonly [string, string]> = [
  ['--color-bg: #fafafa', '--color-bg: #0a0a0f'],
  ['--color-surface: #ffffff', '--color-surface: #1a1d2e'],
  ['--color-text: #1a1a1a', '--color-text: #e0e0e8'],
  ['--color-muted: #6b7280', '--color-muted: #9ca3af'],
  ['--color-primary: #2563eb', '--color-primary: #818cf8'],
  ['--color-primary-light: #dbeafe', '--color-primary-light: #1e1b4b'],
  ['--color-success: #16a34a', '--color-success: #4ade80'],
  ['--color-success-light: #dcfce7', '--color-success-light: #052e16'],
  ['--color-error: #dc2626', '--color-error: #f87171'],
  ['--color-error-light: #fee2e2', '--color-error-light: #450a0a'],
  ['--color-border: #e5e7eb', '--color-border: #2a2f42'],
  ['--color-quiz-bg: #f0f4ff', '--color-quiz-bg: #12151f'],
  ['--color-keypoints-bg: #fffbeb', '--color-keypoints-bg: #1a1700'],
  ['--color-keypoints-border: #f59e0b', '--color-keypoints-border: #d97706'],
  ['--shadow: 0 1px 3px rgba(0,0,0,0.1)', '--shadow: 0 1px 3px rgba(0,0,0,0.4)'],
];

/** Light-mode marker (the reference's guard): swap only when present. */
const LIGHT_MODE_MARKER = '--color-bg: #fafafa';

/**
 * Dark-mode CSS conversion (deploy-study-guides.md step 4). Exported for the
 * golden test. Returns the converted HTML and whether a swap happened.
 */
export function convertGuideToDarkMode(html: string): { html: string; swapped: boolean } {
  if (!html.includes(LIGHT_MODE_MARKER)) return { html, swapped: false };
  let out = html;
  for (const [light, dark] of DARK_MODE_SWAPS) {
    out = out.replaceAll(light, dark);
  }
  return { html: out, swapped: true };
}

/**
 * First '## Chapter N: Title' (or plain '# Title') heading in the first 20
 * lines of a chapter md — the reference's _extract_chapter_title.
 */
export function extractChapterTitle(mdPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(mdPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n', 20)) {
    const m = /^#{1,3}\s*(?:Chapter\s*\d+\s*[:-]\s*)?(.+?)\s*$/.exec(line);
    const title = m?.[1]?.trim();
    if (title !== undefined && title !== '') return title;
  }
  return null;
}

/**
 * First non-empty paragraph after the H1 in textbook.md, flattened to one
 * line and trimmed to max_len — the reference's _extract_textbook_intro.
 */
export function extractTextbookIntro(textbookPath: string, maxLen = 320): string {
  let text: string;
  try {
    text = readFileSync(textbookPath, 'utf8');
  } catch {
    return '';
  }
  const afterH1 = text.split(/^#\s+.+$/m);
  const body = afterH1.length >= 2 ? afterH1.slice(1).join('') : text;
  for (const block of body.trim().split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('>')) continue;
    let para = trimmed.replaceAll(/\s+/g, ' ').trim();
    if (para.length > maxLen) {
      para = `${para
        .slice(0, maxLen - 1)
        .split(' ')
        .slice(0, -1)
        .join(' ')}…`;
    }
    return para;
  }
  return '';
}

/** Minimal YAML double-quoted escape — the reference's _yaml_quote. */
function yamlQuote(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Next `order:` for a new studyGuides YAML entry (highest existing + 1) —
 * the reference's _next_study_guide_order.
 */
function nextStudyGuideOrder(yamlDir: string): number {
  let highest = 0;
  if (existsSync(yamlDir)) {
    for (const name of readdirSync(yamlDir)) {
      if (!name.endsWith('.yaml')) continue;
      try {
        const text = readFileSync(join(yamlDir, name), 'utf8');
        const m = /^order:\s*(\d+)/m.exec(text);
        if (m !== null) highest = Math.max(highest, Number.parseInt(m[1] as string, 10));
      } catch {
        // Unreadable YAML — skip; the build step is the real validator.
      }
    }
  }
  return highest + 1;
}

/** `order:` already recorded in this slug's YAML (idempotent re-promote keeps it). */
function existingOrder(yamlPath: string): number | null {
  try {
    const m = /^order:\s*(\d+)/m.exec(readFileSync(yamlPath, 'utf8'));
    return m === null ? null : Number.parseInt(m[1] as string, 10);
  } catch {
    return null;
  }
}

/** Test-only seams; the daemon always uses the defaults. */
export interface SitePromoterHooks {
  /** Confinement root parent — content must live in <home>/projects. */
  home?: string;
  /** Spawn env for git/bun (tests may prepend a PATH shim dir). */
  env?: NodeJS.ProcessEnv;
  /** Health-check bound (contract default 20 tries × 15s). */
  healthRetries?: number;
  healthIntervalMs?: number;
  /** Per-request HTTP timeout. */
  fetchTimeoutMs?: number;
  /** bun build bound (default 5 minutes, like the reference). */
  buildTimeoutMs?: number;
}

interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A step failed: recorded { name, ok:false, detail } and the run stops. */
class StepError extends Error {}

/** Everything the steps need, computed read-only up front. */
interface Resolved {
  sourcePath: string;
  slug: string;
  title: string;
  url: string;
  /** The website repo's origin remote (the record's repoUrl), or null. */
  repoUrl: string | null;
  /** guides/chapter-NN.html names, sorted. */
  guides: string[];
  /** One (htmlFile, title) per guide, titles from chapters/chapter-NN.md. */
  chapterTitles: Array<{ htmlFile: string; title: string }>;
  hasTextbook: boolean;
  /** Website-repo target paths (repo-relative, for git add + messages). */
  publicRel: string;
  yamlRel: string;
  textbookRel: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createSitePromoter(deps: PromoterDeps, hooks: SitePromoterHooks = {}): Promoter {
  const { db, log, config, notify } = deps;
  const store: PromotionStore = createPromotionStore(db);
  const home = hooks.home ?? homedir();
  const toolEnv = hooks.env ?? process.env;
  const healthRetries = hooks.healthRetries ?? SITE_HEALTH_RETRIES;
  const healthIntervalMs = hooks.healthIntervalMs ?? SITE_HEALTH_INTERVAL_MS;
  const fetchTimeoutMs = hooks.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const buildTimeoutMs = hooks.buildTimeoutMs ?? BUILD_TIMEOUT_MS;
  const { promote } = config;
  const repo = (): string => promote.websiteRepo;

  /** Slugs with a pipeline in flight in THIS daemon life — no concurrent re-runs. */
  const inFlight = new Set<string>();

  const runTool = (
    cmd: string,
    args: string[],
    cwd: string,
    timeout = GIT_TIMEOUT_MS,
  ): Promise<ToolResult> =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { cwd, env: toolEnv, timeout, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const code = typeof err.code === 'number' ? err.code : 1;
          resolve({ code, stdout, stderr: stderr === '' ? err.message : stderr });
        },
      );
    });

  /** runTool that turns a nonzero exit into a StepError naming the command. */
  const mustRun = async (
    cmd: string,
    args: string[],
    cwd: string,
    timeout = GIT_TIMEOUT_MS,
  ): Promise<ToolResult> => {
    const result = await runTool(cmd, args, cwd, timeout);
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' / ');
      throw new StepError(`\`${cmd} ${args.join(' ')}\` exited ${result.code}: ${output}`);
    }
    return result;
  };

  /**
   * READ-ONLY resolution shared by dry run and execute: confinement, the
   * study shape (guides/chapter-NN.html required; chapters/*.md drive the
   * titles; textbook.md optional), the website repo sanity re-check, and the
   * slug/title/url/repoUrl. Failures throw PromotionError (400).
   */
  const resolve = (req: PromoteRequest): Resolved => {
    const sourcePath = confineToProjects(home, req.path);

    const guidesDir = join(sourcePath, 'guides');
    const guides = existsSync(guidesDir)
      ? readdirSync(guidesDir)
          .filter((name) => /^chapter-\d+\.html$/.test(name))
          .sort()
      : [];
    if (guides.length === 0) {
      throw new PromotionError(
        `study content at ${sourcePath} has no guides/chapter-NN.html files — cannot promote to the website`,
      );
    }

    // The reference strips the workflow's sws- prefix from the derived slug;
    // an explicit slug override is normalized as given.
    const defaultSlug = basename(sourcePath).replace(/^sws-/, '');
    const slug = slugify(req.slug ?? defaultSlug);
    if (slug === '') {
      throw new PromotionError(`cannot derive a slug from: ${req.slug ?? basename(sourcePath)}`);
    }

    // Config fail-fast covers startup; re-check here so a repo that vanished
    // (or was never configured in a test) rejects cleanly at the entry.
    if (repo() === '' || !existsSync(repo()) || !existsSync(join(repo(), '.git'))) {
      throw new PromotionError(
        `website repo is missing or not a git clone: ${repo() === '' ? '(NIGHTSHIFT_WEBSITE_REPO unset)' : repo()}`,
      );
    }

    // The record's repoUrl is the WEBSITE repo's remote (contract), read
    // synchronously so the dry-run plan carries it too.
    let repoUrl: string | null = null;
    try {
      repoUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: repo(),
        env: toolEnv,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
      }).trim();
      if (repoUrl === '') repoUrl = null;
    } catch {
      repoUrl = null;
    }

    const chaptersDir = join(sourcePath, 'chapters');
    const chapterTitles = guides.map((htmlFile) => {
      const mdPath = join(chaptersDir, htmlFile.replace(/\.html$/, '.md'));
      const title = existsSync(mdPath) ? extractChapterTitle(mdPath) : null;
      return { htmlFile, title: title ?? htmlFile.replace(/\.html$/, '') };
    });

    return {
      sourcePath,
      slug,
      title: req.title ?? titleFromSlug(slug),
      url: `https://www.${promote.domain}/study-guides/${slug}`,
      repoUrl,
      guides,
      chapterTitles,
      hasTextbook: existsSync(join(sourcePath, 'textbook.md')),
      publicRel: join('public', 'study-guides', slug),
      yamlRel: join('src', 'content', 'studyGuides', `${slug}.yaml`),
      textbookRel: join('src', 'content', 'textbooks', `${slug}.md`),
    };
  };

  const plannedSteps = (r: Resolved): PromotionStep[] => [
    {
      name: 'validate',
      ok: true,
      detail:
        `planned: promote study content (${r.guides.length} guide(s)` +
        `${r.hasTextbook ? ' + textbook.md' : ''}) at ${r.sourcePath} as ${r.slug} ` +
        `into the website repo ${repo()}`,
    },
    {
      name: 'scan',
      ok: true,
      detail: 'planned: secret scan (filename + content patterns) over the source content',
    },
    {
      name: 'stage',
      ok: true,
      detail:
        `planned: refuse a dirty repo, pull --rebase, then write ${r.publicRel}/ ` +
        `(${r.guides.length} guide(s), dark-mode converted) + ${r.yamlRel}` +
        `${r.hasTextbook ? ` + ${r.textbookRel}` : ''}`,
    },
    {
      name: 'build',
      ok: true,
      detail: `planned: \`${promote.bunPath} run build\` in the website repo — must pass before anything is pushed`,
    },
    {
      name: 'push',
      ok: true,
      detail: `planned: git add/commit, pull --rebase, push to ${r.repoUrl ?? 'origin'} (hosting auto-deploys)`,
    },
    {
      name: 'health',
      ok: true,
      detail: `planned: GET ${r.url} until 200 (bounded ${healthRetries} × ${Math.round(healthIntervalMs / 1000)}s)`,
    },
  ];

  // ── the six executed steps ────────────────────────────────────────────────

  const stepValidate = (r: Resolved): string =>
    `study content: ${r.guides.length} guide(s)${r.hasTextbook ? ' + textbook.md' : ''}; ` +
    `website repo ${repo()} is a git clone`;

  const stepScan = (r: Resolved): string => {
    const hits = scanForSecrets(r.sourcePath);
    if (hits.length > 0) {
      const listed = hits
        .slice(0, MAX_LISTED_HITS)
        .map((h) => `${h.file} (${h.reason})`)
        .join('; ');
      const more = hits.length > MAX_LISTED_HITS ? `; +${hits.length - MAX_LISTED_HITS} more` : '';
      throw new StepError(
        `secret scan hit ${hits.length} file(s) — aborting before any repo write: ${listed}${more}`,
      );
    }
    return 'no filename or content hits';
  };

  /** Current branch of the website repo ('main' when detection fails). */
  const currentBranch = async (): Promise<string> => {
    const result = await runTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo());
    const branch = result.stdout.trim();
    return result.code === 0 && branch !== '' ? branch : 'main';
  };

  const stepStage = async (r: Resolved): Promise<string> => {
    // Shared-repo safety FIRST, before any write: refuse a dirty tree (the
    // clear error names the files), then sync with the remote.
    const status = await mustRun('git', ['status', '--porcelain'], repo());
    const dirty = status.stdout
      .trim()
      .split('\n')
      .filter((line) => line !== '');
    if (dirty.length > 0) {
      const files = dirty.map((line) => line.slice(3)).join(', ');
      throw new StepError(
        `website repo at ${repo()} has uncommitted changes — commit or stash them, then retry: ${files}`,
      );
    }
    const branch = await currentBranch();
    await mustRun('git', ['pull', '--rebase', 'origin', branch], repo());

    // Copy guides with the dark-mode conversion. Re-promote overwrites the
    // same slug's dir wholesale (idempotent; removed chapters do not linger).
    const publicDir = join(repo(), r.publicRel);
    rmSync(publicDir, { recursive: true, force: true });
    mkdirSync(publicDir, { recursive: true });
    let swapped = 0;
    for (const name of r.guides) {
      const converted = convertGuideToDarkMode(
        readFileSync(join(r.sourcePath, 'guides', name), 'utf8'),
      );
      if (converted.swapped) swapped += 1;
      writeFileSync(join(publicDir, name), converted.html);
    }

    // The studyGuides YAML entry. A re-promote keeps the slug's existing
    // order; a new slug gets highest+1 (the reference's numbering).
    const yamlPath = join(repo(), r.yamlRel);
    const order =
      existingOrder(yamlPath) ?? nextStudyGuideOrder(join(repo(), 'src', 'content', 'studyGuides'));
    const textbookSrc = join(r.sourcePath, 'textbook.md');
    let description = r.hasTextbook ? extractTextbookIntro(textbookSrc) : '';
    if (description === '') {
      description = `Study guide on ${r.title}, covering ${r.guides.length} interactive chapters.`;
    }
    const yamlLines = [
      `title: ${yamlQuote(r.title)}`,
      `slug: "${r.slug}"`,
      `description: ${yamlQuote(description)}`,
      `order: ${order}`,
      'chapters:',
    ];
    for (const { htmlFile, title } of r.chapterTitles) {
      yamlLines.push(`  - title: ${yamlQuote(title)}`, `    htmlFile: "${htmlFile}"`);
    }
    mkdirSync(join(repo(), 'src', 'content', 'studyGuides'), { recursive: true });
    writeFileSync(yamlPath, `${yamlLines.join('\n')}\n`);

    // Textbook companion (optional): H1 as the book title, frontmatter wires
    // the "Read full textbook →" card link via studyGuideSlug.
    if (r.hasTextbook) {
      const text = readFileSync(textbookSrc, 'utf8');
      const h1 = /^#\s+(.+)$/m.exec(text);
      const bookTitle = h1?.[1]?.trim() ?? r.title;
      const textbookDst = join(repo(), r.textbookRel);
      mkdirSync(join(repo(), 'src', 'content', 'textbooks'), { recursive: true });
      writeFileSync(
        textbookDst,
        `---\ntitle: ${yamlQuote(bookTitle)}\nstudyGuideSlug: "${r.slug}"\n---\n\n${text}`,
      );
    }

    return (
      `copied ${r.guides.length} guide(s) (dark-mode swapped: ${swapped}) → ${r.publicRel}/; ` +
      `wrote ${r.yamlRel} (order ${order})` +
      (r.hasTextbook ? `; wrote ${r.textbookRel}` : '')
    );
  };

  const stepBuild = async (r: Resolved): Promise<string> => {
    // The tree was verified clean before staging, so a rollback only ever
    // discards THIS run's writes — never an operator's manual edits.
    const rollback = async (): Promise<void> => {
      await runTool('git', ['reset', '--hard', 'HEAD'], repo());
      await runTool('git', ['clean', '-fd'], repo());
    };
    const failBuild = async (message: string, result: ToolResult): Promise<never> => {
      await rollback();
      const tail = (result.stderr || result.stdout).trim().split('\n').slice(-10).join(' / ');
      throw new StepError(`${message} — staged changes reverted${tail === '' ? '' : `: ${tail}`}`);
    };

    if (!existsSync(join(repo(), 'node_modules'))) {
      const install = await runTool(
        promote.bunPath,
        ['install', '--frozen-lockfile'],
        repo(),
        buildTimeoutMs,
      );
      if (install.code !== 0) {
        await failBuild(`\`${promote.bunPath} install --frozen-lockfile\` failed`, install);
      }
    }

    const distIndex = join(repo(), 'dist', 'study-guides', r.slug, 'index.html');
    let result = await runTool(promote.bunPath, ['run', 'build'], repo(), buildTimeoutMs);
    if (result.code !== 0) {
      await failBuild(`\`${promote.bunPath} run build\` failed`, result);
    }
    if (existsSync(distIndex)) {
      return `\`${promote.bunPath} run build\` passed — ${r.slug}/index.html rendered`;
    }
    // Astro's content cache can go stale when a new collection entry lands —
    // clear the caches and rebuild once (the reference's retry). Astro 5 moved
    // the content-layer data store to node_modules/.astro (repro'd live
    // 2026-07-07: a fresh studyGuides YAML rendered no page until that store
    // was cleared); clear BOTH locations so the retry works on any version.
    rmSync(join(repo(), '.astro'), { recursive: true, force: true });
    rmSync(join(repo(), 'node_modules', '.astro'), { recursive: true, force: true });
    rmSync(join(repo(), 'dist'), { recursive: true, force: true });
    result = await runTool(promote.bunPath, ['run', 'build'], repo(), buildTimeoutMs);
    if (result.code !== 0 || !existsSync(distIndex)) {
      await failBuild(
        `build produced no dist/study-guides/${r.slug}/index.html even after clearing .astro/dist`,
        result,
      );
    }
    return `\`${promote.bunPath} run build\` passed (after stale-cache clear) — ${r.slug}/index.html rendered`;
  };

  const stepPush = async (r: Resolved): Promise<string> => {
    const branch = await currentBranch();
    const addPaths = [r.publicRel, r.yamlRel, ...(r.hasTextbook ? [r.textbookRel] : [])];
    await mustRun('git', ['add', ...addPaths], repo());
    // --allow-empty keeps an unchanged re-promote flowing (and an empty
    // commit retriggers the host's auto-deploy, which the reference relies on
    // for its flaky-prerender workaround).
    await mustRun(
      'git',
      ['commit', '-m', `Add ${r.title} study guide (${r.guides.length} chapters)`, '--allow-empty'],
      repo(),
    );
    // Contract: pull --rebase first — the repo is shared and may have drifted
    // while the build ran; our commit rebases cleanly on top.
    await mustRun('git', ['pull', '--rebase', 'origin', branch], repo());
    await mustRun('git', ['push', 'origin', branch], repo());
    return `committed and pushed to origin/${branch} — hosting auto-deploys`;
  };

  const stepHealth = async (r: Resolved): Promise<string> => {
    const target =
      promote.healthBase === '' ? r.url : `${promote.healthBase}/study-guides/${r.slug}`;
    for (let attempt = 1; attempt <= healthRetries; attempt += 1) {
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(fetchTimeoutMs) });
        if (res.status === 200) {
          await res.arrayBuffer(); // drain
          return `200 from ${target} (attempt ${attempt}/${healthRetries})`;
        }
      } catch {
        // Not deployed yet — retry until the bound.
      }
      if (attempt < healthRetries) await sleep(healthIntervalMs);
    }
    throw new StepError(`no 200 from ${target} after ${healthRetries} attempts`);
  };

  // ── the background run (confirm:true) ────────────────────────────────────

  const runPipeline = async (r: Resolved): Promise<void> => {
    const steps: PromotionStep[] = [];
    const record = (name: string, ok: boolean, detail: string): void => {
      steps.push({ name, ok, detail });
      store.updateSteps(r.slug, steps);
    };
    const fail = async (name: string, err: unknown): Promise<void> => {
      const message = err instanceof Error ? err.message : String(err);
      record(name, false, message);
      store.finish(r.slug, 'failed', new Date().toISOString(), `${name}: ${message}`);
      log.error('site promotion failed', { slug: r.slug, step: name, error: message });
      try {
        await notify(
          promotionFailureNotice({ title: r.title, slug: r.slug, step: name, error: message }),
        );
      } catch (notifyErr) {
        log.error('site promotion failure notice failed', {
          slug: r.slug,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        });
      }
    };

    try {
      for (const name of SITE_STEP_NAMES) {
        try {
          switch (name) {
            case 'validate':
              record(name, true, stepValidate(r));
              break;
            case 'scan':
              record(name, true, stepScan(r));
              break;
            case 'stage':
              record(name, true, await stepStage(r));
              break;
            case 'build':
              record(name, true, await stepBuild(r));
              break;
            case 'push':
              record(name, true, await stepPush(r));
              break;
            case 'health':
              record(name, true, await stepHealth(r));
              break;
          }
        } catch (err) {
          await fail(name, err);
          return;
        }
      }
      store.finish(r.slug, 'live', new Date().toISOString(), null);
      log.info('site promotion live', { slug: r.slug, url: r.url, repoUrl: r.repoUrl });
      try {
        await notify(
          promotionLiveNotice({
            title: r.title,
            slug: r.slug,
            url: r.url,
            repoUrl: r.repoUrl ?? repo(),
          }),
        );
      } catch (err) {
        log.error('site promotion live notice failed', {
          slug: r.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      inFlight.delete(r.slug);
    }
  };

  return {
    async promote(req: PromoteRequest): Promise<PromotionRecord> {
      const r = resolve(req);
      const existing = store.getBySlug(r.slug);
      const now = new Date().toISOString();

      if (req.confirm !== true) {
        const planned: PromotionRecord = {
          schema: 1,
          id: existing?.id ?? randomUUID(),
          slug: r.slug,
          title: r.title,
          sourcePath: r.sourcePath,
          status: 'planned',
          repoUrl: r.repoUrl,
          url: r.url,
          steps: plannedSteps(r),
          createdAt: now,
          endedAt: null,
          error: null,
        };
        // Persist the plan — EXCEPT over a live/running record: the stored
        // row is the "what's live where" truth and a dry run must not demote
        // it. The plan itself is still returned either way.
        if (
          existing === null ||
          existing.status === 'planned' ||
          existing.status === 'failed' ||
          existing.status === 'removed'
        ) {
          store.upsert(planned);
        }
        return planned;
      }

      if (inFlight.has(r.slug)) {
        throw new PromotionError(`promotion for "${r.slug}" is already running`);
      }
      const running: PromotionRecord = {
        schema: 1,
        id: existing?.id ?? randomUUID(),
        slug: r.slug,
        title: r.title,
        sourcePath: r.sourcePath,
        status: 'running',
        repoUrl: r.repoUrl,
        url: r.url,
        steps: [],
        createdAt: now,
        endedAt: null,
        error: null,
      };
      store.upsert(running);
      inFlight.add(r.slug);
      // Detach: the caller gets the 'running' record now; completion arrives
      // as a notice. runPipeline handles ALL its own errors.
      void runPipeline(r).catch((err: unknown) => {
        inFlight.delete(r.slug);
        const message = err instanceof Error ? err.message : String(err);
        store.finish(r.slug, 'failed', new Date().toISOString(), message);
        log.error('site promotion pipeline crashed', { slug: r.slug, error: message });
      });
      return running;
    },

    get(slug: string): PromotionRecord | null {
      const stored = store.getBySlug(slug);
      if (stored === null) return null;
      const { coolifyUuid: _internal, ...record } = stored;
      return record;
    },
  };
}

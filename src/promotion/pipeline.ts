/**
 * Promotion pipeline (contracts/promotion.md v1, frozen; ADR 0008): promote a
 * content dir from $HOME/projects to https://<slug>.<domain> through the
 * proven GitHub → Coolify → Cloudflare path, as DETERMINISTIC daemon code —
 * no LLM, and the infra creds never leave the daemon (workerEnv() blocks the
 * CF_/COOLIFY_ prefixes).
 *
 * Stage 13: the promote entry point is now the ROUTER (route.ts) — study
 * content goes to the website pipeline (site.ts, contracts/site-promotion.md)
 * and story content is rejected, so this subdomain pipeline is reserved for
 * future APP promotion and is unreachable for study/story content.
 *
 * Ported from the old NSAF reference (flask-app/bot/commands.py: cmd_promote,
 * _promote_study, _add_cloudflare_tunnel_route) — the Coolify create/deploy
 * payloads, the CF tunnel-ingress config mutation (insert before the
 * catch-all), and the proxied CNAME (81057 = already exists, tolerated) are
 * that code's working behavior. Where the reference and the contract disagree
 * the contract wins: static build pack (content, not dockerized apps), one CF
 * token (CF_DNS_TOKEN) for both tunnel + DNS calls, and a fixed 7-step
 * recorded pipeline with a health check.
 *
 * Gating: confirm:false → DRY RUN — the plan (computed slug/url/repo + the
 * seven planned steps) is returned and persisted as 'planned'; NOTHING
 * executes (no fs writes, no git, no HTTP). confirm:true → the record is
 * persisted 'running' and returned immediately; the pipeline continues in the
 * BACKGROUND (it takes minutes) and completion/failure lands as a 🚀 notice.
 * Each step is recorded { name, ok, detail }; the first failure persists
 * 'failed' + error and stops the run.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { promotionFailureNotice, promotionLiveNotice } from '../notices.js';
import type { PromoteRequest, PromotionRecord, PromotionStep } from '../types.js';
import {
  type ContentKind,
  confineToProjects,
  ensureIndexHtml,
  listGuides,
  listStoryArtifacts,
  PromotionError,
  slugify,
  titleFromSlug,
} from './index.js';
import { scanForSecrets } from './scan.js';
import { createPromotionStore, type PromotionStore } from './store.js';

// Re-exported for the existing importers (api.ts, tests) — the class itself
// moved to ./index.js so the site pipeline and router share it (Stage 13).
export { PromotionError };

/** Public repos land under this GitHub account (contracts/promotion.md step 3). */
export const GITHUB_OWNER = 'seanerama';

/** The contract's fixed step order. */
export const STEP_NAMES = [
  'validate',
  'scan',
  'repo',
  'coolify',
  'route',
  'dns',
  'health',
] as const;

export interface Promoter {
  /**
   * The one entry point (API + CLI): dry run resolves + plans synchronously;
   * confirm:true returns the persisted 'running' record while the pipeline
   * continues in the background.
   */
  promote(req: PromoteRequest): Promise<PromotionRecord>;
  /** Storage truth for a slug (tests + future status surfaces). */
  get(slug: string): PromotionRecord | null;
}

/** Test-only seams; the daemon always uses the defaults. */
export interface PromoterHooks {
  /** Confinement root parent — content must live in <home>/projects. */
  home?: string;
  /** Spawn env for git/gh (tests prepend a PATH shim dir). */
  env?: NodeJS.ProcessEnv;
  /** Health-check retry bound (default 10 tries × 6s). */
  healthRetries?: number;
  healthIntervalMs?: number;
  /** Coolify build-wait bound (default 60 polls × 5s). */
  deployRetries?: number;
  deployIntervalMs?: number;
  /** Per-request HTTP timeout. */
  fetchTimeoutMs?: number;
}

export interface PromoterDeps {
  db: Database.Database;
  log: Logger;
  config: Config;
  /** Deliver the 🚀 completion/failure notice (the app wires this to send()). */
  notify: (text: string) => Promise<void>;
}

/** Everything the steps need, computed read-only up front. */
interface Resolved {
  sourcePath: string;
  slug: string;
  title: string;
  kind: ContentKind;
  hostname: string;
  url: string;
  repoUrl: string;
  hasIndex: boolean;
  contentDetail: string;
}

interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HEALTH_RETRIES = 10;
const HEALTH_INTERVAL_MS = 6_000;
const DEPLOY_RETRIES = 60;
const DEPLOY_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_LISTED_HITS = 10;

/** A step failed: recorded { name, ok:false, detail } and the run stops. */
class StepError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createPromoter(deps: PromoterDeps, hooks: PromoterHooks = {}): Promoter {
  const { db, log, config, notify } = deps;
  const store: PromotionStore = createPromotionStore(db);
  const home = hooks.home ?? homedir();
  const toolEnv = hooks.env ?? process.env;
  const healthRetries = hooks.healthRetries ?? HEALTH_RETRIES;
  const healthIntervalMs = hooks.healthIntervalMs ?? HEALTH_INTERVAL_MS;
  const deployRetries = hooks.deployRetries ?? DEPLOY_RETRIES;
  const deployIntervalMs = hooks.deployIntervalMs ?? DEPLOY_INTERVAL_MS;
  const fetchTimeoutMs = hooks.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const { promote } = config;

  /** Slugs with a pipeline in flight in THIS daemon life — no concurrent re-runs. */
  const inFlight = new Set<string>();

  const runTool = (cmd: string, args: string[], cwd: string): Promise<ToolResult> =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { cwd, env: toolEnv, timeout: TOOL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
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
  const mustRun = async (cmd: string, args: string[], cwd: string): Promise<ToolResult> => {
    const result = await runTool(cmd, args, cwd);
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' / ');
      throw new StepError(`\`${cmd} ${args.join(' ')}\` exited ${result.code}: ${output}`);
    }
    return result;
  };

  const httpJson = async (
    method: string,
    url: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
    } catch (err) {
      throw new StepError(
        `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      // Non-JSON body — callers only need status for the error path.
    }
    return { status: res.status, json };
  };

  /**
   * READ-ONLY resolution shared by dry run and execute: confine the path to
   * <home>/projects (realpath — symlinks cannot escape), recognize the content
   * shape, compute slug/title/url/repo. Failures throw PromotionError (400).
   */
  const resolve = (req: PromoteRequest): Resolved => {
    const sourcePath = confineToProjects(home, req.path);

    const guides = listGuides(sourcePath);
    const hasTextbook = existsSync(join(sourcePath, 'textbook.md'));
    const storyArtifacts = listStoryArtifacts(sourcePath);
    let kind: ContentKind;
    let contentDetail: string;
    if (guides.length > 0 || hasTextbook) {
      kind = 'study';
      contentDetail = `study content: ${guides.length} guide(s)${hasTextbook ? ' + textbook.md' : ''}`;
    } else if (storyArtifacts.length > 0) {
      kind = 'story';
      contentDetail = `story content: ${storyArtifacts.join(', ')}`;
    } else {
      throw new PromotionError(
        `unrecognized content at ${sourcePath}: expected study (guides/*.html or textbook.md) or story (final video/PDF)`,
      );
    }

    const slug = slugify(req.slug ?? basename(sourcePath));
    if (slug === '') {
      throw new PromotionError(`cannot derive a slug from: ${req.slug ?? basename(sourcePath)}`);
    }
    const title = req.title ?? titleFromSlug(slug);
    const hostname = `${slug}.${promote.domain}`;
    return {
      sourcePath,
      slug,
      title,
      kind,
      hostname,
      url: `https://${hostname}`,
      repoUrl: `https://github.com/${GITHUB_OWNER}/${slug}`,
      hasIndex: existsSync(join(sourcePath, 'index.html')),
      contentDetail,
    };
  };

  const plannedSteps = (r: Resolved): PromotionStep[] => [
    {
      name: 'validate',
      ok: true,
      detail: `planned: promote ${r.contentDetail} at ${r.sourcePath} as ${r.slug}${r.hasIndex ? '' : '; will generate index.html'}`,
    },
    {
      name: 'scan',
      ok: true,
      detail: 'planned: secret scan (filename + content patterns) before any git',
    },
    {
      name: 'repo',
      ok: true,
      detail: `planned: create-or-update public repo ${r.repoUrl} (git + gh)`,
    },
    {
      name: 'coolify',
      ok: true,
      detail: `planned: create-or-reuse static app "${r.slug}", deploy, wait for the build`,
    },
    {
      name: 'route',
      ok: true,
      detail: `planned: Cloudflare tunnel ingress route for ${r.hostname}`,
    },
    {
      name: 'dns',
      ok: true,
      detail: `planned: CNAME ${r.hostname} → ${promote.cfTunnelId}.cfargotunnel.com (proxied)`,
    },
    { name: 'health', ok: true, detail: `planned: GET ${r.url} until 200 (bounded wait)` },
  ];

  // ── the seven executed steps ──────────────────────────────────────────────

  const stepValidate = (r: Resolved): string => {
    const index = ensureIndexHtml(r.sourcePath, r.title, r.kind);
    return `${r.contentDetail}; ${index.detail}`;
  };

  const stepScan = (r: Resolved): string => {
    const hits = scanForSecrets(r.sourcePath);
    if (hits.length > 0) {
      const listed = hits
        .slice(0, MAX_LISTED_HITS)
        .map((h) => `${h.file} (${h.reason})`)
        .join('; ');
      const more = hits.length > MAX_LISTED_HITS ? `; +${hits.length - MAX_LISTED_HITS} more` : '';
      throw new StepError(
        `secret scan hit ${hits.length} file(s) — aborting before git: ${listed}${more}`,
      );
    }
    return 'no filename or content hits';
  };

  /** Returns the pushed branch (the coolify step deploys it). */
  const stepRepo = async (r: Resolved): Promise<{ detail: string; branch: string }> => {
    const cwd = r.sourcePath;
    const view = await runTool(
      'gh',
      ['repo', 'view', `${GITHUB_OWNER}/${r.slug}`, '--json', 'name'],
      cwd,
    );
    const exists = view.code === 0;

    if (!existsSync(join(cwd, '.git'))) {
      await mustRun('git', ['init', '-b', 'main'], cwd);
    }
    await mustRun('git', ['add', '-A'], cwd);
    await mustRun(
      'git',
      ['commit', '-m', `Promote ${r.slug} via Nightshift Assistant`, '--allow-empty'],
      cwd,
    );
    const branchResult = await runTool('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const branch = branchResult.stdout.trim() || 'main';

    if (!exists) {
      await mustRun(
        'gh',
        [
          'repo',
          'create',
          `${GITHUB_OWNER}/${r.slug}`,
          '--public',
          '--source',
          '.',
          '--remote',
          'origin',
          '--push',
        ],
        cwd,
      );
      return { detail: `created ${r.repoUrl} (branch ${branch})`, branch };
    }
    const origin = await runTool('git', ['remote', 'get-url', 'origin'], cwd);
    if (origin.code !== 0) {
      await mustRun('git', ['remote', 'add', 'origin', `${r.repoUrl}.git`], cwd);
    }
    await mustRun('git', ['push', '-u', 'origin', 'HEAD'], cwd);
    return { detail: `updated ${r.repoUrl} (branch ${branch})`, branch };
  };

  const stepCoolify = async (r: Resolved, branch: string): Promise<string> => {
    const base = promote.coolifyApiUrl;
    const token = promote.coolifyApiToken;
    let uuid = store.getBySlug(r.slug)?.coolifyUuid ?? null;
    let createdNote: string;
    if (uuid === null) {
      // Old-NSAF create payload, adapted for content per the contract: a
      // STATIC build pack (nginx on 80), not the reference's dockerfile/3000.
      const created = await httpJson('POST', `${base}/api/v1/applications/public`, token, {
        project_uuid: promote.coolifyProjectUuid,
        environment_name: promote.coolifyEnvironment,
        server_uuid: promote.coolifyServerUuid,
        type: 'public',
        name: r.slug,
        git_repository: r.repoUrl,
        git_branch: branch,
        build_pack: 'static',
        ports_exposes: '80',
        domains: r.url,
      });
      if (created.status < 200 || created.status >= 300) {
        throw new StepError(`Coolify app create returned HTTP ${created.status}`);
      }
      uuid = typeof created.json.uuid === 'string' ? created.json.uuid : '';
      if (uuid === '') throw new StepError('Coolify app create returned no uuid');
      store.setCoolifyUuid(r.slug, uuid);
      createdNote = `created app ${uuid}`;
    } else {
      createdNote = `reusing app ${uuid}`;
    }

    const deployed = await httpJson('POST', `${base}/api/v1/deploy`, token, { uuid });
    if (deployed.status < 200 || deployed.status >= 300) {
      throw new StepError(`Coolify deploy returned HTTP ${deployed.status}`);
    }

    // Contract step 4: "trigger build; WAIT for success". The deploy response
    // carries the deployment uuid; poll it bounded. (The old reference only
    // triggered — the health step was its only wait; the contract wins.)
    const deployments = Array.isArray(deployed.json.deployments) ? deployed.json.deployments : [];
    const first = deployments[0] as { deployment_uuid?: unknown } | undefined;
    const deploymentUuid =
      typeof first?.deployment_uuid === 'string' ? first.deployment_uuid : null;
    if (deploymentUuid === null) {
      return `${createdNote}; deploy triggered (no deployment id returned — not waiting)`;
    }
    for (let attempt = 1; attempt <= deployRetries; attempt += 1) {
      const poll = await httpJson('GET', `${base}/api/v1/deployments/${deploymentUuid}`, token);
      const status = typeof poll.json.status === 'string' ? poll.json.status : '';
      if (status === 'finished') {
        return `${createdNote}; build ${deploymentUuid} finished`;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new StepError(`Coolify build ${deploymentUuid} ended ${status}`);
      }
      if (attempt < deployRetries) await sleep(deployIntervalMs);
    }
    throw new StepError(`Coolify build ${deploymentUuid} did not finish within the wait bound`);
  };

  /** Port of _add_cloudflare_tunnel_route (one token per the contract). */
  const stepRoute = async (r: Resolved): Promise<string> => {
    const url = `${promote.cfApiBase}/accounts/${promote.cfAccountId}/cfd_tunnel/${promote.cfTunnelId}/configurations`;
    const token = promote.cfDnsToken;
    const current = await httpJson('GET', url, token);
    if (current.status !== 200) {
      throw new StepError(`CF tunnel config fetch returned HTTP ${current.status}`);
    }
    const result = current.json.result as { config?: { ingress?: unknown } } | undefined;
    const cfConfig = (result?.config ?? {}) as Record<string, unknown>;
    const ingress = Array.isArray(cfConfig.ingress)
      ? (cfConfig.ingress as Array<Record<string, unknown>>)
      : [];
    if (ingress.some((rule) => rule.hostname === r.hostname)) {
      return 'route already exists';
    }
    // Insert before the catch-all (the reference's ingress.insert(-1, rule)):
    // Coolify's Traefik proxy terminates on localhost:443, TLS unverified
    // inside the tunnel (Cloudflare re-verifies at its edge).
    const rule = {
      hostname: r.hostname,
      service: 'https://localhost:443',
      originRequest: { noTLSVerify: true },
    };
    ingress.splice(Math.max(0, ingress.length - 1), 0, rule);
    cfConfig.ingress = ingress;
    const updated = await httpJson('PUT', url, token, { config: cfConfig });
    if (updated.status !== 200) {
      throw new StepError(`CF tunnel config update returned HTTP ${updated.status}`);
    }
    return `ingress rule added for ${r.hostname}`;
  };

  const stepDns = async (r: Resolved): Promise<string> => {
    const target = `${promote.cfTunnelId}.cfargotunnel.com`;
    const res = await httpJson(
      'POST',
      `${promote.cfApiBase}/zones/${promote.cfZoneId}/dns_records`,
      promote.cfDnsToken,
      { type: 'CNAME', name: r.hostname, content: target, proxied: true },
    );
    if (res.status >= 200 && res.status < 300) {
      return `CNAME ${r.hostname} → ${target} (proxied)`;
    }
    // 81057 = record already exists — fine (the reference tolerates it too).
    const errors = Array.isArray(res.json.errors) ? res.json.errors : [];
    const firstError = errors[0] as { code?: unknown } | undefined;
    if (firstError?.code === 81057) {
      return `CNAME ${r.hostname} already exists`;
    }
    throw new StepError(`CF DNS record create returned HTTP ${res.status}`);
  };

  const stepHealth = async (r: Resolved): Promise<string> => {
    const target = promote.healthBase === '' ? r.url : `${promote.healthBase}/${r.slug}`;
    for (let attempt = 1; attempt <= healthRetries; attempt += 1) {
      try {
        const res = await fetch(target, { signal: AbortSignal.timeout(fetchTimeoutMs) });
        if (res.status === 200) {
          await res.arrayBuffer(); // drain
          return `200 from ${target} (attempt ${attempt}/${healthRetries})`;
        }
      } catch {
        // Not up yet (DNS/tunnel propagation) — retry until the bound.
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
      log.error('promotion failed', { slug: r.slug, step: name, error: message });
      try {
        await notify(
          promotionFailureNotice({ title: r.title, slug: r.slug, step: name, error: message }),
        );
      } catch (notifyErr) {
        log.error('promotion failure notice failed', {
          slug: r.slug,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        });
      }
    };

    try {
      let branch = 'main';
      for (const name of STEP_NAMES) {
        try {
          switch (name) {
            case 'validate':
              record(name, true, stepValidate(r));
              break;
            case 'scan':
              record(name, true, stepScan(r));
              break;
            case 'repo': {
              const repo = await stepRepo(r);
              branch = repo.branch;
              record(name, true, repo.detail);
              break;
            }
            case 'coolify':
              record(name, true, await stepCoolify(r, branch));
              break;
            case 'route':
              record(name, true, await stepRoute(r));
              break;
            case 'dns':
              record(name, true, await stepDns(r));
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
      log.info('promotion live', { slug: r.slug, url: r.url, repoUrl: r.repoUrl });
      try {
        await notify(
          promotionLiveNotice({ title: r.title, slug: r.slug, url: r.url, repoUrl: r.repoUrl }),
        );
      } catch (err) {
        log.error('promotion live notice failed', {
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
        log.error('promotion pipeline crashed', { slug: r.slug, error: message });
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

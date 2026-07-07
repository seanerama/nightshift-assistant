/**
 * Control API (contracts/control-api.md, frozen v1): the /api/v1/ surface over
 * App.jobs + App.sessions.rotate — a thin authenticated door, no business
 * logic. Mounted inside the existing transport server, so the loopback-only
 * bind (ADR 0001) is inherited; the funnel path-scopes to /webhook, so these
 * routes are never publicly reachable by construction.
 *
 * Order of the two gates on EVERY request:
 *   1. kill-switch — NIGHTSHIFT_CONTROL_ENABLED not "true" → 403 (dark by default);
 *   2. bearer auth — NIGHTSHIFT_API_TOKEN, constant-time compare, 401 on
 *      mismatch; FAIL CLOSED when the configured token is empty (401 for all).
 *
 * Error mapping: JobError (invalid submit / disabled runner / illegal kill)
 * → 400 with the error message; DeliverError → its own 400/409;
 * AttachmentError (over-cap file) → 400; unknown job id → 404; anything else → 500.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { JobError, type JobRunner } from '../jobs/runner.js';
import type { Logger } from '../log.js';
import { type Promoter, PromotionError } from '../promotion/pipeline.js';
import type { SessionManager } from '../session/manager.js';
import type { JobStatus, JobSubmit } from '../types.js';
import { DeliverError, type Deliverer } from './deliver.js';
import { AttachmentError } from './send.js';
import { readRawBody, respond } from './server.js';

const JOB_STATUSES: readonly string[] = ['queued', 'running', 'succeeded', 'failed', 'killed'];

export interface ApiDeps {
  config: Config;
  log: Logger;
  jobs: JobRunner;
  sessions: SessionManager;
  /** Stage 10 (additive on control-api v1): POST /api/v1/deliver. */
  deliver: Deliverer;
  /** Stage 11 (additive on control-api v1): POST /api/v1/promote. */
  promote: Promoter;
  version: string;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Constant-time bearer check. Both sides are hashed to fixed length first so
 * timingSafeEqual is applicable (it requires equal lengths) and the comparison
 * leaks neither content nor length of the expected token. Empty expected
 * token → fail closed, never compare.
 */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (expected === '') return false;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function createApiHandler(deps: ApiDeps): ApiHandler {
  const { config, log, jobs, sessions, deliver, promote, version } = deps;
  const startedAt = Date.now();

  /** Parse a POST body as JSON; an empty body is {} (rotate takes no required fields). */
  const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
    const raw = (await readRawBody(req)).toString('utf8');
    if (raw.trim() === '') return {};
    return JSON.parse(raw) as unknown;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Gate 1 — kill-switch: the entire control surface is dark by default.
    if (!config.controlEnabled) {
      respond(res, 403, {
        ok: false,
        error: 'control surface is disabled (set NIGHTSHIFT_CONTROL_ENABLED=true to enable)',
      });
      return;
    }

    // Gate 2 — bearer auth on every /api/v1/ request; fail closed when unset.
    const authHeader = req.headers.authorization;
    const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!tokenMatches(header, config.apiToken)) {
      log.warn('api request rejected: bearer auth failed', {
        path: req.url?.split('?')[0],
        tokenConfigured: config.apiToken !== '',
      });
      respond(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? '';

    // POST /api/v1/jobs — body is the job-lifecycle submit shape, OR (Stage 6,
    // the contract's reserved additive form) `{ type, params }`, discriminated
    // by the presence of `params`. submit()/submitType() own validation
    // (JobError → 400 via the catch below, including unknown type + the
    // NIGHTSHIFT_TYPES_ENABLED kill-switch).
    if (method === 'POST' && path === '/api/v1/jobs') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        respond(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      if (typeof body === 'object' && body !== null && 'params' in body) {
        const typed = body as { type?: unknown; params?: unknown };
        if (typeof typed.type !== 'string' || typed.type === '') {
          respond(res, 400, {
            ok: false,
            error: 'typed submit requires "type" (non-empty string) alongside "params"',
          });
          return;
        }
        const job = jobs.submitType(typed.type, typed.params);
        respond(res, 200, { ok: true, job });
        return;
      }
      const job = jobs.submit(body as JobSubmit);
      respond(res, 200, { ok: true, job });
      return;
    }

    // GET /api/v1/jobs?status=<s>
    if (method === 'GET' && path === '/api/v1/jobs') {
      const status = url.searchParams.get('status');
      if (status !== null && !JOB_STATUSES.includes(status)) {
        respond(res, 400, {
          ok: false,
          error: `invalid status filter: ${status} (expected one of ${JOB_STATUSES.join(', ')})`,
        });
        return;
      }
      const list = status === null ? jobs.list() : jobs.list({ status: status as JobStatus });
      respond(res, 200, { ok: true, jobs: list });
      return;
    }

    // GET /api/v1/jobs/<id> and POST /api/v1/jobs/<id>/kill
    const jobMatch = /^\/api\/v1\/jobs\/([^/]+)(\/kill)?$/.exec(path);
    if (jobMatch !== null) {
      const id = decodeURIComponent(jobMatch[1] as string);
      const isKill = jobMatch[2] !== undefined;
      if ((isKill && method !== 'POST') || (!isKill && method !== 'GET')) {
        respond(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const existing = jobs.get(id);
      if (existing === null) {
        respond(res, 404, { ok: false, error: `no such job: ${id}` });
        return;
      }
      respond(res, 200, { ok: true, job: isKill ? jobs.kill(id) : existing });
      return;
    }

    // POST /api/v1/deliver — body { path, note? } (Stage 10, additive on the
    // frozen v1 surface). Path confinement + owner-room resolution live in the
    // deliverer; DeliverError maps to 400/409 in the catch below.
    if (method === 'POST' && path === '/api/v1/deliver') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        respond(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      const { path: filePath, note } = body as { path?: unknown; note?: unknown };
      if (typeof filePath !== 'string' || filePath === '') {
        respond(res, 400, { ok: false, error: 'deliver requires "path" (non-empty string)' });
        return;
      }
      if (note !== undefined && typeof note !== 'string') {
        respond(res, 400, { ok: false, error: '"note" must be a string when present' });
        return;
      }
      const delivered = await deliver.deliver(filePath, note);
      respond(res, 200, { ok: true, delivered });
      return;
    }

    // POST /api/v1/promote — contracts/promotion.md (Stage 11, additive on the
    // frozen control-api v1 surface). Own kill-switch behind the two control
    // gates: NIGHTSHIFT_PROMOTE_ENABLED not "true" → 403 (dark by default).
    // Body { path, slug?, title?, confirm }. confirm false/absent → DRY RUN,
    // handled synchronously (plan only, zero side effects). confirm:true →
    // the pipeline runs ASYNC after this response (a real promotion takes
    // minutes): the response carries the persisted 'running' PromotionRecord
    // — the record's current truth, which satisfies the contract — and the
    // completion/failure arrives on its own as a 🚀 notice in Webex.
    if (method === 'POST' && path === '/api/v1/promote') {
      if (!config.promoteEnabled) {
        respond(res, 403, {
          ok: false,
          error: 'promotion is disabled (set NIGHTSHIFT_PROMOTE_ENABLED=true to enable)',
        });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        respond(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      const {
        path: contentPath,
        slug,
        title,
        confirm,
      } = body as { path?: unknown; slug?: unknown; title?: unknown; confirm?: unknown };
      if (typeof contentPath !== 'string' || contentPath === '') {
        respond(res, 400, { ok: false, error: 'promote requires "path" (non-empty string)' });
        return;
      }
      if (slug !== undefined && typeof slug !== 'string') {
        respond(res, 400, { ok: false, error: '"slug" must be a string when present' });
        return;
      }
      if (title !== undefined && typeof title !== 'string') {
        respond(res, 400, { ok: false, error: '"title" must be a string when present' });
        return;
      }
      if (confirm !== undefined && typeof confirm !== 'boolean') {
        respond(res, 400, { ok: false, error: '"confirm" must be a boolean when present' });
        return;
      }
      const promotion = await promote.promote({
        path: contentPath,
        ...(slug === undefined ? {} : { slug }),
        ...(title === undefined ? {} : { title }),
        confirm: confirm === true,
      });
      respond(res, 200, { ok: true, promotion });
      return;
    }

    // POST /api/v1/session/rotate — body { reason?: 'manual' }
    if (method === 'POST' && path === '/api/v1/session/rotate') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        respond(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      const reason = (body as { reason?: unknown }).reason;
      if (reason !== undefined && reason !== 'manual') {
        respond(res, 400, { ok: false, error: `invalid rotation reason: ${String(reason)}` });
        return;
      }
      const rotation = await sessions.rotate('manual');
      respond(res, 200, { ok: true, rotation });
      return;
    }

    // GET /api/v1/status — the contract's fixed status shape.
    if (method === 'GET' && path === '/api/v1/status') {
      const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, killed: 0 };
      for (const job of jobs.list()) counts[job.status] += 1;
      const session = sessions.info();
      respond(res, 200, {
        ok: true,
        version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        session,
        jobs: counts,
        rotation: { enabled: config.rotationEnabled },
        jobsEnabled: config.jobsEnabled,
      });
      return;
    }

    respond(res, 404, { ok: false, error: 'not found' });
  }

  return (req, res): void => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof JobError) {
        respond(res, 400, { ok: false, error: err.message });
        return;
      }
      if (err instanceof DeliverError) {
        respond(res, err.status, { ok: false, error: err.message });
        return;
      }
      if (err instanceof PromotionError) {
        // Rejected promote input: escaping/missing path, unrecognized content,
        // underivable slug, or an already-running slug.
        respond(res, 400, { ok: false, error: err.message });
        return;
      }
      if (err instanceof AttachmentError) {
        // Oversize/unreadable file at send time (e.g. over NIGHTSHIFT_ATTACH_MAX_MB).
        respond(res, 400, { ok: false, error: err.message });
        return;
      }
      log.error('api request failed', {
        path: req.url?.split('?')[0],
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) respond(res, 500, { ok: false, error: 'internal error' });
    });
  };
}

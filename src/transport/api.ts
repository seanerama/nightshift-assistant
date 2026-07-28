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
 * AttachmentError (over-cap file) → 400; UiRegistryError (rejected ui
 * install/validate) → 422 with the validator verdict; unknown job id → 404;
 * anything else → 500.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { JobError, type JobRunner } from '../jobs/runner.js';
import type { Logger } from '../log.js';
import { type Promoter, PromotionError } from '../promotion/pipeline.js';
import type { SessionManager } from '../session/manager.js';
import type { JobStatus, JobSubmit } from '../types.js';
import { type UiRegistry, UiRegistryError } from '../ui/registry.js';
import type { UiState } from '../ui/state.js';
import { DeliverError, type Deliverer } from './deliver.js';
import { RemarkableError, type RemarkablePusher } from './remarkable.js';
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
  /** Stage 19 (additive on control-api v1): POST /api/v1/remarkable. */
  remarkable: RemarkablePusher;
  /** Stage 31 (additive on control-api v1): the /api/v1/ui/* doors. */
  ui: UiRegistry;
  /** Stage 37 (contracts/ui-state.md): the /api/v1/ui/state/<name> doors. */
  uiState: UiState;
  /**
   * Stage 34 (ADR 0015): called AFTER each committed registry mutation
   * (register / activate / grant / revoke) so the shared UiNotifyHub can
   * broadcast notifications/resources/list_changed to the app transport's
   * open GET /app/v1/mcp streams. Fire-and-forget: the registry stays
   * transport-free, and emission must never block or fail a mutation.
   */
  onUiMutate?: () => void;
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
  const {
    config,
    log,
    jobs,
    sessions,
    deliver,
    promote,
    remarkable,
    ui,
    uiState,
    onUiMutate,
    version,
  } = deps;
  const startedAt = Date.now();

  /**
   * Stage 34: emit list_changed after a COMMITTED mutation — reached only
   * after the registry call returned (a throw skips it via the outer catch).
   * Swallow-everything guard: a broadcast problem must never surface on the
   * mutation's response path (the hub itself also never throws).
   */
  const uiMutated = (): void => {
    try {
      onUiMutate?.();
    } catch (err) {
      log.warn('ui list_changed notify failed (mutation unaffected)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

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

    // POST /api/v1/promote — contracts/promotion.md + site-promotion.md
    // (Stages 11/13, additive on the frozen control-api v1 surface). The
    // wired promoter is the ROUTER: study content → the website pipeline,
    // story content → 400 (not yet designed). Own kill-switch behind the two
    // control gates: NIGHTSHIFT_PROMOTE_ENABLED not "true" → 403 (dark by
    // default).
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

    // POST /api/v1/remarkable — body { path } (Stage 19, additive on the
    // frozen control-api v1 surface). Own kill-switch behind the two control
    // gates: NIGHTSHIFT_REMARKABLE_ENABLED not "true" → 403 (dark by default),
    // so with the flag off this route is byte-for-byte a disabled 403 and no
    // capability is reachable. Path confinement lives in the pusher (its
    // DeliverError maps to 400); a non-zero rmapi exit → RemarkableError (502)
    // in the catch below.
    if (method === 'POST' && path === '/api/v1/remarkable') {
      if (!config.remarkableEnabled) {
        respond(res, 403, {
          ok: false,
          error: 'reMarkable push is disabled (set NIGHTSHIFT_REMARKABLE_ENABLED=true to enable)',
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
      const { path: filePath } = body as { path?: unknown };
      if (typeof filePath !== 'string' || filePath === '') {
        respond(res, 400, { ok: false, error: 'remarkable requires "path" (non-empty string)' });
        return;
      }
      const pushed = await remarkable.push(filePath);
      respond(res, 200, { ok: true, pushed });
      return;
    }

    // /api/v1/ui/* — generative UI (Stages 31–33, contracts/generative-ui.md,
    // additive on the frozen control-api v1 surface). Flag off → 404 for the
    // WHOLE family: the feature is ABSENT (not 403-disabled) — the contract's
    // dark posture. Thin doors: naming, validation, versioning, the
    // active-pointer invariant, and the grant machinery all live in
    // src/ui/registry.ts; UiRegistryError maps to its status (422, or 404 for
    // unknown-resource/no-active-grant — with the verdict when the rejection
    // is a failed validation) in the catch below.
    if (path.startsWith('/api/v1/ui/')) {
      if (!config.generativeUiEnabled) {
        respond(res, 404, { ok: false, error: 'not found' });
        return;
      }

      // POST /api/v1/ui/validate — body { html }. Dry-run: NEVER writes; the
      // revise loop uses this so failed attempts consume no version numbers.
      // Invalid HTML answers 422 with the same { ok:false, error, verdict }
      // shape the register door uses (so `nightshift ui validate` exits 1).
      if (method === 'POST' && path === '/api/v1/ui/validate') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          respond(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const { html } = body as { html?: unknown };
        if (typeof html !== 'string') {
          respond(res, 400, { ok: false, error: 'validate requires "html" (string)' });
          return;
        }
        const verdict = ui.validate(html);
        if (!verdict.valid) {
          const summary = verdict.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ');
          respond(res, 422, { ok: false, error: `ui validation failed — ${summary}`, verdict });
          return;
        }
        respond(res, 200, { ok: true, verdict });
        return;
      }

      // POST /api/v1/ui/resources — body { name, html, requestedTools?,
      // provenance? }: validate → insert as the NEXT version (1 for a new
      // name), made active, prior versions retained (Stage 32, ADR 0015).
      // On ANY rejection (bad name, unknown tool, invalid HTML) nothing is
      // written — a failed install against an existing name leaves the
      // active pointer and version count untouched.
      if (method === 'POST' && path === '/api/v1/ui/resources') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          respond(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const { name, html, requestedTools, provenance } = body as {
          name?: unknown;
          html?: unknown;
          requestedTools?: unknown;
          provenance?: unknown;
        };
        if (typeof name !== 'string' || name === '') {
          respond(res, 400, { ok: false, error: 'register requires "name" (non-empty string)' });
          return;
        }
        if (typeof html !== 'string' || html === '') {
          respond(res, 400, { ok: false, error: 'register requires "html" (non-empty string)' });
          return;
        }
        if (
          requestedTools !== undefined &&
          (!Array.isArray(requestedTools) || requestedTools.some((t) => typeof t !== 'string'))
        ) {
          respond(res, 400, {
            ok: false,
            error: '"requestedTools" must be an array of strings when present',
          });
          return;
        }
        if (provenance !== undefined && typeof provenance !== 'string') {
          respond(res, 400, { ok: false, error: '"provenance" must be a string when present' });
          return;
        }
        const resource = ui.install({
          name,
          html,
          ...(requestedTools === undefined ? {} : { requestedTools: requestedTools as string[] }),
          ...(provenance === undefined ? {} : { provenance }),
        });
        respond(res, 200, { ok: true, resource });
        uiMutated(); // register committed → list_changed (Stage 34)
        return;
      }

      // GET /api/v1/ui/resources — the queryable registry: active version per
      // name, html omitted (htmlBytes carries the size).
      if (method === 'GET' && path === '/api/v1/ui/resources') {
        respond(res, 200, { ok: true, resources: ui.list() });
        return;
      }

      // Stage 32 — the versioned sub-resources (contracts/generative-ui.md):
      //   GET  /api/v1/ui/resources/<name>            → all versions, html omitted
      //   GET  /api/v1/ui/resources/<name>/<version>  → one version WITH html
      //   POST /api/v1/ui/resources/<name>/activate   → rollback = re-activation
      // Unknown name/version → 404. Same path-param style as /api/v1/jobs/<id>.
      const uiResourceMatch = /^\/api\/v1\/ui\/resources\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (uiResourceMatch !== null) {
        const name = decodeURIComponent(uiResourceMatch[1] as string);
        const sub =
          uiResourceMatch[2] === undefined ? null : decodeURIComponent(uiResourceMatch[2]);

        // POST /api/v1/ui/resources/<name>/activate — body { version }.
        if (sub === 'activate') {
          if (method !== 'POST') {
            respond(res, 404, { ok: false, error: 'not found' });
            return;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respond(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          const { version } = body as { version?: unknown };
          if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
            respond(res, 400, {
              ok: false,
              error: 'activate requires "version" (integer >= 1)',
            });
            return;
          }
          const resource = ui.activate(name, version);
          if (resource === null) {
            respond(res, 404, { ok: false, error: `no such ui resource: ${name}@v${version}` });
            return;
          }
          respond(res, 200, { ok: true, resource });
          uiMutated(); // activate committed → list_changed (Stage 34)
          return;
        }

        // GET /api/v1/ui/resources/<name>/<version> — the one door serving html.
        if (sub !== null) {
          if (method !== 'GET' || !/^[1-9][0-9]*$/.test(sub)) {
            respond(res, 404, { ok: false, error: 'not found' });
            return;
          }
          const resource = ui.get(name, Number.parseInt(sub, 10));
          if (resource === null) {
            respond(res, 404, { ok: false, error: `no such ui resource: ${name}@v${sub}` });
            return;
          }
          respond(res, 200, { ok: true, resource });
          return;
        }

        // GET /api/v1/ui/resources/<name> — every version, html omitted.
        if (method !== 'GET') {
          respond(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const versions = ui.versions(name);
        if (versions.length === 0) {
          respond(res, 404, { ok: false, error: `no such ui resource: ${name}` });
          return;
        }
        const active = versions.find((v) => v.active)?.version ?? null;
        respond(res, 200, { ok: true, name, active, versions });
        return;
      }

      // Stage 37 — the per-name state document (contracts/ui-state.md v1):
      //   GET  /api/v1/ui/state/<name>  → { ok, name, value, updatedAt }
      //                                   (value AND updatedAt null before
      //                                   the first set)
      //   POST /api/v1/ui/state/<name>  — body { value } → { ok, name,
      //                                   updatedAt } (full replace — the
      //                                   assistant's seeding door)
      // A DIFFERENT sub-path from /resources/<name>(/<v>|/activate) — neither
      // regex can swallow the other. Thin doors over src/ui/state.ts:
      // unknown name → 404, oversize/non-JSON → 422, both via UiRegistryError
      // in the outer catch; body-shape errors → 400 here.
      const uiStateMatch = /^\/api\/v1\/ui\/state\/([^/]+)$/.exec(path);
      if (uiStateMatch !== null) {
        const name = decodeURIComponent(uiStateMatch[1] as string);

        if (method === 'GET') {
          respond(res, 200, { ok: true, ...uiState.get(name) });
          return;
        }

        if (method === 'POST') {
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            respond(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          if (
            typeof body !== 'object' ||
            body === null ||
            Array.isArray(body) ||
            !('value' in body)
          ) {
            respond(res, 400, {
              ok: false,
              error: 'state set requires body { value } (value: any JSON document)',
            });
            return;
          }
          const set = uiState.set(name, (body as { value: unknown }).value);
          respond(res, 200, { ok: true, name: set.name, updatedAt: set.updatedAt });
          return;
        }

        respond(res, 404, { ok: false, error: 'not found' });
        return;
      }

      // POST /api/v1/ui/grants — body { name, tool, approvalText } (Stage 33):
      // record the owner's approval durably. Idempotent per (name, tool)
      // while an unrevoked grant exists. Unknown resource → 404, tool outside
      // the frozen MCP catalog → 422 — both raised by the registry as
      // UiRegistryError (thin door, logic in src/ui/registry.ts).
      if (method === 'POST' && path === '/api/v1/ui/grants') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          respond(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const { name, tool, approvalText } = body as {
          name?: unknown;
          tool?: unknown;
          approvalText?: unknown;
        };
        if (typeof name !== 'string' || name === '') {
          respond(res, 400, { ok: false, error: 'grant requires "name" (non-empty string)' });
          return;
        }
        if (typeof tool !== 'string' || tool === '') {
          respond(res, 400, { ok: false, error: 'grant requires "tool" (non-empty string)' });
          return;
        }
        if (typeof approvalText !== 'string' || approvalText === '') {
          respond(res, 400, {
            ok: false,
            error:
              'grant requires "approvalText" (non-empty string — the owner\'s approval message)',
          });
          return;
        }
        respond(res, 200, { ok: true, grant: ui.grant(name, tool, approvalText) });
        uiMutated(); // grant committed → list_changed (Stage 34)
        return;
      }

      // POST /api/v1/ui/grants/revoke — body { name, tool } (Stage 33): sets
      // revokedAt on the active grant row (rows are NEVER deleted — the
      // approval history stays durable). Immediate across all versions of the
      // name. No active grant / unknown resource → 404; unknown tool → 422.
      if (method === 'POST' && path === '/api/v1/ui/grants/revoke') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          respond(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const { name, tool } = body as { name?: unknown; tool?: unknown };
        if (typeof name !== 'string' || name === '') {
          respond(res, 400, { ok: false, error: 'revoke requires "name" (non-empty string)' });
          return;
        }
        if (typeof tool !== 'string' || tool === '') {
          respond(res, 400, { ok: false, error: 'revoke requires "tool" (non-empty string)' });
          return;
        }
        respond(res, 200, { ok: true, grant: ui.revoke(name, tool) });
        uiMutated(); // revoke committed → list_changed (Stage 34)
        return;
      }

      respond(res, 404, { ok: false, error: 'not found' });
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
      if (err instanceof RemarkableError) {
        // reMarkable push refused (feature dark) or the rmapi/cloud transport
        // failed (non-zero exit).
        respond(res, err.status, { ok: false, error: err.message });
        return;
      }
      if (err instanceof UiRegistryError) {
        // Rejected ui input: bad name, unknown tool, or invalid HTML → 422
        // (with the machine-readable verdict when validation failed); unknown
        // resource name / no active grant → 404 (Stage 33).
        respond(res, err.status, {
          ok: false,
          error: err.message,
          ...(err.verdict === undefined ? {} : { verdict: err.verdict }),
        });
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

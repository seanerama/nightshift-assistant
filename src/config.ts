/**
 * Config contract: the code reads NOTHING undocumented — every env var read here
 * is documented in .env.example. Fail fast on missing required values; refuse to
 * start unless the kill-switch (NIGHTSHIFT_ENABLED=true) is explicitly flipped.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The infrastructure the promotion pipeline (Stage 11, contracts/promotion.md)
 * talks to. DAEMON-ONLY by construction: workerEnv() hard-blocks the CF_ and
 * COOLIFY_ prefixes, so no worker session can ever receive these (ADR 0008).
 */
export interface PromoteConfig {
  /** Coolify base URL (no /api/v1 suffix) — tests point it at a fixture. */
  coolifyApiUrl: string;
  coolifyApiToken: string;
  coolifyProjectUuid: string;
  coolifyServerUuid: string;
  /** Coolify environment name (e.g. "production"). */
  coolifyEnvironment: string;
  cfAccountId: string;
  cfZoneId: string;
  cfTunnelId: string;
  cfDnsToken: string;
  /** Public apex domain — promotions go live at https://<slug>.<domain>. */
  domain: string;
  /** Cloudflare API base (TEST SEAM; default https://api.cloudflare.com/client/v4). */
  cfApiBase: string;
  /**
   * Health-check base (TEST SEAM): when set, the final health step GETs
   * <base>/<slug> (subdomain pipeline) or <base>/study-guides/<slug> (site
   * pipeline) instead of the real https URL. '' in production.
   */
  healthBase: string;
  /**
   * Local clone of the Astro website repo (Stage 13, contracts/
   * site-promotion.md) — study promotions are staged, built, and pushed here.
   * Required (existing git clone) when promotion is enabled; fail fast at
   * startup, never at step 3 of a live run.
   */
  websiteRepo: string;
  /** bun binary for the website build (TEST SEAM; default "bun"). */
  bunPath: string;
}

export interface Config {
  /** Webex bot access token (required). */
  webexBotToken: string;
  /** Webhook HMAC secret (required; fail closed when unset). */
  webexWebhookSecret: string;
  /** The owner's Webex personId — the only authorized sender (required). */
  webexOwnerPersonId: string;
  /** Webex API base URL (test seam; default https://webexapis.com/v1). */
  webexApiBase: string;
  /** Path to the claude binary (test seam; default "claude"). */
  agentBin: string;
  /**
   * Conversational model (Stage 12): passed as `--model` on EVERY
   * conversational spawn — explicit, never inherited from the host claude
   * config (which silently served Opus 4.7 for everything, issue #22).
   * Runtime config, NOT a feature: applies regardless of the control
   * kill-switch. Default claude-sonnet-5 (the front door routes/dispatches;
   * responsiveness and cost win). Workers use the per-type registry models
   * instead (src/jobs/types.ts).
   */
  model: string;
  /** SQLite database file path. */
  dbPath: string;
  /** HTTP listen port (loopback only — the bind address is not configurable). */
  port: number;
  /** Seconds before an in-flight agent turn is killed and reported as an error. */
  turnTimeoutSec: number;
  /**
   * Seconds of silence before a one-time "working on it" receipt is sent for a
   * slow turn (Stage 8). 0 disables the ack entirely; default 5.
   */
  ackAfterSec: number;
  /**
   * Master switch for the rotation triggers + session seeding (Stage 2).
   * Default OFF — with it unset, relay behavior is identical to Stage 1.
   */
  rotationEnabled: boolean;
  /** Local hour (0-23) after which the daily rotation fires (default 4). */
  rotateHour: number;
  /** Turn count a relay must push PAST to trigger a size-cap rotation. */
  sizeCapTurns: number;
  /** Max bytes of seed context handed to a brand-new session (newest wins). */
  seedMaxBytes: number;
  /**
   * Master switch for the job runner (Stage 4). Default OFF — with it unset,
   * submit() rejects and no reconciler/poller runs.
   */
  jobsEnabled: boolean;
  /**
   * Max concurrently LIVE worker processes (reconciler-counted, not row
   * counts). Default 1 — jobs run in sequence; parallel workers on the same
   * subscription exhaust the session limit (2026-07-08: 3 concurrent study
   * workers, each fanning out research sub-agents, hit it mid-build).
   */
  maxJobs: number;
  /** Attempts bound: a job failing this many times lands terminal `failed`. */
  jobRetryCap: number;
  /** Seconds between kill()'s SIGTERM and the SIGKILL follow-up. */
  jobKillGraceSec: number;
  /**
   * Default per-job wall-clock timeout in ms (Stage 21). A `running` worker
   * whose PERSISTED start time is older than this — or its per-type override
   * (JobType.timeoutMs, src/jobs/types.ts) — is killed by the reconciler
   * (SIGTERM→SIGKILL) and recorded terminally as timed out, so a worker whose
   * model call stalls (observed live: a note-ingest blocked in ep_poll) fails
   * cleanly instead of hanging forever. Generous by default (2h) — safely above
   * the longest legitimate content/app-build pipeline — so existing jobs are
   * never cut short. Validated fail-closed like the other job numbers.
   */
  jobTimeoutMs: number;
  /**
   * Master switch for the control surface (Stage 5): /api/v1/, the nightshift
   * CLI, and the conversational session's Bash(nightshift *) tool access.
   * Default OFF — with it unset, /api/v1/ returns 403 and session spawns are
   * byte-identical to Stage 4.
   */
  controlEnabled: boolean;
  /**
   * Per-install bearer token required on every /api/v1/ request (fail closed:
   * empty → every request 401s). Required non-empty when control is enabled.
   * Never enters workerEnv() — only the conversational session's spawn env.
   */
  apiToken: string;
  /**
   * Master switch for the job-type registry (Stage 6). Default OFF — with it
   * unset, submits of any non-generic type reject with a clear error, workers
   * spawn exactly as Stage 5 (no permission args, no extra env), and the
   * session preamble omits the type list. Generic submits are unaffected.
   */
  typesEnabled: boolean;
  /**
   * Per-file attachment cap in MB for send()/deliver (Stage 10; Webex's own
   * cap is ~100MB). Files over this are rejected with a clear error before
   * anything is sent. 0 disables file attachments entirely.
   */
  attachMaxMb: number;
  /**
   * Auto-attach cap in MB (Stage 10): success-notice sentinel outputs at or
   * under this size ride the notice (bounded count). 0 disables auto-attach.
   */
  autoAttachMaxMb: number;
  /**
   * Master switch for content promotion (Stage 11). Default OFF — with it
   * unset, POST /api/v1/promote and `nightshift promote` refuse, and the
   * session preamble omits the promote line. When it IS enabled, startup
   * fails fast unless all ten infra env names in `promote` are set.
   */
  promoteEnabled: boolean;
  /** Promotion infra (contracts/promotion.md "Consumes") — daemon-only creds. */
  promote: PromoteConfig;
  /**
   * Master switch for reMarkable PUSH (Stage 19). Default OFF — with it unset,
   * POST /api/v1/remarkable and `nightshift remarkable` refuse (403), and the
   * session preamble omits the remarkable line. The "assistant → tablet" bridge.
   */
  remarkableEnabled: boolean;
  /** Destination folder on the tablet for pushed docs (default /Inbox). */
  remarkableFolder: string;
  /**
   * Path to the rmapi binary on the host (default "rmapi"). rmapi + its config
   * (the reMarkable device token) are a daemon-only host secret provisioned at
   * deploy — never in workerEnv, never in git. This is just the binary path.
   */
  rmapiBin: string;
  /**
   * Master switch for the app transport (Stage 24, contracts/app-ingress.md,
   * ADR 0009). Default OFF — with it unset, the app listener never starts and
   * no /app/v1/ route exists (absent, not 403).
   */
  appTransportEnabled: boolean;
  /**
   * Per-install bearer token required on every /app/v1/ request (ADR 0011) —
   * distinct from NIGHTSHIFT_API_TOKEN so the phone credential rotates without
   * touching the control plane. Deliberately NOT validated here: flag on with
   * the token unset must leave the daemon healthy while the app LISTENER
   * refuses to start (fail closed) — that check lives in app.ts.
   */
  appToken: string;
  /**
   * Bind addresses for the app transport's own HTTP server (ADR 0011):
   * loopback + the tailnet interface only, comma-separated in env. Never an
   * all-interfaces address — 0.0.0.0/:: fail fast at startup.
   */
  appBind: string[];
  /** App transport listen port (default 3778 — distinct from the daemon's 3777). */
  appPort: number;
  /**
   * Master switch for generative UI (Stage 31, contracts/generative-ui.md,
   * ADRs 0013–0015). Default OFF — with it unset, the /api/v1/ui/* doors 404
   * (feature absent), the `nightshift ui` verbs refuse, and MCP
   * resources/list carries no registry rows (byte-identical to Stage 28).
   */
  generativeUiEnabled: boolean;
  /**
   * Master switch for the hook ingress (Stage 39, contracts/hook-ingress.md,
   * ADR 0018). Default OFF — with it unset, the /hook/v1/ handler is never
   * mounted and every /hook/v1/* path is the server's ordinary 404 (absent,
   * indistinguishable from any unknown path).
   */
  hookIngressEnabled: boolean;
  /**
   * Bearer token required on every /hook/v1/ request — owner-equivalent (a
   * password), DISTINCT from NIGHTSHIFT_API_TOKEN and NIGHTSHIFT_APP_TOKEN so
   * it rotates independently. Deliberately NOT validated here: flag on with
   * the token unset must leave the daemon healthy while every hook route
   * refuses (401) — that fail-closed check + startup error log live in app.ts.
   */
  hookToken: string;
  /** Default synchronous wait for POST /hook/v1/messages (0..hookMaxWaitSec). */
  hookDefaultWaitSec: number;
  /** Upper bound on a caller's `wait` (0..120 — bounded HTTP occupancy). */
  hookMaxWaitSec: number;
  /** POST token-bucket refill rate per minute (burst 3, fixed by contract). */
  hookRatePerMin: number;
  /** GET (poll) token-bucket refill rate per minute. */
  hookPollRatePerMin: number;
  /** POST ⇒ 429 while this many hook turns are pending. */
  hookMaxPending: number;
  /** completed/failed hook_messages rows older than this are pruned on insert. */
  hookRetentionDays: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.NIGHTSHIFT_ENABLED !== 'true') {
    throw new ConfigError(
      'kill-switch: NIGHTSHIFT_ENABLED must be exactly "true" to start (default OFF — the spine ships dark)',
    );
  }

  const missing: string[] = [];
  const required = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') {
      missing.push(name);
      return '';
    }
    return v;
  };

  const webexBotToken = required('WEBEX_BOT_TOKEN');
  const webexWebhookSecret = required('WEBEX_WEBHOOK_SECRET');
  const webexOwnerPersonId = required('WEBEX_OWNER_PERSON_ID');
  if (missing.length > 0) {
    throw new ConfigError(`missing required env: ${missing.join(', ')}`);
  }

  const port = Number.parseInt(env.NIGHTSHIFT_PORT ?? '3777', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`NIGHTSHIFT_PORT is not a valid port: ${env.NIGHTSHIFT_PORT}`);
  }

  // Conversational model (Stage 12): '' is treated as unset (matching the
  // other optional vars), but a set value must be a non-blank model id —
  // whitespace garbage fails fast rather than spawning `--model " "`.
  let model = 'claude-sonnet-5';
  if (env.NIGHTSHIFT_MODEL !== undefined && env.NIGHTSHIFT_MODEL !== '') {
    model = env.NIGHTSHIFT_MODEL.trim();
    if (model === '') {
      throw new ConfigError('NIGHTSHIFT_MODEL must be a non-empty model id (e.g. claude-sonnet-5)');
    }
  }

  const turnTimeoutSec = Number.parseInt(env.NIGHTSHIFT_TURN_TIMEOUT_SEC ?? '300', 10);
  if (!Number.isInteger(turnTimeoutSec) || turnTimeoutSec < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_TURN_TIMEOUT_SEC is not a valid positive integer: ${env.NIGHTSHIFT_TURN_TIMEOUT_SEC}`,
    );
  }

  // Ack threshold: 0 disables the receipt signal entirely (the only knob).
  const ackAfterSec = Number.parseInt(env.NIGHTSHIFT_ACK_AFTER_SEC ?? '5', 10);
  if (!Number.isInteger(ackAfterSec) || ackAfterSec < 0) {
    throw new ConfigError(
      `NIGHTSHIFT_ACK_AFTER_SEC is not a valid non-negative integer: ${env.NIGHTSHIFT_ACK_AFTER_SEC}`,
    );
  }

  // Rotation kill-switch: only exactly "true" enables; "false"/unset stay dark;
  // anything else is a config mistake — fail fast rather than silently disable.
  const rotationRaw = env.NIGHTSHIFT_ROTATION_ENABLED;
  if (
    rotationRaw !== undefined &&
    rotationRaw !== '' &&
    rotationRaw !== 'true' &&
    rotationRaw !== 'false'
  ) {
    throw new ConfigError(
      `NIGHTSHIFT_ROTATION_ENABLED must be "true" or "false" (got: ${rotationRaw})`,
    );
  }
  const rotationEnabled = rotationRaw === 'true';

  const rotateHour = Number.parseInt(env.NIGHTSHIFT_ROTATE_HOUR ?? '4', 10);
  if (!Number.isInteger(rotateHour) || rotateHour < 0 || rotateHour > 23) {
    throw new ConfigError(
      `NIGHTSHIFT_ROTATE_HOUR is not a valid hour (0-23): ${env.NIGHTSHIFT_ROTATE_HOUR}`,
    );
  }

  const sizeCapTurns = Number.parseInt(env.NIGHTSHIFT_SIZE_CAP_TURNS ?? '200', 10);
  if (!Number.isInteger(sizeCapTurns) || sizeCapTurns < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_SIZE_CAP_TURNS is not a valid positive integer: ${env.NIGHTSHIFT_SIZE_CAP_TURNS}`,
    );
  }

  const seedMaxBytes = Number.parseInt(env.NIGHTSHIFT_SEED_MAX_BYTES ?? '16384', 10);
  if (!Number.isInteger(seedMaxBytes) || seedMaxBytes < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_SEED_MAX_BYTES is not a valid positive integer: ${env.NIGHTSHIFT_SEED_MAX_BYTES}`,
    );
  }

  // Job-runner kill-switch: same discipline as rotation — only exactly "true"
  // enables; "false"/unset stay dark; anything else fails fast.
  const jobsRaw = env.NIGHTSHIFT_JOBS_ENABLED;
  if (jobsRaw !== undefined && jobsRaw !== '' && jobsRaw !== 'true' && jobsRaw !== 'false') {
    throw new ConfigError(`NIGHTSHIFT_JOBS_ENABLED must be "true" or "false" (got: ${jobsRaw})`);
  }
  const jobsEnabled = jobsRaw === 'true';

  const maxJobs = Number.parseInt(env.NIGHTSHIFT_MAX_JOBS ?? '1', 10);
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_MAX_JOBS is not a valid positive integer: ${env.NIGHTSHIFT_MAX_JOBS}`,
    );
  }

  const jobRetryCap = Number.parseInt(env.NIGHTSHIFT_JOB_RETRY_CAP ?? '2', 10);
  if (!Number.isInteger(jobRetryCap) || jobRetryCap < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_JOB_RETRY_CAP is not a valid positive integer: ${env.NIGHTSHIFT_JOB_RETRY_CAP}`,
    );
  }

  const jobKillGraceSec = Number.parseInt(env.NIGHTSHIFT_JOB_KILL_GRACE_SEC ?? '10', 10);
  if (!Number.isInteger(jobKillGraceSec) || jobKillGraceSec < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_JOB_KILL_GRACE_SEC is not a valid positive integer: ${env.NIGHTSHIFT_JOB_KILL_GRACE_SEC}`,
    );
  }

  // Per-job wall-clock timeout (Stage 21): generous default (2h) — safely above
  // the longest legitimate content/app-build pipeline, so a real job is never
  // cut short; a stalled worker (which would otherwise hang forever) is reaped.
  // Positive integer, fail-closed like the other job numbers.
  const jobTimeoutMs = Number.parseInt(env.NIGHTSHIFT_JOB_TIMEOUT_MS ?? '7200000', 10);
  if (!Number.isInteger(jobTimeoutMs) || jobTimeoutMs < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_JOB_TIMEOUT_MS is not a valid positive integer: ${env.NIGHTSHIFT_JOB_TIMEOUT_MS}`,
    );
  }

  // Control-surface kill-switch: same discipline as rotation/jobs — only
  // exactly "true" enables; "false"/unset stay dark; anything else fails fast.
  const controlRaw = env.NIGHTSHIFT_CONTROL_ENABLED;
  if (
    controlRaw !== undefined &&
    controlRaw !== '' &&
    controlRaw !== 'true' &&
    controlRaw !== 'false'
  ) {
    throw new ConfigError(
      `NIGHTSHIFT_CONTROL_ENABLED must be "true" or "false" (got: ${controlRaw})`,
    );
  }
  const controlEnabled = controlRaw === 'true';

  // Job-type-registry kill-switch: same discipline — only exactly "true"
  // enables; "false"/unset stay dark; anything else fails fast.
  const typesRaw = env.NIGHTSHIFT_TYPES_ENABLED;
  if (typesRaw !== undefined && typesRaw !== '' && typesRaw !== 'true' && typesRaw !== 'false') {
    throw new ConfigError(`NIGHTSHIFT_TYPES_ENABLED must be "true" or "false" (got: ${typesRaw})`);
  }
  const typesEnabled = typesRaw === 'true';

  // Attachment knobs (Stage 10): non-negative integers; 0 disables the feature.
  const attachMaxMb = Number.parseInt(env.NIGHTSHIFT_ATTACH_MAX_MB ?? '80', 10);
  if (!Number.isInteger(attachMaxMb) || attachMaxMb < 0) {
    throw new ConfigError(
      `NIGHTSHIFT_ATTACH_MAX_MB is not a valid non-negative integer: ${env.NIGHTSHIFT_ATTACH_MAX_MB}`,
    );
  }

  const autoAttachMaxMb = Number.parseInt(env.NIGHTSHIFT_AUTOATTACH_MAX_MB ?? '10', 10);
  if (!Number.isInteger(autoAttachMaxMb) || autoAttachMaxMb < 0) {
    throw new ConfigError(
      `NIGHTSHIFT_AUTOATTACH_MAX_MB is not a valid non-negative integer: ${env.NIGHTSHIFT_AUTOATTACH_MAX_MB}`,
    );
  }

  const apiToken = env.NIGHTSHIFT_API_TOKEN ?? '';
  if (controlEnabled && apiToken === '') {
    throw new ConfigError(
      'NIGHTSHIFT_API_TOKEN must be set (non-empty) when NIGHTSHIFT_CONTROL_ENABLED=true — the control API fails closed without it',
    );
  }

  // Promotion kill-switch (Stage 11): same discipline — only exactly "true"
  // enables; "false"/unset stay dark; anything else fails fast.
  const promoteRaw = env.NIGHTSHIFT_PROMOTE_ENABLED;
  if (
    promoteRaw !== undefined &&
    promoteRaw !== '' &&
    promoteRaw !== 'true' &&
    promoteRaw !== 'false'
  ) {
    throw new ConfigError(
      `NIGHTSHIFT_PROMOTE_ENABLED must be "true" or "false" (got: ${promoteRaw})`,
    );
  }
  const promoteEnabled = promoteRaw === 'true';

  // The ten infra env names the promotion contract consumes. All REQUIRED
  // (non-empty) when promotion is enabled — a half-configured pipeline must
  // refuse to start, not fail at step 4 of a live run.
  const PROMOTE_ENV_NAMES = [
    'COOLIFY_API_URL',
    'COOLIFY_API_TOKEN',
    'COOLIFY_PROJECT_UUID',
    'COOLIFY_SERVER_UUID',
    'COOLIFY_ENVIRONMENT',
    'CF_ACCOUNT_ID',
    'CF_ZONE_ID',
    'CF_TUNNEL_ID',
    'CF_DNS_TOKEN',
    'NSAF_DOMAIN',
  ] as const;
  if (promoteEnabled) {
    const absent = PROMOTE_ENV_NAMES.filter((name) => env[name] === undefined || env[name] === '');
    if (absent.length > 0) {
      throw new ConfigError(
        `NIGHTSHIFT_PROMOTE_ENABLED=true requires all promotion env vars; missing: ${absent.join(', ')}`,
      );
    }
  }

  // Website repo (Stage 13, contracts/site-promotion.md): required when
  // promotion is enabled, and it must already be a git clone — a missing or
  // non-git path fails fast at startup, not mid-pipeline.
  const websiteRepo = env.NIGHTSHIFT_WEBSITE_REPO ?? '';
  if (promoteEnabled) {
    if (websiteRepo === '') {
      throw new ConfigError(
        'NIGHTSHIFT_PROMOTE_ENABLED=true requires NIGHTSHIFT_WEBSITE_REPO (local clone of the Astro website repo)',
      );
    }
    if (!existsSync(websiteRepo)) {
      throw new ConfigError(`NIGHTSHIFT_WEBSITE_REPO does not exist: ${websiteRepo}`);
    }
    if (!existsSync(join(websiteRepo, '.git'))) {
      throw new ConfigError(`NIGHTSHIFT_WEBSITE_REPO is not a git clone (no .git): ${websiteRepo}`);
    }
  }

  const promote: PromoteConfig = {
    coolifyApiUrl: env.COOLIFY_API_URL ?? '',
    coolifyApiToken: env.COOLIFY_API_TOKEN ?? '',
    coolifyProjectUuid: env.COOLIFY_PROJECT_UUID ?? '',
    coolifyServerUuid: env.COOLIFY_SERVER_UUID ?? '',
    coolifyEnvironment: env.COOLIFY_ENVIRONMENT ?? '',
    cfAccountId: env.CF_ACCOUNT_ID ?? '',
    cfZoneId: env.CF_ZONE_ID ?? '',
    cfTunnelId: env.CF_TUNNEL_ID ?? '',
    cfDnsToken: env.CF_DNS_TOKEN ?? '',
    domain: env.NSAF_DOMAIN ?? '',
    cfApiBase: env.CF_API_BASE ?? 'https://api.cloudflare.com/client/v4',
    healthBase: env.NIGHTSHIFT_PROMOTE_HEALTH_BASE ?? '',
    websiteRepo,
    // '' is treated as unset (matching the other optional vars) → default bun.
    bunPath:
      env.NIGHTSHIFT_BUN_PATH === undefined || env.NIGHTSHIFT_BUN_PATH === ''
        ? 'bun'
        : env.NIGHTSHIFT_BUN_PATH,
  };

  // reMarkable PUSH kill-switch (Stage 19): same discipline as the other
  // feature flags — only exactly "true" enables; "false"/unset stay dark;
  // anything else fails fast.
  const remarkableRaw = env.NIGHTSHIFT_REMARKABLE_ENABLED;
  if (
    remarkableRaw !== undefined &&
    remarkableRaw !== '' &&
    remarkableRaw !== 'true' &&
    remarkableRaw !== 'false'
  ) {
    throw new ConfigError(
      `NIGHTSHIFT_REMARKABLE_ENABLED must be "true" or "false" (got: ${remarkableRaw})`,
    );
  }
  const remarkableEnabled = remarkableRaw === 'true';

  // '' is treated as unset (matching the other optional vars) → default /Inbox.
  const remarkableFolder =
    env.NIGHTSHIFT_REMARKABLE_FOLDER === undefined || env.NIGHTSHIFT_REMARKABLE_FOLDER === ''
      ? '/Inbox'
      : env.NIGHTSHIFT_REMARKABLE_FOLDER;

  // '' is treated as unset → default rmapi (resolved on the daemon's PATH).
  const rmapiBin = env.RMAPI_BIN === undefined || env.RMAPI_BIN === '' ? 'rmapi' : env.RMAPI_BIN;

  // App-transport kill-switch (Stage 24): same discipline as the other feature
  // flags — only exactly "true" enables; "false"/unset stay dark; anything
  // else fails fast.
  const appRaw = env.APP_TRANSPORT_ENABLED;
  if (appRaw !== undefined && appRaw !== '' && appRaw !== 'true' && appRaw !== 'false') {
    throw new ConfigError(`APP_TRANSPORT_ENABLED must be "true" or "false" (got: ${appRaw})`);
  }
  const appTransportEnabled = appRaw === 'true';

  // NOT required-when-enabled on purpose (unlike NIGHTSHIFT_API_TOKEN): the
  // contract wants flag-on + token-unset to refuse the app LISTENER only,
  // with the daemon otherwise healthy. app.ts owns that fail-closed check.
  const appToken = env.NIGHTSHIFT_APP_TOKEN ?? '';

  const appPort = Number.parseInt(env.NIGHTSHIFT_APP_PORT ?? '3778', 10);
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
    throw new ConfigError(`NIGHTSHIFT_APP_PORT is not a valid port: ${env.NIGHTSHIFT_APP_PORT}`);
  }

  // Bind addresses (ADR 0011): loopback by default; deploy adds the tailnet
  // IP (Stage 29). An all-interfaces bind is a config mistake that would
  // silently expose the surface — fail fast, never listen.
  const appBind = (
    env.NIGHTSHIFT_APP_BIND === undefined || env.NIGHTSHIFT_APP_BIND === ''
      ? '127.0.0.1'
      : env.NIGHTSHIFT_APP_BIND
  )
    .split(',')
    .map((addr) => addr.trim())
    .filter((addr) => addr !== '');
  if (appBind.length === 0) {
    throw new ConfigError(
      `NIGHTSHIFT_APP_BIND must name at least one address: ${env.NIGHTSHIFT_APP_BIND}`,
    );
  }
  for (const addr of appBind) {
    if (addr === '0.0.0.0' || addr === '::' || addr === '[::]') {
      throw new ConfigError(
        `NIGHTSHIFT_APP_BIND must never be an all-interfaces address (got: ${addr}) — ` +
          'bind loopback + the tailnet IP only (ADR 0011)',
      );
    }
  }

  // Generative-UI kill-switch (Stage 31): same discipline as the other feature
  // flags — only exactly "true" enables; "false"/unset stay dark; anything
  // else fails fast.
  const generativeUiRaw = env.NIGHTSHIFT_GENERATIVE_UI_ENABLED;
  if (
    generativeUiRaw !== undefined &&
    generativeUiRaw !== '' &&
    generativeUiRaw !== 'true' &&
    generativeUiRaw !== 'false'
  ) {
    throw new ConfigError(
      `NIGHTSHIFT_GENERATIVE_UI_ENABLED must be "true" or "false" (got: ${generativeUiRaw})`,
    );
  }
  const generativeUiEnabled = generativeUiRaw === 'true';

  // Hook-ingress kill-switch (Stage 39): same discipline as the other feature
  // flags — only exactly "true" enables; "false"/unset stay dark; anything
  // else fails fast.
  const hookRaw = env.HOOK_INGRESS_ENABLED;
  if (hookRaw !== undefined && hookRaw !== '' && hookRaw !== 'true' && hookRaw !== 'false') {
    throw new ConfigError(`HOOK_INGRESS_ENABLED must be "true" or "false" (got: ${hookRaw})`);
  }
  const hookIngressEnabled = hookRaw === 'true';

  // NOT required-when-enabled on purpose (same as NIGHTSHIFT_APP_TOKEN): flag
  // on + token unset refuses every hook route (401) with the daemon otherwise
  // healthy. app.ts owns that fail-closed check and its startup error log.
  const hookToken = env.NIGHTSHIFT_HOOK_TOKEN ?? '';

  // Hook tunables (contracts/hook-ingress.md defaults). The max wait is
  // bounded at 120s — a synchronous wait occupies an HTTP connection behind
  // the serialized relay queue; poll is the real delivery guarantee.
  const hookMaxWaitSec = Number.parseInt(env.HOOK_MAX_WAIT_SEC ?? '55', 10);
  if (!Number.isInteger(hookMaxWaitSec) || hookMaxWaitSec < 0 || hookMaxWaitSec > 120) {
    throw new ConfigError(
      `HOOK_MAX_WAIT_SEC is not a valid integer (0-120): ${env.HOOK_MAX_WAIT_SEC}`,
    );
  }
  const hookDefaultWaitSec = Number.parseInt(env.HOOK_DEFAULT_WAIT_SEC ?? '25', 10);
  if (
    !Number.isInteger(hookDefaultWaitSec) ||
    hookDefaultWaitSec < 0 ||
    hookDefaultWaitSec > hookMaxWaitSec
  ) {
    throw new ConfigError(
      `HOOK_DEFAULT_WAIT_SEC is not a valid integer (0-HOOK_MAX_WAIT_SEC=${hookMaxWaitSec}): ${env.HOOK_DEFAULT_WAIT_SEC}`,
    );
  }
  const hookRatePerMin = Number.parseInt(env.HOOK_RATE_PER_MIN ?? '6', 10);
  if (!Number.isInteger(hookRatePerMin) || hookRatePerMin < 1 || hookRatePerMin > 600) {
    throw new ConfigError(
      `HOOK_RATE_PER_MIN is not a valid integer (1-600): ${env.HOOK_RATE_PER_MIN}`,
    );
  }
  const hookPollRatePerMin = Number.parseInt(env.HOOK_POLL_RATE_PER_MIN ?? '60', 10);
  if (!Number.isInteger(hookPollRatePerMin) || hookPollRatePerMin < 1 || hookPollRatePerMin > 600) {
    throw new ConfigError(
      `HOOK_POLL_RATE_PER_MIN is not a valid integer (1-600): ${env.HOOK_POLL_RATE_PER_MIN}`,
    );
  }
  const hookMaxPending = Number.parseInt(env.HOOK_MAX_PENDING ?? '3', 10);
  if (!Number.isInteger(hookMaxPending) || hookMaxPending < 1 || hookMaxPending > 100) {
    throw new ConfigError(
      `HOOK_MAX_PENDING is not a valid integer (1-100): ${env.HOOK_MAX_PENDING}`,
    );
  }
  const hookRetentionDays = Number.parseInt(env.HOOK_RETENTION_DAYS ?? '7', 10);
  if (!Number.isInteger(hookRetentionDays) || hookRetentionDays < 1 || hookRetentionDays > 3650) {
    throw new ConfigError(
      `HOOK_RETENTION_DAYS is not a valid integer (1-3650): ${env.HOOK_RETENTION_DAYS}`,
    );
  }

  return {
    webexBotToken,
    webexWebhookSecret,
    webexOwnerPersonId,
    webexApiBase: env.WEBEX_API_BASE ?? 'https://webexapis.com/v1',
    agentBin: env.NIGHTSHIFT_AGENT_BIN ?? 'claude',
    model,
    dbPath: env.NIGHTSHIFT_DB_PATH ?? 'data/nightshift.db',
    port,
    turnTimeoutSec,
    ackAfterSec,
    rotationEnabled,
    rotateHour,
    sizeCapTurns,
    seedMaxBytes,
    jobsEnabled,
    maxJobs,
    jobRetryCap,
    jobKillGraceSec,
    jobTimeoutMs,
    controlEnabled,
    apiToken,
    typesEnabled,
    attachMaxMb,
    autoAttachMaxMb,
    promoteEnabled,
    promote,
    remarkableEnabled,
    remarkableFolder,
    rmapiBin,
    appTransportEnabled,
    appToken,
    appBind,
    appPort,
    generativeUiEnabled,
    hookIngressEnabled,
    hookToken,
    hookDefaultWaitSec,
    hookMaxWaitSec,
    hookRatePerMin,
    hookPollRatePerMin,
    hookMaxPending,
    hookRetentionDays,
  };
}

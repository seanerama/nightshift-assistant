/**
 * Config contract: the code reads NOTHING undocumented — every env var read here
 * is documented in .env.example. Fail fast on missing required values; refuse to
 * start unless the kill-switch (NIGHTSHIFT_ENABLED=true) is explicitly flipped.
 */

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
  /** SQLite database file path. */
  dbPath: string;
  /** HTTP listen port (loopback only — the bind address is not configurable). */
  port: number;
  /** Seconds before an in-flight agent turn is killed and reported as an error. */
  turnTimeoutSec: number;
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
  /** Max concurrently LIVE worker processes (reconciler-counted, not row counts). */
  maxJobs: number;
  /** Attempts bound: a job failing this many times lands terminal `failed`. */
  jobRetryCap: number;
  /** Seconds between kill()'s SIGTERM and the SIGKILL follow-up. */
  jobKillGraceSec: number;
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

  const turnTimeoutSec = Number.parseInt(env.NIGHTSHIFT_TURN_TIMEOUT_SEC ?? '300', 10);
  if (!Number.isInteger(turnTimeoutSec) || turnTimeoutSec < 1) {
    throw new ConfigError(
      `NIGHTSHIFT_TURN_TIMEOUT_SEC is not a valid positive integer: ${env.NIGHTSHIFT_TURN_TIMEOUT_SEC}`,
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

  const maxJobs = Number.parseInt(env.NIGHTSHIFT_MAX_JOBS ?? '2', 10);
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

  return {
    webexBotToken,
    webexWebhookSecret,
    webexOwnerPersonId,
    webexApiBase: env.WEBEX_API_BASE ?? 'https://webexapis.com/v1',
    agentBin: env.NIGHTSHIFT_AGENT_BIN ?? 'claude',
    dbPath: env.NIGHTSHIFT_DB_PATH ?? 'data/nightshift.db',
    port,
    turnTimeoutSec,
    rotationEnabled,
    rotateHour,
    sizeCapTurns,
    seedMaxBytes,
    jobsEnabled,
    maxJobs,
    jobRetryCap,
    jobKillGraceSec,
  };
}

/**
 * workerEnv() — THE sanitized-spawn environment builder (security carryover
 * FIX-H3; contracts/job-lifecycle.md "Consumes"). DEFAULT-DENY: the child env
 * is constructed from an explicit allow-list ONLY. Everything else — WEBEX_*
 * (bot token, webhook secret, owner id) and any future SMTP/Cloudflare/Coolify/
 * Postgres-admin credentials — is provably absent because nothing is copied
 * unless named here. Every future spawn type (workers today, other session
 * kinds later) MUST build its env through this helper; never pass process.env
 * (or a spread of it) to a worker spawn.
 */

/**
 * The complete allow-list. Base process identity plus the agent seam: the
 * `claude` CLI's own credentials/config, which the worker session IS and
 * therefore needs. Infra credentials are NOT agent seam vars — never add them.
 */
const ALLOWED_VARS: readonly string[] = [
  // Base process identity/locale.
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  // Agent seam: how the claude CLI authenticates/configures itself.
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/**
 * Prefixes that may NEVER be forwarded to a worker, no matter what a registry
 * entry's extraEnv names (Stage 6 guard): the daemon's own credentials/config
 * (WEBEX_* bot token/HMAC/owner, NIGHTSHIFT_API_TOKEN and friends). A worker
 * must not be able to drive its daemon or impersonate the bot (ADR 0007).
 */
const BLOCKED_PREFIXES: readonly string[] = ['WEBEX_', 'NIGHTSHIFT_'];

/** Build a worker child env: allow-listed keys copied from `base`, nothing else. */
export function workerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_VARS) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * workerEnv() plus a job type's extraEnv names (Stage 6): each name is copied
 * from `base` if present — an EXPLICIT, name-by-name extension of the same
 * default-deny base, never a wholesale copy. Blocked prefixes win over any
 * registry listing.
 */
export function workerEnvWith(
  extraNames: readonly string[],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = workerEnv(base);
  for (const name of extraNames) {
    if (BLOCKED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Kill-switch + fail-fast config contract (acceptance conditions). */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const FULL_ENV = {
  NIGHTSHIFT_ENABLED: 'true',
  WEBEX_BOT_TOKEN: 'token',
  WEBEX_WEBHOOK_SECRET: 'secret',
  WEBEX_OWNER_PERSON_ID: 'owner',
};

describe('loadConfig', () => {
  it('refuses to start without explicit NIGHTSHIFT_ENABLED=true (kill-switch, default OFF)', () => {
    const { NIGHTSHIFT_ENABLED: _omitted, ...rest } = FULL_ENV;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    expect(() => loadConfig({ ...rest, NIGHTSHIFT_ENABLED: 'false' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...rest, NIGHTSHIFT_ENABLED: '1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...rest, NIGHTSHIFT_ENABLED: 'TRUE' })).toThrow(ConfigError);
  });

  it.each([
    'WEBEX_BOT_TOKEN',
    'WEBEX_WEBHOOK_SECRET',
    'WEBEX_OWNER_PERSON_ID',
  ])('fails fast when %s is missing', (name) => {
    const env: Record<string, string> = { ...FULL_ENV };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(`missing required env.*${name}`));
    env[name] = '';
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('applies documented defaults when optional vars are unset', () => {
    const config = loadConfig({ ...FULL_ENV });
    expect(config.webexApiBase).toBe('https://webexapis.com/v1');
    expect(config.agentBin).toBe('claude');
    expect(config.model).toBe('claude-sonnet-5'); // Stage 12: explicit conversational model
    expect(config.dbPath).toBe('data/nightshift.db');
    expect(config.port).toBe(3777);
    expect(config.turnTimeoutSec).toBe(300);
    expect(config.ackAfterSec).toBe(5); // slow-turn receipt on by default
    expect(config.rotationEnabled).toBe(false); // rotation ships dark
    expect(config.rotateHour).toBe(4);
    expect(config.sizeCapTurns).toBe(200);
    expect(config.seedMaxBytes).toBe(16384);
    expect(config.jobsEnabled).toBe(false); // job runner ships dark
    expect(config.maxJobs).toBe(2);
    expect(config.jobRetryCap).toBe(2);
    expect(config.jobKillGraceSec).toBe(10);
    expect(config.controlEnabled).toBe(false); // control surface ships dark
    expect(config.apiToken).toBe('');
    expect(config.attachMaxMb).toBe(80); // Stage 10 delivery knobs
    expect(config.autoAttachMaxMb).toBe(10);
    expect(config.promoteEnabled).toBe(false); // promotion ships dark (Stage 11)
    expect(config.promote.cfApiBase).toBe('https://api.cloudflare.com/client/v4');
    expect(config.promote.healthBase).toBe('');
  });

  it('validates the Stage 10 attachment knobs (non-negative integers; 0 disables)', () => {
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ATTACH_MAX_MB: '50' }).attachMaxMb).toBe(50);
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ATTACH_MAX_MB: '0' }).attachMaxMb).toBe(0);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ATTACH_MAX_MB: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ATTACH_MAX_MB: 'big' })).toThrow(ConfigError);

    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_AUTOATTACH_MAX_MB: '5' }).autoAttachMaxMb).toBe(5);
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_AUTOATTACH_MAX_MB: '0' }).autoAttachMaxMb).toBe(0);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_AUTOATTACH_MAX_MB: '-2' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_AUTOATTACH_MAX_MB: 'ten' })).toThrow(
      ConfigError,
    );
  });

  it('validates NIGHTSHIFT_ACK_AFTER_SEC (non-negative integer; 0 disables)', () => {
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ACK_AFTER_SEC: '10' }).ackAfterSec).toBe(10);
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ACK_AFTER_SEC: '0' }).ackAfterSec).toBe(0);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ACK_AFTER_SEC: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ACK_AFTER_SEC: 'soon' })).toThrow(
      ConfigError,
    );
  });

  it('enables rotation only on exactly "true" and fails fast on garbage', () => {
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATION_ENABLED: 'true' }).rotationEnabled).toBe(
      true,
    );
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATION_ENABLED: 'false' }).rotationEnabled).toBe(
      false,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATION_ENABLED: 'TRUE' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATION_ENABLED: 'yes' })).toThrow(
      ConfigError,
    );
  });

  it('validates the rotation numbers (hour range, positive integers)', () => {
    const config = loadConfig({
      ...FULL_ENV,
      NIGHTSHIFT_ROTATE_HOUR: '0',
      NIGHTSHIFT_SIZE_CAP_TURNS: '3',
      NIGHTSHIFT_SEED_MAX_BYTES: '512',
    });
    expect(config.rotateHour).toBe(0);
    expect(config.sizeCapTurns).toBe(3);
    expect(config.seedMaxBytes).toBe(512);

    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATE_HOUR: '24' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_ROTATE_HOUR: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_SIZE_CAP_TURNS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_SEED_MAX_BYTES: 'lots' })).toThrow(
      ConfigError,
    );
  });

  it('enables the job runner only on exactly "true" and fails fast on garbage', () => {
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOBS_ENABLED: 'true' }).jobsEnabled).toBe(true);
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOBS_ENABLED: 'false' }).jobsEnabled).toBe(false);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOBS_ENABLED: 'TRUE' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOBS_ENABLED: 'on' })).toThrow(ConfigError);
  });

  it('validates the job-runner numbers (positive integers)', () => {
    const config = loadConfig({
      ...FULL_ENV,
      NIGHTSHIFT_MAX_JOBS: '1',
      NIGHTSHIFT_JOB_RETRY_CAP: '3',
      NIGHTSHIFT_JOB_KILL_GRACE_SEC: '5',
    });
    expect(config.maxJobs).toBe(1);
    expect(config.jobRetryCap).toBe(3);
    expect(config.jobKillGraceSec).toBe(5);

    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_MAX_JOBS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOB_RETRY_CAP: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_JOB_KILL_GRACE_SEC: 'soon' })).toThrow(
      ConfigError,
    );
  });

  it('enables the control surface only on exactly "true" and fails fast on garbage', () => {
    const enabled = loadConfig({
      ...FULL_ENV,
      NIGHTSHIFT_CONTROL_ENABLED: 'true',
      NIGHTSHIFT_API_TOKEN: 'tok',
    });
    expect(enabled.controlEnabled).toBe(true);
    expect(enabled.apiToken).toBe('tok');
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_CONTROL_ENABLED: 'false' }).controlEnabled).toBe(
      false,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_CONTROL_ENABLED: 'TRUE' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_CONTROL_ENABLED: 'on' })).toThrow(
      ConfigError,
    );
  });

  it('enables the job-type registry only on exactly "true" and fails fast on garbage', () => {
    expect(loadConfig({ ...FULL_ENV }).typesEnabled).toBe(false); // ships dark
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_TYPES_ENABLED: 'true' }).typesEnabled).toBe(true);
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_TYPES_ENABLED: 'false' }).typesEnabled).toBe(false);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_TYPES_ENABLED: 'TRUE' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_TYPES_ENABLED: 'on' })).toThrow(ConfigError);
  });

  it('requires a non-empty NIGHTSHIFT_API_TOKEN when the control surface is enabled', () => {
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_CONTROL_ENABLED: 'true' })).toThrow(
      /NIGHTSHIFT_API_TOKEN/,
    );
    expect(() =>
      loadConfig({ ...FULL_ENV, NIGHTSHIFT_CONTROL_ENABLED: 'true', NIGHTSHIFT_API_TOKEN: '' }),
    ).toThrow(ConfigError);
    // Control off: a set token is carried but not required.
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_API_TOKEN: 'tok' }).apiToken).toBe('tok');
    expect(loadConfig({ ...FULL_ENV }).controlEnabled).toBe(false);
  });

  it('enables promotion only on exactly "true" and fails fast on garbage (Stage 11)', () => {
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_PROMOTE_ENABLED: 'false' }).promoteEnabled).toBe(
      false,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_PROMOTE_ENABLED: 'TRUE' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_PROMOTE_ENABLED: 'on' })).toThrow(
      ConfigError,
    );
  });

  /** A dir that passes the website-repo check (exists + has .git). */
  const makeFakeWebsiteRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nightshift-config-repo-'));
    mkdirSync(join(dir, '.git'));
    return dir;
  };

  it('when promotion is enabled, fails fast unless ALL TEN infra env names are set', () => {
    const promoteEnv: Record<string, string> = {
      ...FULL_ENV,
      NIGHTSHIFT_PROMOTE_ENABLED: 'true',
      COOLIFY_API_URL: 'http://coolify.local:8000',
      COOLIFY_API_TOKEN: 'ct',
      COOLIFY_PROJECT_UUID: 'p',
      COOLIFY_SERVER_UUID: 's',
      COOLIFY_ENVIRONMENT: 'production',
      CF_ACCOUNT_ID: 'a',
      CF_ZONE_ID: 'z',
      CF_TUNNEL_ID: 't',
      CF_DNS_TOKEN: 'd',
      NSAF_DOMAIN: 'seanmahoney.ai',
      NIGHTSHIFT_WEBSITE_REPO: makeFakeWebsiteRepo(), // Stage 13: required too
    };
    const config = loadConfig(promoteEnv);
    expect(config.promoteEnabled).toBe(true);
    expect(config.promote.coolifyApiUrl).toBe('http://coolify.local:8000');
    expect(config.promote.domain).toBe('seanmahoney.ai');
    expect(config.promote.cfApiBase).toBe('https://api.cloudflare.com/client/v4'); // default

    for (const name of [
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
    ]) {
      const env = { ...promoteEnv };
      delete env[name];
      expect(() => loadConfig(env), name).toThrow(new RegExp(`missing: .*${name}`));
      env[name] = '';
      expect(() => loadConfig(env), `${name} empty`).toThrow(ConfigError);
    }

    // Promotion off: the ten are NOT required (documented-not-set placeholders).
    expect(loadConfig({ ...FULL_ENV }).promote.coolifyApiUrl).toBe('');

    // Stage 13: the website repo is required alongside the ten — unset,
    // missing, and not-a-git-clone each fail fast at startup.
    const noRepo = { ...promoteEnv };
    delete noRepo.NIGHTSHIFT_WEBSITE_REPO;
    expect(() => loadConfig(noRepo)).toThrow(/NIGHTSHIFT_WEBSITE_REPO/);
    expect(() => loadConfig({ ...promoteEnv, NIGHTSHIFT_WEBSITE_REPO: '/does/not/exist' })).toThrow(
      /does not exist/,
    );
    const notGit = mkdtempSync(join(tmpdir(), 'nightshift-config-notgit-'));
    expect(() => loadConfig({ ...promoteEnv, NIGHTSHIFT_WEBSITE_REPO: notGit })).toThrow(
      /not a git clone/,
    );
  });

  it('reads the Stage 13 website vars: repo optional when promote is off, bun defaults to "bun"', () => {
    // Promote off: the repo path is carried but never validated.
    const config = loadConfig({ ...FULL_ENV, NIGHTSHIFT_WEBSITE_REPO: '/nowhere/special' });
    expect(config.promote.websiteRepo).toBe('/nowhere/special');
    expect(loadConfig({ ...FULL_ENV }).promote.websiteRepo).toBe('');
    // Bun path: default, '' treated as unset, override honored.
    expect(loadConfig({ ...FULL_ENV }).promote.bunPath).toBe('bun');
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_BUN_PATH: '' }).promote.bunPath).toBe('bun');
    expect(
      loadConfig({ ...FULL_ENV, NIGHTSHIFT_BUN_PATH: '/opt/bun/bin/bun' }).promote.bunPath,
    ).toBe('/opt/bun/bin/bun');
  });

  it('honors the promotion test seams (CF_API_BASE, NIGHTSHIFT_PROMOTE_HEALTH_BASE)', () => {
    const config = loadConfig({
      ...FULL_ENV,
      CF_API_BASE: 'http://127.0.0.1:9998/client/v4',
      NIGHTSHIFT_PROMOTE_HEALTH_BASE: 'http://127.0.0.1:9997',
    });
    expect(config.promote.cfApiBase).toBe('http://127.0.0.1:9998/client/v4');
    expect(config.promote.healthBase).toBe('http://127.0.0.1:9997');
  });

  it('validates NIGHTSHIFT_MODEL (Stage 12): default sonnet-5, override honored, garbage rejected', () => {
    expect(loadConfig({ ...FULL_ENV }).model).toBe('claude-sonnet-5');
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_MODEL: 'claude-opus-4-8' }).model).toBe(
      'claude-opus-4-8',
    );
    // '' is treated as unset, matching the other optional vars…
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_MODEL: '' }).model).toBe('claude-sonnet-5');
    // …but a SET value must be a non-blank model id (fail fast on garbage).
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_MODEL: '   ' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...FULL_ENV, NIGHTSHIFT_MODEL: '\t\n' })).toThrow(/NIGHTSHIFT_MODEL/);
    // Padded values are trimmed rather than spawning `--model " claude-x "`.
    expect(loadConfig({ ...FULL_ENV, NIGHTSHIFT_MODEL: ' claude-sonnet-5 ' }).model).toBe(
      'claude-sonnet-5',
    );
  });

  it('honors the seam overrides (WEBEX_API_BASE, NIGHTSHIFT_AGENT_BIN)', () => {
    const config = loadConfig({
      ...FULL_ENV,
      WEBEX_API_BASE: 'http://127.0.0.1:9999/v1',
      NIGHTSHIFT_AGENT_BIN: '/tmp/stub',
      NIGHTSHIFT_PORT: '4000',
    });
    expect(config.webexApiBase).toBe('http://127.0.0.1:9999/v1');
    expect(config.agentBin).toBe('/tmp/stub');
    expect(config.port).toBe(4000);
  });
});

/** Kill-switch + fail-fast config contract (acceptance conditions). */

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
    expect(config.dbPath).toBe('data/nightshift.db');
    expect(config.port).toBe(3777);
    expect(config.turnTimeoutSec).toBe(300);
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

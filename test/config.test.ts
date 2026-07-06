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

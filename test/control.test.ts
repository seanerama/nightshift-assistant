/**
 * Stage 5 session capability wiring (spec: "Session tool access" + "Session
 * awareness"): with NIGHTSHIFT_CONTROL_ENABLED the conversational spawn argv
 * carries the --allowedTools nightshift rule, the spawn env carries the API
 * token, and a NEW session's --append-system-prompt starts with the capability
 * preamble (composing with the rotation seed when that flag is also on). The
 * flag-off byte-identical guarantee is asserted in rotation.test.ts (the
 * extended Stage-2 argv-equality test).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { jobTypesPreamble } from '../src/jobs/types.js';
import {
  CONTROL_PREAMBLE,
  createSessionManager,
  NIGHTSHIFT_TOOL_RULE,
  type SessionManager,
} from '../src/session/manager.js';
import type { InboundMessage } from '../src/types.js';
import { MIGRATIONS_DIR, makeConfig, makeTestLogger } from './helpers.js';

interface StubInvocation {
  args: string[];
  input: string;
  apiToken: string | null;
}

const inbound = (text: string): InboundMessage => ({
  schema: 1,
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  personId: 'owner-person-id',
  text,
  attachments: [],
  receivedAt: new Date().toISOString(),
});

describe('control-enabled session spawn (Stage 5 gating)', () => {
  let tmpDir: string;
  let appDir: string;
  let invocationLog: string;
  let db: Database.Database;

  const invocations = (): StubInvocation[] =>
    readFileSync(invocationLog, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as StubInvocation);

  const makeManager = (overrides: Partial<Config> = {}): SessionManager =>
    createSessionManager(
      db,
      makeTestLogger(),
      makeConfig({ controlEnabled: true, apiToken: 'test-api-token', ...overrides }),
      { appDir },
    );

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-control-'));
    appDir = join(tmpDir, 'app');
    mkdirSync(appDir, { recursive: true });
    invocationLog = join(tmpDir, 'agent-invocations.jsonl');
    process.env.AGENT_STUB_LOG = invocationLog;
    delete process.env.NIGHTSHIFT_API_TOKEN;
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    delete process.env.AGENT_STUB_LOG;
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('argv carries the verified --allowedTools rule and the env carries the token', async () => {
    const mgr = makeManager();
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const idx = call?.args.indexOf('--allowedTools') ?? -1;
    expect(idx).toBeGreaterThan(-1);
    expect(call?.args[idx + 1]).toBe(NIGHTSHIFT_TOOL_RULE);
    expect(call?.args[idx + 1]).toBe('Bash(nightshift *)');
    expect(call?.apiToken).toBe('test-api-token');
  });

  it('resumed turns keep the rule and the token (every spawn, not just the first)', async () => {
    const mgr = makeManager();
    await mgr.relay(inbound('first'));
    await mgr.relay(inbound('second'));

    const calls = invocations();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain('--resume');
    for (const call of calls) {
      expect(call.args).toContain('--allowedTools');
      expect(call.apiToken).toBe('test-api-token');
    }
  });

  it('a NEW session gets the capability preamble via --append-system-prompt', async () => {
    const mgr = makeManager(); // rotation stays off — preamble alone
    await mgr.relay(inbound('hello'));
    await mgr.relay(inbound('again'));

    const calls = invocations();
    const seedIdx = calls[0]?.args.indexOf('--append-system-prompt') ?? -1;
    expect(seedIdx).toBeGreaterThan(-1);
    const prompt = calls[0]?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).toContain('nightshift submit');
    expect(prompt).toContain('notices arrive in Webex');
    // Resumed turn: no system-prompt append (the session already has it).
    expect(calls[1]?.args).not.toContain('--append-system-prompt');
  });

  it('lists the dispatchable job types when the registry is enabled (Stage 6)', async () => {
    const mgr = makeManager({ typesEnabled: true });
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    const prompt = call?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).toContain(jobTypesPreamble());
    expect(prompt).toContain('- story');
    expect(prompt).toContain("--params '<json>'");
    expect(prompt).toContain('EXPERIMENTAL'); // app-build is flagged
  });

  it('omits the type list while the registry kill-switch is OFF', async () => {
    const mgr = makeManager(); // typesEnabled stays false
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    const prompt = call?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).not.toContain("--params '<json>'");
  });

  it('composes with the rotation seed: preamble first, then restored context', async () => {
    mkdirSync(join(appDir, 'memory'), { recursive: true });
    writeFileSync(join(appDir, 'memory', 'MEMORY.md'), 'Owner drinks tea.', 'utf8');

    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    const prompt = call?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).toContain('Owner drinks tea.');
    expect(prompt.indexOf(CONTROL_PREAMBLE)).toBeLessThan(prompt.indexOf('Owner drinks tea.'));
  });
});

/**
 * Stage 5 session capability wiring (spec: "Session tool access" + "Session
 * awareness"): with NIGHTSHIFT_CONTROL_ENABLED the conversational spawn argv
 * carries the --allowedTools nightshift rule, the spawn env carries the API
 * token, and a NEW session's --append-system-prompt starts with the capability
 * preamble (composing with the rotation seed when that flag is also on). The
 * flag-off byte-identical guarantee is asserted in rotation.test.ts (the
 * extended Stage-2 argv-equality test).
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { jobTypesPreamble } from '../src/jobs/types.js';
import {
  CONTROL_PREAMBLE,
  createSessionManager,
  NIGHTSHIFT_TOOL_RULE,
  PROMOTE_PREAMBLE,
  type SessionManager,
} from '../src/session/manager.js';
import type { InboundMessage } from '../src/types.js';
import { MIGRATIONS_DIR, makeConfig, makeTestLogger } from './helpers.js';

interface StubInvocation {
  args: string[];
  input: string;
  apiToken: string | null;
  /** PATH as seen by the spawned agent (Stage 7 env capture). */
  path: string | null;
}

/** The repo's committed CLI — copied into the test appDir's bin/ so the
 * resolution test proves the REAL script runs from a PATH lookup. */
const REAL_CLI = fileURLToPath(new URL('../bin/nightshift', import.meta.url));

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

  it('adds the promote line only when NIGHTSHIFT_PROMOTE_ENABLED is on (Stage 11)', async () => {
    const mgr = makeManager({ promoteEnabled: true });
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    const prompt = call?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).toContain(PROMOTE_PREAMBLE);
    // The confirm discipline is spelled out: dry-run first, explicit confirm.
    expect(prompt).toContain('nightshift promote');
    expect(prompt).toContain('dry run');
    expect(prompt).toContain('explicitly confirms');
    expect(prompt.indexOf(CONTROL_PREAMBLE)).toBeLessThan(prompt.indexOf(PROMOTE_PREAMBLE));
  });

  it('omits the promote line while the promotion kill-switch is OFF', async () => {
    const mgr = makeManager(); // promoteEnabled stays false
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    const prompt = call?.args[seedIdx + 1] ?? '';
    expect(prompt).toContain(CONTROL_PREAMBLE);
    expect(prompt).not.toContain('nightshift promote');
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

  // Stage 7 regression (live repro 2026-07-06): under systemd the daemon's PATH
  // lacks the CLI, so the session's bare `nightshift` was unresolvable and the
  // model's ./bin/nightshift fallback was (correctly) denied. The fix prepends
  // the app's committed CLI dir to the CHILD's PATH at the conversational
  // spawn site.
  it('session env PATH starts with <appDir>/bin and bare `nightshift` resolves end-to-end', async () => {
    // Put the REAL committed CLI where the daemon's appDir layout has it.
    const binDir = join(appDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    copyFileSync(REAL_CLI, join(binDir, 'nightshift'));
    chmodSync(join(binDir, 'nightshift'), 0o755);

    const mgr = makeManager();
    await mgr.relay(inbound('hello'));

    // 1. String contract: <appDir>/bin leads, inherited PATH preserved after it.
    const [call] = invocations();
    const childPath = call?.path ?? '';
    expect(childPath).toBe(`${binDir}:${process.env.PATH ?? ''}`);

    // 2. End-to-end: a child spawned with EXACTLY that PATH resolves bare
    //    `nightshift` (no path prefix) and --help exits 0 — no daemon, no token.
    const run = spawnSync('nightshift', ['--help'], {
      env: { PATH: childPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.error).toBeUndefined(); // ENOENT here = resolution failed
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('nightshift');
  });

  it('resumed turns get the same prepended PATH (every spawn, not just the first)', async () => {
    const mgr = makeManager();
    await mgr.relay(inbound('first'));
    await mgr.relay(inbound('second'));

    const calls = invocations();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.path?.startsWith(`${join(appDir, 'bin')}:`)).toBe(true);
    }
  });

  it('preamble tells the session to invoke bare `nightshift`, never path-prefixed', () => {
    expect(CONTROL_PREAMBLE).toContain('bare `nightshift');
    expect(CONTROL_PREAMBLE).toContain('never');
    expect(CONTROL_PREAMBLE.toLowerCase()).toContain('path');
  });

  it('flag-off spawn PATH is the inherited PATH untouched (byte-identical env)', async () => {
    const mgr = makeManager({ controlEnabled: false, apiToken: '' });
    await mgr.relay(inbound('hello'));

    const [call] = invocations();
    expect(call?.path).toBe(process.env.PATH ?? null);
    expect(call?.apiToken).toBeNull();
  });
});

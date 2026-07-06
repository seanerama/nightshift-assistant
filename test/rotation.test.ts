/**
 * Rotation ritual (contracts/assistant-session.md rotate() → RotationRecord).
 * The agent binary is stubbed at the seam (never the ritual): happy path,
 * summary-turn failure, size-cap trigger, daily boundary with an injected
 * clock, serialization behind an in-flight turn, the dark default, and the
 * rotation notice wiring through the app + fixture Webex server.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { createSessionManager, type SessionManager } from '../src/session/manager.js';
import { transcriptPathFor } from '../src/session/rotation.js';
import type { InboundMessage } from '../src/types.js';
import {
  MIGRATIONS_DIR,
  makeConfig,
  makeTestLogger,
  sign,
  startWebexStub,
  type TestLogger,
  waitFor,
  webhookBody,
} from './helpers.js';

const SUMMARY_WITH_DURABLE = [
  '# Summary',
  'Discussed the bananas project. Decided to launch Tuesday. Built the loader.',
  'Unfinished: the docs.',
  '=== DURABLE MEMORY ===',
  'The bananas project launches Tuesday.',
  '=== END DURABLE MEMORY ===',
].join('\n');

interface StubInvocation {
  args: string[];
  input: string;
}

interface DbSessionRow {
  id: number;
  session_id: string;
  started_at: string;
  rotated_at: string | null;
  rotation_reason: string | null;
  is_current: number;
  turns: number;
  pending: number;
}

const inbound = (text: string): InboundMessage => ({
  schema: 1,
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  personId: 'owner-person-id',
  text,
  attachments: [],
  receivedAt: new Date().toISOString(),
});

describe('rotation ritual (session-manager level)', () => {
  let tmpDir: string;
  let appDir: string;
  let projectsRoot: string;
  let invocationLog: string;
  let db: Database.Database;
  let log: TestLogger;
  let clock: Date;
  let notices: string[];
  let notifyError: Error | null;

  const invocations = (): StubInvocation[] => {
    try {
      return readFileSync(invocationLog, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as StubInvocation);
    } catch {
      return [];
    }
  };

  const rows = (): DbSessionRow[] =>
    db.prepare('SELECT * FROM sessions ORDER BY id').all() as DbSessionRow[];

  const currentRow = (): DbSessionRow | undefined =>
    (db.prepare('SELECT * FROM sessions WHERE is_current = 1').get() as DbSessionRow | undefined) ??
    undefined;

  const makeManager = (configOverrides: Partial<Config> = {}): SessionManager =>
    createSessionManager(db, log, makeConfig(configOverrides), {
      now: () => clock,
      appDir,
      projectsRoot,
      notify: async (text: string): Promise<void> => {
        if (notifyError !== null) throw notifyError;
        notices.push(text);
      },
    });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-rotation-'));
    appDir = join(tmpDir, 'app');
    projectsRoot = join(tmpDir, 'projects');
    mkdirSync(appDir, { recursive: true });
    invocationLog = join(tmpDir, 'agent-invocations.jsonl');
    process.env.AGENT_STUB_LOG = invocationLog;
    delete process.env.AGENT_STUB_MODE;
    delete process.env.AGENT_STUB_REPLY;
    delete process.env.AGENT_STUB_DELAY_MS;

    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    log = makeTestLogger();
    clock = new Date(2026, 6, 6, 12, 0, 0); // local 2026-07-06 12:00
    notices = [];
    notifyError = null;
  });

  afterEach(() => {
    delete process.env.AGENT_STUB_LOG;
    delete process.env.AGENT_STUB_MODE;
    delete process.env.AGENT_STUB_REPLY;
    delete process.env.AGENT_STUB_DELAY_MS;
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ritual happy path: summary turn, daily log, memory promotion, row flip, seeded next session', async () => {
    const mgr = makeManager({ rotationEnabled: true });

    await mgr.relay(inbound('hello'));
    expect(currentRow()?.session_id).toBe('sess-canned-1');
    expect(currentRow()?.turns).toBe(1);

    // Fake the claude CLI transcript at its project-dir convention location.
    const transcript = transcriptPathFor(projectsRoot, appDir, 'sess-canned-1');
    mkdirSync(join(transcript, '..'), { recursive: true });
    writeFileSync(transcript, '{"type":"turn"}\n', 'utf8');

    process.env.AGENT_STUB_REPLY = SUMMARY_WITH_DURABLE;
    const record = await mgr.rotate('daily');

    // RotationRecord: every field populated, exactly the contract shape.
    expect(record.schema).toBe(1);
    expect(record.closedSessionId).toBe('sess-canned-1');
    expect(record.newSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.reason).toBe('daily');
    expect(record.summaryPath).toBe(join(appDir, 'logs', 'daily', '2026-07-06.md'));
    expect(record.transcriptPath).toBe(transcript);
    expect(record.rotatedAt).toBe(clock.toISOString());

    // The summary turn ran against the OUTGOING session with the fixed prompt.
    const summaryCall = invocations()[1];
    expect(summaryCall?.args).toContain('--resume');
    expect(summaryCall?.args[(summaryCall?.args.indexOf('--resume') ?? -1) + 1]).toBe(
      'sess-canned-1',
    );
    expect(summaryCall?.input).toContain('=== DURABLE MEMORY ===');

    // Daily log written (permanent record).
    const daily = readFileSync(record.summaryPath, 'utf8');
    expect(daily).toContain('Decided to launch Tuesday');
    expect(daily).toContain('reason: daily');

    // Durable section promoted into memory/ (index + dated append).
    expect(readFileSync(join(appDir, 'memory', '2026-07-06.md'), 'utf8')).toContain(
      'The bananas project launches Tuesday.',
    );
    expect(readFileSync(join(appDir, 'memory', 'MEMORY.md'), 'utf8')).toContain('2026-07-06');

    // Transcript location recorded under logs/transcripts/.
    expect(readFileSync(join(appDir, 'logs', 'transcripts', 'index.md'), 'utf8')).toContain(
      transcript,
    );

    // Sessions rows: outgoing flipped; an EXPLICITLY pending row is current.
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]?.is_current).toBe(0);
    expect(all[0]?.rotation_reason).toBe('daily');
    expect(all[0]?.rotated_at).toBe(record.rotatedAt);
    expect(all[1]?.session_id).toBe(record.newSessionId);
    expect(all[1]?.is_current).toBe(1);
    expect(all[1]?.turns).toBe(0);
    expect(all[1]?.pending).toBe(1);

    // Notice went out through the notify hook (app wires it to send()).
    expect(notices).toEqual([
      'Rotated the conversational session (daily); summary at logs/daily/2026-07-06.md',
    ]);

    // Next relay starts the NEW session, seeded — and the seed is invisible to
    // the reply (it travels via --append-system-prompt).
    delete process.env.AGENT_STUB_REPLY;
    const reply = await mgr.relay(inbound('what did we decide?'));
    const seededCall = invocations()[2];
    expect(seededCall?.args).not.toContain('--resume');
    const sidIdx = seededCall?.args.indexOf('--session-id') ?? -1;
    expect(sidIdx).toBeGreaterThan(-1);
    expect(seededCall?.args[sidIdx + 1]).toBe(record.newSessionId);
    const seedIdx = seededCall?.args.indexOf('--append-system-prompt') ?? -1;
    expect(seedIdx).toBeGreaterThan(-1);
    const seed = seededCall?.args[seedIdx + 1] ?? '';
    expect(seed).toContain('The bananas project launches Tuesday.');
    expect(seed).toContain('Decided to launch Tuesday');
    expect(reply.text).not.toContain('The bananas project launches Tuesday.');
    expect(reply.sessionId).toBe(record.newSessionId);
    expect(reply.rotated).toBe(false);
    expect(currentRow()?.turns).toBe(1); // counter restarted on the new session
    expect(currentRow()?.pending).toBe(0); // materialized: marker cleared on first success
  });

  it('seeds a brand-new session (no row at all) from existing memory + latest summary', async () => {
    mkdirSync(join(appDir, 'memory'), { recursive: true });
    writeFileSync(join(appDir, 'memory', '2026-07-05.md'), 'Owner drinks tea.', 'utf8');
    mkdirSync(join(appDir, 'logs', 'daily'), { recursive: true });
    writeFileSync(join(appDir, 'logs', 'daily', '2026-07-05.md'), 'yesterday summary', 'utf8');

    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('good morning'));

    const call = invocations()[0];
    expect(call?.args).not.toContain('--resume');
    expect(call?.args).not.toContain('--session-id'); // no pending row → the CLI assigns the id
    const seedIdx = call?.args.indexOf('--append-system-prompt') ?? -1;
    expect(seedIdx).toBeGreaterThan(-1);
    expect(call?.args[seedIdx + 1]).toContain('Owner drinks tea.');
    expect(call?.args[seedIdx + 1]).toContain('yesterday summary');
  });

  it('appends a numbered suffix when rotating twice in one day', async () => {
    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('one'));
    const first = await mgr.rotate('manual');
    await mgr.relay(inbound('two'));
    const second = await mgr.rotate('manual');
    expect(basename(first.summaryPath)).toBe('2026-07-06.md');
    expect(basename(second.summaryPath)).toBe('2026-07-06-2.md');
  });

  it('summary-turn failure still rotates (stub summary + logged failure)', async () => {
    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('hello'));

    process.env.AGENT_STUB_MODE = 'die';
    const record = await mgr.rotate('manual');

    expect(record.closedSessionId).toBe('sess-canned-1');
    expect(record.reason).toBe('manual');
    expect(record.transcriptPath).toBe(''); // absent transcript is tolerated
    const daily = readFileSync(record.summaryPath, 'utf8');
    expect(daily).toContain('Summary turn FAILED during rotation');
    expect(
      log.entries.some(
        (e) => e.level === 'error' && e.msg.includes('rotation summary turn failed'),
      ),
    ).toBe(true);

    // The wedged session was still retired; a fresh pending row is current.
    const all = rows();
    expect(all[0]?.is_current).toBe(0);
    expect(all[0]?.rotation_reason).toBe('manual');
    expect(currentRow()?.session_id).toBe(record.newSessionId);
  });

  it('size-cap: the relay pushing past the cap rotates after the turn and reports rotated:true', async () => {
    const mgr = makeManager({ rotationEnabled: true, sizeCapTurns: 3 });

    const r1 = await mgr.relay(inbound('turn 1'));
    const r2 = await mgr.relay(inbound('turn 2'));
    const r3 = await mgr.relay(inbound('turn 3'));
    expect([r1.rotated, r2.rotated, r3.rotated]).toEqual([false, false, false]);
    expect(currentRow()?.turns).toBe(3);

    const r4 = await mgr.relay(inbound('turn 4'));
    expect(r4.rotated).toBe(true);
    expect(r4.text).toContain('pong: turn 4'); // the turn itself completed first

    const all = rows();
    expect(all[0]?.is_current).toBe(0);
    expect(all[0]?.rotation_reason).toBe('size-cap');
    expect(all[0]?.turns).toBe(4);
    expect(currentRow()?.turns).toBe(0); // counter reset on the new session

    // Next relay runs on the new session, counter restarts at 1.
    const r5 = await mgr.relay(inbound('turn 5'));
    expect(r5.rotated).toBe(false);
    expect(r5.sessionId).toBe(currentRow()?.session_id);
    expect(currentRow()?.turns).toBe(1);
  });

  it('daily boundary: a session started yesterday rotates at the next check; one started today does not', async () => {
    const mgr = makeManager({ rotationEnabled: true, rotateHour: 4 });
    clock = new Date(2026, 6, 6, 5, 0, 0); // 05:00 local, past the 04:00 boundary

    await mgr.relay(inbound('hello'));

    // Started today at 05:00 (after the boundary) → no rotation.
    expect(await mgr.maybeRotateDaily()).toBe(false);
    expect(rows()).toHaveLength(1);

    // Same session, but started yesterday evening → rotates at the next check.
    db.prepare('UPDATE sessions SET started_at = ? WHERE is_current = 1').run(
      new Date(2026, 6, 5, 22, 0, 0).toISOString(),
    );
    expect(await mgr.maybeRotateDaily()).toBe(true);
    expect(rows()[0]?.rotation_reason).toBe('daily');
    expect(currentRow()?.turns).toBe(0);

    // The fresh pending session (no turns yet) never daily-rotates.
    db.prepare('UPDATE sessions SET started_at = ? WHERE is_current = 1').run(
      new Date(2026, 6, 4, 22, 0, 0).toISOString(),
    );
    expect(await mgr.maybeRotateDaily()).toBe(false);
  });

  it('serialization: a rotation queued behind an in-flight relay turn waits for it', async () => {
    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('warm up'));

    process.env.AGENT_STUB_DELAY_MS = '250';
    const order: string[] = [];
    const relayPromise = mgr.relay(inbound('slow turn')).then((r) => {
      order.push('relay');
      return r;
    });
    const rotatePromise = mgr.rotate('manual').then((r) => {
      order.push('rotate');
      return r;
    });
    const [reply, record] = await Promise.all([relayPromise, rotatePromise]);

    expect(order).toEqual(['relay', 'rotate']);
    expect(reply.rotated).toBe(false); // the in-flight turn was NOT the trigger
    // The summary turn ran against the session id the slow turn used — never mid-turn.
    const calls = invocations();
    expect(calls[1]?.input).toBe('slow turn');
    expect(calls[2]?.input).toContain('=== DURABLE MEMORY ===');
    expect(record.closedSessionId).toBe('sess-canned-1');
  });

  it('notification failure never blocks the ritual', async () => {
    const mgr = makeManager({ rotationEnabled: true });
    await mgr.relay(inbound('hello'));
    notifyError = new Error('webex is down');
    const record = await mgr.rotate('manual');
    expect(record.closedSessionId).toBe('sess-canned-1');
    expect(
      log.entries.some(
        (e) => e.level === 'error' && e.msg.includes('rotation notice delivery failed'),
      ),
    ).toBe(true);
  });

  describe('pending marker (Stage 3 regression: pending-ness must be explicit, not turns==0)', () => {
    it('REGRESSION: a materialized session backfilled to turns=0 (live incident) is RESUMED, never started', async () => {
      // The 2026-07-06 incident state: migration 0002 backfilled turns = 0 onto
      // the pre-existing live session (real id, already materialized, NOT
      // pending). Insert exactly that row — defaults supply the backfill state.
      db.prepare(
        'INSERT INTO sessions (session_id, started_at, is_current, turns) VALUES (?, ?, 1, 0)',
      ).run('f0138138-aaaa-bbbb-cccc-000000000001', clock.toISOString());

      const mgr = makeManager({ rotationEnabled: true });
      const reply = await mgr.relay(inbound('good evening'));

      // Stage 2 tried to START it (`--session-id` + seed) and the CLI refused
      // ("Session ID … is already in use"). It must be RESUMED.
      const call = invocations()[0];
      expect(call?.args).not.toContain('--session-id');
      expect(call?.args).toContain('--resume');
      expect(call?.args[(call?.args.indexOf('--resume') ?? -1) + 1]).toBe(
        'f0138138-aaaa-bbbb-cccc-000000000001',
      );
      expect(reply.text).toBe('pong: good evening');
      expect(currentRow()?.rotation_reason ?? null).toBeNull(); // NOT force-retired as 'died'
    });

    it('a pending row whose first turn FAILS stays pending: the retry STARTS it again, never resumes', async () => {
      const mgr = makeManager({ rotationEnabled: true });
      await mgr.relay(inbound('hello'));
      const record = await mgr.rotate('manual');
      expect(currentRow()?.pending).toBe(1);

      // First turn on the pending session dies.
      process.env.AGENT_STUB_MODE = 'die';
      const failed = await mgr.relay(inbound('are you there?'));
      expect(failed.text).toContain('hit an error');

      // The row was NOT retired: still current, still pending, same id.
      expect(currentRow()?.session_id).toBe(record.newSessionId);
      expect(currentRow()?.pending).toBe(1);

      // Retry STARTS it under the same pre-assigned id (with the seed), and
      // success finally clears the marker.
      delete process.env.AGENT_STUB_MODE;
      await mgr.relay(inbound('retry'));
      const retry = invocations()[3];
      expect(retry?.args).not.toContain('--resume');
      const sidIdx = retry?.args.indexOf('--session-id') ?? -1;
      expect(sidIdx).toBeGreaterThan(-1);
      expect(retry?.args[sidIdx + 1]).toBe(record.newSessionId);
      expect(currentRow()?.pending).toBe(0);
      expect(currentRow()?.turns).toBe(1);
    });

    it('maybeRotateDaily skips a pending row; a non-pending turns=0 row past the boundary DOES rotate', async () => {
      const mgr = makeManager({ rotationEnabled: true, rotateHour: 4 });
      clock = new Date(2026, 6, 6, 5, 0, 0); // 05:00 local, past the 04:00 boundary

      await mgr.relay(inbound('hello'));
      await mgr.rotate('manual');

      // Rotation-created pending row, aged past the boundary → still skipped.
      db.prepare('UPDATE sessions SET started_at = ? WHERE is_current = 1').run(
        new Date(2026, 6, 4, 22, 0, 0).toISOString(),
      );
      expect(currentRow()?.pending).toBe(1);
      expect(await mgr.maybeRotateDaily()).toBe(false);

      // The incident shape: a REAL (non-pending) session whose backfilled turn
      // count lies at 0, past the boundary → rotates (turns==0 no longer skips).
      db.prepare('UPDATE sessions SET pending = 0, turns = 0 WHERE is_current = 1').run();
      expect(await mgr.maybeRotateDaily()).toBe(true);
      expect(rows()[1]?.rotation_reason).toBe('daily');
      expect(currentRow()?.pending).toBe(1); // and the ritual minted a fresh pending row
    });
  });

  describe('kill-switch: NIGHTSHIFT_ROTATION_ENABLED unset (default)', () => {
    it('relay invocations are byte-identical to Stage 1 even with seedable content on disk', async () => {
      // Content that WOULD seed a new session if rotation were enabled.
      mkdirSync(join(appDir, 'memory'), { recursive: true });
      writeFileSync(join(appDir, 'memory', 'MEMORY.md'), 'seed me', 'utf8');
      mkdirSync(join(appDir, 'logs', 'daily'), { recursive: true });
      writeFileSync(join(appDir, 'logs', 'daily', '2026-07-05.md'), 'old summary', 'utf8');

      const mgr = makeManager(); // rotationEnabled: false (makeConfig default)
      await mgr.relay(inbound('first'));
      await mgr.relay(inbound('second'));

      const calls = invocations();
      expect(calls[0]?.args).toEqual(['-p', '--output-format', 'json']);
      expect(calls[1]?.args).toEqual([
        '-p',
        '--output-format',
        'json',
        '--resume',
        'sess-canned-1',
      ]);
    });

    it('no trigger fires: neither size-cap nor the daily check rotates', async () => {
      const mgr = makeManager({ sizeCapTurns: 1 }); // cap would trip immediately
      const r1 = await mgr.relay(inbound('one'));
      const r2 = await mgr.relay(inbound('two'));
      expect([r1.rotated, r2.rotated]).toEqual([false, false]);

      db.prepare('UPDATE sessions SET started_at = ? WHERE is_current = 1').run(
        new Date(2026, 6, 1, 12, 0, 0).toISOString(),
      );
      expect(await mgr.maybeRotateDaily()).toBe(false);

      expect(rows()).toHaveLength(1);
      expect(currentRow()?.session_id).toBe('sess-canned-1');
    });
  });
});

describe('rotation notice through the app (owner room tracked from inbound messages)', () => {
  let tmpDir: string;
  let app: App;
  let stub: Awaited<ReturnType<typeof startWebexStub>>;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-rotapp-'));
    process.env.AGENT_STUB_LOG = join(tmpDir, 'agent-invocations.jsonl');
    delete process.env.AGENT_STUB_MODE;
    delete process.env.AGENT_STUB_REPLY;
    stub = await startWebexStub();
    const appDir = join(tmpDir, 'app');
    mkdirSync(appDir, { recursive: true });
    app = createApp(
      makeConfig({
        webexApiBase: stub.baseUrl,
        dbPath: join(tmpDir, 'test.db'),
        rotationEnabled: true,
      }),
      makeTestLogger(),
      { appDir, projectsRoot: join(tmpDir, 'projects') },
    );
    const port = await app.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete process.env.AGENT_STUB_LOG;
    delete process.env.AGENT_STUB_REPLY;
    await app.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends the one-line notice to the owner's most recent room", async () => {
    stub.addMessage({
      id: 'msg-room',
      roomId: 'room-42',
      personId: 'owner-person-id',
      text: 'hello',
    });
    const body = webhookBody('msg-room');
    await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Spark-Signature': sign(body, 'test-webhook-secret'),
      },
      body,
    });
    await waitFor(() => stub.sends.length >= 1); // the relay reply

    const record = await app.sessions.rotate('manual');
    await waitFor(() => stub.sends.length >= 2);
    const notice = stub.sends[1];
    expect(notice?.roomId).toBe('room-42');
    expect(String(notice?.markdown)).toContain('Rotated the conversational session (manual)');
    expect(String(notice?.markdown)).toContain(basename(record.summaryPath));
  });
});

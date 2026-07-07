/**
 * App wiring for the job runner (Stage 4): onFinish → owner-room Webex notice
 * through send(), the NIGHTSHIFT_JOBS_ENABLED kill-switch (fully dark), and
 * reconciliation-on-restart adoption of rows persisted by a previous daemon
 * life. The worker stub doubles as the conversational agent (it answers
 * --output-format turns like agent-stub), so one agentBin serves both paths.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { transitionJob } from '../src/db/transitions.js';
import { JobError } from '../src/jobs/runner.js';
import {
  MIGRATIONS_DIR,
  makeConfig,
  makeTestLogger,
  sign,
  startWebexStub,
  type TestLogger,
  type WebexStub,
  WORKER_STUB,
  waitFor,
  webhookBody,
} from './helpers.js';

const SECRET = 'test-webhook-secret';

describe('job runner app wiring', () => {
  let stub: WebexStub;
  let log: TestLogger;
  let tmpDir: string;
  let workdir: string;
  let dbPath: string;
  let app: App | null;

  const makeApp = (overrides: Partial<Config> = {}): App =>
    createApp(
      makeConfig({
        webexApiBase: stub.baseUrl,
        dbPath,
        agentBin: WORKER_STUB,
        jobsEnabled: true,
        jobKillGraceSec: 1,
        ...overrides,
      }),
      log,
      { appDir: tmpDir },
    );

  const submitJob = (a: App, instruction: string) =>
    a.jobs.submit({
      schema: 1,
      type: 'test',
      title: 'wired job',
      instruction,
      workdir,
      env: 'minimal',
    });

  /** Seed a `running` row with a dead pid, as if persisted by a previous daemon life. */
  const seedDeadRunningRow = (): string => {
    const db = openDatabase(dbPath);
    migrate(db, MIGRATIONS_DIR);
    const id = randomUUID();
    const dir = join(tmpDir, 'jobs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'instruction.txt'), 'MODE=success');
    db.prepare(
      `INSERT INTO jobs (id, schema, type, title, status, workdir, log_path, attempts,
                         created_at, sentinel_path)
       VALUES (?, 1, 'test', 'orphan', 'queued', ?, ?, 0, ?, ?)`,
    ).run(
      id,
      workdir,
      join(dir, 'worker.log'),
      new Date().toISOString(),
      join(dir, 'sentinel.json'),
    );
    transitionJob(db, log, id, 'running');
    db.prepare('UPDATE jobs SET pid = 999999999 WHERE id = ?').run(id); // out-of-range: dead
    db.close();
    return id;
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-jobs-app-'));
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir);
    dbPath = join(tmpDir, 'test.db');
    stub = await startWebexStub();
    log = makeTestLogger();
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One webhook round-trip so the app learns (and persists) the owner's room. */
  const learnOwnerRoom = async (port: number, roomId = 'room-1'): Promise<void> => {
    const messageId = `msg-${Math.random().toString(36).slice(2)}`;
    stub.addMessage({ id: messageId, roomId, personId: 'owner-person-id', text: 'hi' });
    const body = webhookBody(messageId);
    await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spark-Signature': sign(body, SECRET) },
      body,
    });
    await waitFor(() => stub.sends.length >= 1); // the relay reply
    stub.sends.length = 0;
  };

  it('delivers the finish notice to the owner room via send()', async () => {
    app = makeApp();
    const port = await app.listen();
    await learnOwnerRoom(port);

    const record = submitJob(app, 'MODE=success');
    await waitFor(() => app?.jobs.get(record.id)?.status === 'succeeded');
    await waitFor(() => stub.sends.some((s) => String(s.markdown).includes('✅ **wired job**')));
    const notice = stub.sends.find((s) => String(s.markdown).includes('✅ **wired job**'));
    expect(notice?.roomId).toBe('room-1');
    expect(String(notice?.markdown)).toContain('stub work complete');
  });

  it('skips (and logs) the finish notice when no owner room has been seen', async () => {
    app = makeApp();
    await app.listen();
    const record = submitJob(app, 'MODE=success');
    await waitFor(() => app?.jobs.get(record.id)?.status === 'succeeded');
    await waitFor(() => log.entries.some((e) => e.msg.includes('job finish notice skipped')));
    expect(stub.sends).toHaveLength(0);
  });

  it('kill-switch: with jobs disabled, submit rejects and the reconciler never runs', async () => {
    const orphanId = seedDeadRunningRow();
    app = makeApp({ jobsEnabled: false });
    await app.listen();

    expect(() => submitJob(app as App, 'MODE=success')).toThrow(JobError);

    // No startup reconcile: the seeded dead-pid running row stays untouched.
    await new Promise((r) => setTimeout(r, 200));
    expect(app.jobs.get(orphanId)?.status).toBe('running');
    expect(log.entries.some((e) => e.msg.includes('reconciler'))).toBe(false);
  });

  it('restart adoption: an enabled app reconciles rows persisted by a previous life', async () => {
    const orphanId = seedDeadRunningRow();
    app = makeApp({ jobRetryCap: 1 });
    await app.listen();

    // Startup reconcile runs the exit routine: dead pid, no sentinel → failed.
    await waitFor(() => app?.jobs.get(orphanId)?.status === 'failed');
    expect(app.jobs.get(orphanId)?.attempts).toBe(1);
  });

  it('owner room survives a restart (settings table): the new life routes notices with no inbound', async () => {
    const first = makeApp();
    const port = await first.listen();
    app = first;
    await learnOwnerRoom(port, 'room-restart');
    await first.close();

    app = makeApp(); // same dbPath, no webhook round-trip in this life
    await app.listen();
    const record = submitJob(app, 'MODE=success');
    await waitFor(() => app?.jobs.get(record.id)?.status === 'succeeded');
    await waitFor(() => stub.sends.length >= 1);
    expect(stub.sends[0]?.roomId).toBe('room-restart');
    expect(String(stub.sends[0]?.markdown)).toContain('✅ **wired job**');
  });

  describe('auto-attach on success (Stage 10)', () => {
    const attachApp = (overrides: Partial<Config> = {}): App =>
      makeApp({ controlEnabled: true, apiToken: 'attach-token', autoAttachMaxMb: 1, ...overrides });

    const finishOutputsJob = async (a: App, outputsSpec: string): Promise<void> => {
      const record = submitJob(a, `MODE=outputs OUTPUTS=${outputsSpec}`);
      await waitFor(() => a.jobs.get(record.id)?.status === 'succeeded');
      await waitFor(() => stub.sends.length >= 1);
      // Give any follow-up file messages time to land.
      await new Promise((r) => setTimeout(r, 150));
    };

    it('attaches small outputs to the notice, one file per message, first file on the notice', async () => {
      app = attachApp();
      const port = await app.listen();
      await learnOwnerRoom(port);

      await finishOutputsJob(app, 'a.txt:100,b.txt:200');
      expect(stub.sends).toHaveLength(2);
      // The notice message carries the FIRST file plus the formatted text.
      expect(stub.sends[0]?.fileName).toBe('a.txt');
      const notice = String(stub.sends[0]?.markdown);
      expect(notice).toContain('✅ **wired job** — test finished');
      expect(notice).toContain('Produced the requested outputs. Everything validated cleanly.');
      expect(notice).not.toContain('third sentence'); // truncated at 2 sentences
      expect(notice).toContain('Outputs: a.txt, b.txt');
      expect(notice).toContain('Say "send me <file>" for delivery.');
      // The second file rides its own follow-up message.
      expect(stub.sends[1]?.fileName).toBe('b.txt');
    });

    it('skips a video-sized output silently but keeps the hint line; bounded at 3 files', async () => {
      app = attachApp();
      const port = await app.listen();
      await learnOwnerRoom(port);

      // big.bin is 2MB > the 1MB cap; e.txt is the 4th eligible file → dropped.
      await finishOutputsJob(app, 'big.bin:2097152,c.txt:10,d.txt:10,e1.txt:10,e2.txt:10');
      const fileNames = stub.sends.map((s) => s.fileName);
      expect(fileNames).toEqual(['c.txt', 'd.txt', 'e1.txt']);
      const notice = String(stub.sends[0]?.markdown);
      expect(notice).toContain('Outputs: big.bin, c.txt, d.txt, e1.txt, e2.txt');
      expect(notice).toContain('Say "send me <file>" for delivery.');
    });

    it('NIGHTSHIFT_AUTOATTACH_MAX_MB=0 disables auto-attach; the notice still lands with the hint', async () => {
      app = attachApp({ autoAttachMaxMb: 0 });
      const port = await app.listen();
      await learnOwnerRoom(port);

      await finishOutputsJob(app, 'a.txt:100');
      expect(stub.sends).toHaveLength(1);
      expect(stub.sends[0]).not.toHaveProperty('fileName');
      expect(String(stub.sends[0]?.markdown)).toContain('Say "send me <file>" for delivery.');
    });

    it('stays dark without the control surface: no attachments when controlEnabled is off', async () => {
      app = makeApp({ autoAttachMaxMb: 10 }); // controlEnabled stays false
      const port = await app.listen();
      await learnOwnerRoom(port);

      await finishOutputsJob(app, 'a.txt:100');
      expect(stub.sends).toHaveLength(1);
      expect(stub.sends[0]).not.toHaveProperty('fileName');
      expect(String(stub.sends[0]?.markdown)).toContain('✅ **wired job**');
    });
  });
});

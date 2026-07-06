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

  it('delivers the finish notice to the owner room via send()', async () => {
    app = makeApp();
    const port = await app.listen();

    // One round-trip first so the app learns the owner's room.
    stub.addMessage({ id: 'msg-job-1', roomId: 'room-1', personId: 'owner-person-id', text: 'hi' });
    const body = webhookBody('msg-job-1');
    await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spark-Signature': sign(body, SECRET) },
      body,
    });
    await waitFor(() => stub.sends.length >= 1);

    const record = submitJob(app, 'MODE=success');
    await waitFor(() => app?.jobs.get(record.id)?.status === 'succeeded');
    await waitFor(() => stub.sends.some((s) => String(s.markdown).includes('Job succeeded')));
    const notice = stub.sends.find((s) => String(s.markdown).includes('Job succeeded'));
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
});

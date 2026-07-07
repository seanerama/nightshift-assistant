/**
 * POST /api/v1/deliver + `nightshift deliver` (Stage 10, additive on
 * control-api v1): a confined file lands in the owner's room as a multipart
 * attachment. Security-relevant negatives: traversal, symlink escape, paths
 * outside the allowed roots, directories — all 400, nothing sent. Unknown
 * owner room → 409 with a clear pointer. The owner room persists across a
 * daemon restart (settings table, migration 0005), so deliver works before
 * any inbound message in the new life.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import {
  makeConfig,
  makeTestLogger,
  sign,
  startWebexStub,
  type WebexStub,
  WORKER_STUB,
  waitFor,
  webhookBody,
} from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/nightshift', import.meta.url));
const TOKEN = 'deliver-test-token';
const SECRET = 'test-webhook-secret';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('POST /api/v1/deliver + nightshift deliver', () => {
  let stub: WebexStub;
  let tmpDir: string;
  let dbPath: string;
  let app: App | null;
  let baseUrl: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        webexApiBase: stub.baseUrl,
        dbPath,
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        ...overrides,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const port = await a.listen();
    baseUrl = `http://127.0.0.1:${port}`;
    app = a;
    return a;
  };

  /** One webhook round-trip so the app learns (and persists) the owner room. */
  const learnOwnerRoom = async (roomId = 'room-d1'): Promise<void> => {
    const messageId = `msg-${Math.random().toString(36).slice(2)}`;
    stub.addMessage({ id: messageId, roomId, personId: 'owner-person-id', text: 'hi' });
    const body = webhookBody(messageId);
    await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Spark-Signature': sign(body, SECRET) },
      body,
    });
    await waitFor(() => stub.sends.length >= 1); // the relay reply landed
    stub.sends.length = 0; // start deliver assertions from a clean slate
  };

  const deliver = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/deliver`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-deliver-'));
    dbPath = join(tmpDir, 'test.db');
    // The allowed roots + a file inside each interesting location.
    mkdirSync(join(tmpDir, 'projects', 'demo'), { recursive: true });
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    writeFileSync(join(tmpDir, 'projects', 'demo', 'video.mp4'), Buffer.alloc(1024, 7));
    writeFileSync(join(tmpDir, 'logs', 'daemon.log'), 'log line');
    writeFileSync(join(tmpDir, 'secret.txt'), 'outside the roots');
    stub = await startWebexStub();
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('delivers a file inside an allowed root as a multipart attachment', async () => {
    await makeApp();
    await learnOwnerRoom();

    const res = await deliver({ path: join(tmpDir, 'projects', 'demo', 'video.mp4') });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      delivered: { path: string; roomId: string };
    };
    expect(json.ok).toBe(true);
    expect(json.delivered.roomId).toBe('room-d1');
    expect(json.delivered.path).toContain('video.mp4');

    expect(stub.sends).toHaveLength(1);
    expect(stub.sends[0]?.roomId).toBe('room-d1');
    expect(stub.sends[0]?.fileName).toBe('video.mp4');
    expect(stub.sends[0]?.fileBytes).toBe(1024);
    expect(String(stub.sends[0]?.markdown)).toContain('📎 video.mp4');
  });

  it('includes the optional note in the message markdown', async () => {
    await makeApp();
    await learnOwnerRoom();
    const res = await deliver({
      path: join(tmpDir, 'logs', 'daemon.log'),
      note: 'the log you asked for',
    });
    expect(res.status).toBe(200);
    expect(String(stub.sends[0]?.markdown)).toBe('📎 daemon.log — the log you asked for');
  });

  it('path confinement: traversal, outside path, symlink escape, directory → 400, nothing sent', async () => {
    await makeApp();
    await learnOwnerRoom();
    // A symlink INSIDE an allowed root pointing OUTSIDE it.
    symlinkSync(join(tmpDir, 'secret.txt'), join(tmpDir, 'projects', 'demo', 'leak.txt'));

    for (const path of [
      join(tmpDir, 'secret.txt'), // plainly outside the roots
      `${tmpDir}/projects/../secret.txt`, // dot-dot traversal (join() would pre-normalize it)
      join(tmpDir, 'projects', 'demo', 'leak.txt'), // symlink escape
      '/etc/passwd', // arbitrary filesystem
    ]) {
      const res = await deliver({ path });
      expect(res.status, path).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error, path).toContain('outside the deliverable roots');
    }

    const dir = await deliver({ path: join(tmpDir, 'projects', 'demo') });
    expect(dir.status).toBe(400);
    expect(((await dir.json()) as { error: string }).error).toContain('not a regular file');

    const relative = await deliver({ path: 'projects/demo/video.mp4' });
    expect(relative.status).toBe(400);
    expect(((await relative.json()) as { error: string }).error).toContain('must be absolute');

    expect(stub.sends).toHaveLength(0); // none of the rejects sent anything
  });

  it('nonexistent file → 400 with a clear message', async () => {
    await makeApp();
    await learnOwnerRoom();
    const res = await deliver({ path: join(tmpDir, 'projects', 'demo', 'never-made.mp4') });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('file not found');
  });

  it('missing/empty path or a non-string note → 400', async () => {
    await makeApp();
    for (const body of [{}, { path: '' }, { path: 42 }]) {
      const res = await deliver(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('deliver requires "path"');
    }
    const badNote = await deliver({ path: join(tmpDir, 'logs', 'daemon.log'), note: 5 });
    expect(badNote.status).toBe(400);
    expect(((await badNote.json()) as { error: string }).error).toContain(
      '"note" must be a string',
    );
  });

  it('unknown owner room → 409 telling the operator to message the bot first', async () => {
    await makeApp(); // no webhook round-trip: no room known
    const res = await deliver({ path: join(tmpDir, 'logs', 'daemon.log') });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('no owner room is known yet');
    expect(json.error).toContain('message');
    expect(stub.sends).toHaveLength(0);
  });

  it('file over NIGHTSHIFT_ATTACH_MAX_MB → 400 naming the knob', async () => {
    await makeApp({ attachMaxMb: 1 });
    await learnOwnerRoom();
    writeFileSync(join(tmpDir, 'projects', 'demo', 'big.mp4'), Buffer.alloc(2 * 1024 * 1024));
    const res = await deliver({ path: join(tmpDir, 'projects', 'demo', 'big.mp4') });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('NIGHTSHIFT_ATTACH_MAX_MB');
    expect(stub.sends).toHaveLength(0);
  });

  it('the owner room survives a daemon restart: deliver works with NO inbound in the new life', async () => {
    const first = await makeApp();
    await learnOwnerRoom('room-persisted');
    await first.close();
    app = null;

    await makeApp(); // same dbPath — the settings row seeds the owner room
    const res = await deliver({ path: join(tmpDir, 'projects', 'demo', 'video.mp4') });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivered: { roomId: string } }).delivered.roomId).toBe(
      'room-persisted',
    );
    expect(stub.sends[0]?.roomId).toBe('room-persisted');
    expect(stub.sends[0]?.fileName).toBe('video.mp4');
  });

  it('CLI round-trip: nightshift deliver sends the file and exits 0; confined path exits 1', async () => {
    const a = await makeApp();
    await learnOwnerRoom();
    const port = new URL(baseUrl).port;
    const cliEnv = {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_API_TOKEN: TOKEN,
      NIGHTSHIFT_PORT: String(port),
    };

    const ok = await runCli(
      ['deliver', join(tmpDir, 'projects', 'demo', 'video.mp4'), '--note', 'here you go'],
      cliEnv,
    );
    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Delivered');
    expect(ok.stdout).toContain('video.mp4');
    expect(ok.stdout).toContain('room-d1');
    expect(stub.sends[0]?.fileName).toBe('video.mp4');
    expect(String(stub.sends[0]?.markdown)).toContain('here you go');

    const denied = await runCli(['deliver', join(tmpDir, 'secret.txt')], cliEnv);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('outside the deliverable roots');

    const noPath = await runCli(['deliver'], cliEnv);
    expect(noPath.code).toBe(1);
    expect(noPath.stderr).toContain('deliver requires a file path');

    expect(a.jobs.list()).toHaveLength(0); // deliver never touches the job runner
  });
});

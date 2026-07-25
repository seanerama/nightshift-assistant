/**
 * POST /api/v1/remarkable + `nightshift remarkable` (Stage 19, additive on
 * control-api v1) against a real app instance: the three gates in order
 * (control kill-switch → bearer → NIGHTSHIFT_REMARKABLE_ENABLED), the happy
 * path building `rmapi put <path> <folder>` (captured by an rmapi STUB — never
 * the real binary, never the cloud), path confinement (outside the roots →
 * 400), a non-zero rmapi exit → 502, and the dark-launch regression: with the
 * flag off there is no reachable route and the rmapi stub is never invoked.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeConfig, makeRmapiStub, makeTestLogger, WORKER_STUB } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/nightshift', import.meta.url));
const TOKEN = 'remarkable-api-token';

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

describe('POST /api/v1/remarkable + nightshift remarkable', () => {
  let tmpDir: string;
  let dbPath: string;
  let app: App | null;
  let baseUrl: string;
  let rmapi: ReturnType<typeof makeRmapiStub>;
  let pdfPath: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        dbPath,
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        remarkableEnabled: true,
        rmapiBin: rmapi.rmapiBin,
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

  const call = (body: unknown, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${baseUrl}/api/v1/remarkable`, {
      method: 'POST',
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-remarkable-api-'));
    dbPath = join(tmpDir, 'test.db');
    mkdirSync(join(tmpDir, 'projects', 'demo'), { recursive: true });
    writeFileSync(join(tmpDir, 'secret.txt'), 'outside the roots');
    pdfPath = join(tmpDir, 'projects', 'demo', 'paper.pdf');
    writeFileSync(pdfPath, Buffer.alloc(128, 9));
    rmapi = makeRmapiStub(tmpDir);
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('kill-switch: 403 with a clear error when NIGHTSHIFT_REMARKABLE_ENABLED is off (control on)', async () => {
    await makeApp({ remarkableEnabled: false });
    const res = await call({ path: pdfPath });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('NIGHTSHIFT_REMARKABLE_ENABLED');
    expect(rmapi.invocations()).toEqual([]); // fully dark — rmapi never shelled
  });

  it('sits behind the control gates: control off → 403, bad bearer → 401 (rmapi never runs)', async () => {
    await makeApp({ controlEnabled: false });
    const dark = await call({ path: pdfPath });
    expect(dark.status).toBe(403);
    expect(((await dark.json()) as { error: string }).error).toContain(
      'NIGHTSHIFT_CONTROL_ENABLED',
    );
    await app?.close();
    app = null;

    await makeApp();
    const unauthorized = await call({ path: pdfPath }, 'wrong-token');
    expect(unauthorized.status).toBe(401);
    expect(rmapi.invocations()).toEqual([]);
  });

  it('happy path: pushes a confined file and shells `rmapi put <path> /Inbox`', async () => {
    await makeApp();
    const res = await call({ path: pdfPath });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; pushed: { path: string; folder: string } };
    expect(json.ok).toBe(true);
    expect(json.pushed.folder).toBe('/Inbox');
    expect(json.pushed.path).toBe(pdfPath);
    expect(rmapi.invocations()).toEqual([`rmapi put ${pdfPath} /Inbox`]);
  });

  it('honors a custom NIGHTSHIFT_REMARKABLE_FOLDER in the argv', async () => {
    await makeApp({ remarkableFolder: '/Reading' });
    const res = await call({ path: pdfPath });
    expect(res.status).toBe(200);
    expect(rmapi.invocations()).toEqual([`rmapi put ${pdfPath} /Reading`]);
  });

  it('path confinement: a path outside the allowed roots → 400, nothing shelled', async () => {
    await makeApp();
    const res = await call({ path: join(tmpDir, 'secret.txt') });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'outside the deliverable roots',
    );
    expect(rmapi.invocations()).toEqual([]);
  });

  it('missing/empty path → 400', async () => {
    await makeApp();
    for (const body of [{}, { path: '' }, { path: 42 }]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'remarkable requires "path"',
      );
    }
    expect(rmapi.invocations()).toEqual([]);
  });

  it('a non-zero rmapi exit → 502 surfacing the transport failure', async () => {
    await makeApp();
    writeFileSync(join(tmpDir, 'rmapi-fail'), ''); // the stub now exits 1
    const res = await call({ path: pdfPath });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain('exited 1');
    expect(json.error).toContain('injected rmapi failure');
  });

  it('CLI round-trip: nightshift remarkable pushes and exits 0; a confined path exits 1', async () => {
    const a = await makeApp();
    const port = new URL(baseUrl).port;
    const cliEnv = {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_API_TOKEN: TOKEN,
      NIGHTSHIFT_PORT: String(port),
    };

    const ok = await runCli(['remarkable', pdfPath], cliEnv);
    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Pushed');
    expect(ok.stdout).toContain('paper.pdf');
    expect(ok.stdout).toContain('/Inbox');
    expect(rmapi.invocations()).toEqual([`rmapi put ${pdfPath} /Inbox`]);

    const denied = await runCli(['remarkable', join(tmpDir, 'secret.txt')], cliEnv);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('outside the deliverable roots');

    const noPath = await runCli(['remarkable'], cliEnv);
    expect(noPath.code).toBe(1);
    expect(noPath.stderr).toContain('remarkable requires a file path');

    expect(a.jobs.list()).toHaveLength(0); // remarkable never touches the job runner
  });
});

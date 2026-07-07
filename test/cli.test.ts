/**
 * bin/nightshift as a REAL child process against a test app instance (worker
 * stub, control enabled): submit → jobs → job → kill round-trip, --json raw
 * API passthrough, exit code 1 on error paths, helpful usage on bad args, and
 * the .env fallback (env vars unset → the app dir's .env, symlinks resolved).
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import { makeConfig, makeTestLogger, WORKER_STUB, waitFor } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/nightshift', import.meta.url));
const TOKEN = 'cli-test-token';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(binPath: string, args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env });
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

describe('nightshift CLI (child process)', () => {
  let tmpDir: string;
  let workdir: string;
  let app: App;
  let port: number;
  let cliEnv: Record<string, string>;

  const cli = (...args: string[]): Promise<CliResult> => runCli(BIN, args, cliEnv);

  const submitArgs = (instruction: string): string[] => [
    'submit',
    '--type',
    'test',
    '--title',
    'cli job',
    '--instruction',
    instruction,
    '--workdir',
    workdir,
  ];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-cli-'));
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir);
    app = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        jobsEnabled: true,
        jobKillGraceSec: 1,
        typesEnabled: true, // Stage 6 round-trip tests; raw submits unaffected
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    port = await app.listen();
    cliEnv = {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_API_TOKEN: TOKEN,
      NIGHTSHIFT_PORT: String(port),
    };
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('submit → jobs → job → kill round-trip with readable output and exit 0', async () => {
    const submitted = await cli(...submitArgs('MODE=success'), '--json');
    expect(submitted.code).toBe(0);
    const { ok, job } = JSON.parse(submitted.stdout) as {
      ok: boolean;
      job: { id: string; status: string };
    };
    expect(ok).toBe(true);
    await waitFor(() => app.jobs.get(job.id)?.status === 'succeeded');

    const list = await cli('jobs');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(job.id);
    expect(list.stdout).toContain('succeeded');
    expect(list.stdout).toContain('ID'); // readable table header

    const one = await cli('job', job.id);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain(`id:        ${job.id}`);
    expect(one.stdout).toContain('status:    succeeded');

    const filtered = await cli('jobs', '--status', 'killed');
    expect(filtered.code).toBe(0);
    expect(filtered.stdout).toContain('(no jobs)');

    // Kill leg: a sleeping job dies with exit 0 and a killed record.
    const sleeper = await cli(...submitArgs('MODE=sleep SLEEP_MS=60000'), '--json');
    const sleeperId = (JSON.parse(sleeper.stdout) as { job: { id: string } }).job.id;
    const killed = await cli('kill', sleeperId);
    expect(killed.code).toBe(0);
    expect(killed.stdout).toContain('status:    killed');
  });

  it('typed submit round-trip: --type story --params renders through the registry', async () => {
    const submitted = await cli(
      'submit',
      '--type',
      'story',
      '--params',
      '{"idea": "MODE=success bedtime turtles"}',
      '--json',
    );
    expect(submitted.stderr).toBe('');
    expect(submitted.code).toBe(0);
    const { ok, job } = JSON.parse(submitted.stdout) as {
      ok: boolean;
      job: { id: string; type: string; workdir: string };
    };
    expect(ok).toBe(true);
    expect(job.type).toBe('story');
    expect(job.workdir).toBe(join(tmpDir, 'projects', 'mode-success-bedtime-turtles'));
    await waitFor(() => app.jobs.get(job.id)?.status === 'succeeded');

    const one = await cli('job', job.id);
    expect(one.stdout).toContain('type:      story');
  });

  it('typed submit argument errors exit 1 with a clear message', async () => {
    const badJson = await cli('submit', '--type', 'story', '--params', '{nope');
    expect(badJson.code).toBe(1);
    expect(badJson.stderr).toContain('--params is not valid JSON');

    const noType = await cli('submit', '--params', '{"idea": "x"}');
    expect(noType.code).toBe(1);
    expect(noType.stderr).toContain('submit --params requires --type');

    const mixed = await cli('submit', '--type', 'story', '--params', '{}', '--title', 'x');
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain('cannot be combined with --title');

    const unknownType = await cli('submit', '--type', 'research', '--params', '{}');
    expect(unknownType.code).toBe(1);
    expect(unknownType.stderr).toContain('unknown job type: research');
  });

  it('--json emits the raw API JSON envelope', async () => {
    const res = await cli('status', '--json');
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as { ok: boolean; version: string; jobs: unknown };
    expect(json.ok).toBe(true);
    expect(json.version).toBeDefined();
    expect(json.jobs).toBeDefined();
  });

  it('status prints a readable summary', async () => {
    const res = await cli('status');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('version:');
    expect(res.stdout).toContain('jobs:');
    expect(res.stdout).toContain('job runner: enabled');
  });

  it('exit 1 on error paths: wrong token, unknown job id, unreachable daemon', async () => {
    const unauthorized = await runCli(BIN, ['status'], { ...cliEnv, NIGHTSHIFT_API_TOKEN: 'nope' });
    expect(unauthorized.code).toBe(1);
    expect(unauthorized.stderr).toContain('unauthorized');

    const missing = await cli('job', 'no-such-id');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no such job');

    const unreachable = await runCli(BIN, ['status'], { ...cliEnv, NIGHTSHIFT_PORT: '1' });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain('cannot reach the nightshift daemon');
  });

  it('exit 1 with helpful usage on bad args; --help exits 0', async () => {
    const none = await cli();
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Usage:');

    const unknown = await cli('frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command: frobnicate');

    const incomplete = await cli('submit', '--title', 'x');
    expect(incomplete.code).toBe(1);
    expect(incomplete.stderr).toContain('submit requires --type');

    const noId = await cli('kill');
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain('kill requires an id');

    const help = await cli('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('submit');
    expect(help.stdout).toContain('rotate');
  });

  it('missing token (no env, no .env) exits 1 with a pointer to both places', async () => {
    const res = await runCli(BIN, ['status'], {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_PORT: String(port),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('NIGHTSHIFT_API_TOKEN is not set');
  });

  it('promote refuses when NIGHTSHIFT_PROMOTE_ENABLED is off (exit 1, clear message)', async () => {
    // The shared app has promote dark (makeConfig default) — the CLI relays
    // the endpoint's refusal and exits 1.
    const dir = join(tmpDir, 'projects', 'some-study');
    mkdirSync(join(dir, 'guides'), { recursive: true });
    writeFileSync(join(dir, 'guides', 'chapter-01.html'), '<p>hi</p>');
    const res = await cli('promote', dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('NIGHTSHIFT_PROMOTE_ENABLED');
  });

  it('falls back to the app dir .env (script realpath, symlinks resolved)', async () => {
    // Fake deploy layout: <appdir>/bin/nightshift + <appdir>/.env, plus a
    // ~/.local/bin-style symlink pointing into it from elsewhere.
    const appDir = join(tmpDir, 'deploy');
    mkdirSync(join(appDir, 'bin'), { recursive: true });
    copyFileSync(BIN, join(appDir, 'bin', 'nightshift'));
    writeFileSync(
      join(appDir, '.env'),
      `# host env\nNIGHTSHIFT_API_TOKEN="${TOKEN}"\nNIGHTSHIFT_PORT=${port}\n`,
    );
    const linkDir = join(tmpDir, 'local-bin');
    mkdirSync(linkDir);
    symlinkSync(join(appDir, 'bin', 'nightshift'), join(linkDir, 'nightshift'));

    const bare = { PATH: process.env.PATH ?? '' }; // no token, no port in env
    const direct = await runCli(join(appDir, 'bin', 'nightshift'), ['status'], bare);
    expect(direct.stderr).toBe('');
    expect(direct.code).toBe(0);
    expect(direct.stdout).toContain('version:');

    const viaSymlink = await runCli(join(linkDir, 'nightshift'), ['status'], bare);
    expect(viaSymlink.code).toBe(0);
    expect(viaSymlink.stdout).toContain('version:');
  });
});

describe('nightshift promote (CLI, promotion enabled)', () => {
  let tmpDir: string;
  let contentDir: string;
  let app: App;
  let cliEnv: Record<string, string>;

  const cli = (...args: string[]): Promise<CliResult> => runCli(BIN, args, cliEnv);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-cli-promote-'));
    contentDir = join(tmpDir, 'projects', 'subnet-study');
    mkdirSync(join(contentDir, 'guides'), { recursive: true });
    writeFileSync(join(contentDir, 'guides', 'chapter-01.html'), '<p>one</p>');
    // Dry runs never touch the infra, so the unreachable makeConfig promote
    // defaults are exactly right — any accidental execution would fail loudly.
    app = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        promoteEnabled: true,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const port = await app.listen();
    cliEnv = {
      PATH: process.env.PATH ?? '',
      NIGHTSHIFT_API_TOKEN: TOKEN,
      NIGHTSHIFT_PORT: String(port),
    };
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry run is the DEFAULT: prints the plan, says nothing executed and how to execute', async () => {
    const res = await cli('promote', contentDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('status:    planned');
    expect(res.stdout).toContain('slug:      subnet-study');
    expect(res.stdout).toContain('url:       https://subnet-study.example.test');
    expect(res.stdout).toContain('repo:      https://github.com/seanerama/subnet-study');
    expect(res.stdout).toContain('ok   validate');
    expect(res.stdout).toContain('ok   health');
    expect(res.stdout).toContain('NOTHING was executed');
    expect(res.stdout).toContain('Re-run with --yes to execute');
    // Proof nothing ran: the source dir gained no .git.
    expect(existsSync(join(contentDir, '.git'))).toBe(false);
  });

  it('--dry-run behaves identically; --slug/--title pass through; --json is raw', async () => {
    const res = await cli(
      'promote',
      contentDir,
      '--dry-run',
      '--slug',
      'ipv4-subnetting',
      '--title',
      'IPv4 Subnetting',
      '--json',
    );
    expect(res.code).toBe(0);
    const json = JSON.parse(res.stdout) as {
      ok: boolean;
      promotion: { slug: string; title: string; status: string };
    };
    expect(json.ok).toBe(true);
    expect(json.promotion.status).toBe('planned');
    expect(json.promotion.slug).toBe('ipv4-subnetting');
    expect(json.promotion.title).toBe('IPv4 Subnetting');
  });

  it('argument errors exit 1: missing path, --dry-run with --yes', async () => {
    const noPath = await cli('promote');
    expect(noPath.code).toBe(1);
    expect(noPath.stderr).toContain('promote requires a path');

    const conflict = await cli('promote', contentDir, '--dry-run', '--yes');
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('mutually exclusive');
  });

  it('rejected input relays the API error and exits 1', async () => {
    const res = await cli('promote', join(tmpDir, 'projects', 'does-not-exist'));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('not found');
  });
});

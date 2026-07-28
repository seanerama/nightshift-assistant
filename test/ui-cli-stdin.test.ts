/**
 * Stage 36 regression: `nightshift ui validate -` / `ui install -` read the
 * HTML from STDIN (pipe or heredoc) — the only composition path open to the
 * conversational session, whose containment grants no file-write capability
 * (live repro 2026-07-28, session 84b4442c: every temp-file attempt denied
 * until the turn cap killed the turn). Before this stage the CLI had no stdin
 * path at all: parseArgs rejected bare `-` as "unknown option: -" (and had it
 * gotten through, readHtml would have treated it as a filename) — these tests
 * fail on that behavior. `-` ALWAYS means stdin (a file literally named "-" is not
 * addressable this way); empty stdin is a usage error caught in the CLI —
 * nothing reaches the daemon. File-path behavior is unchanged and re-pinned
 * here. Mirrors the test/cli.test.ts child-process harness.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import { makeConfig, makeTestLogger, WORKER_STUB } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/nightshift', import.meta.url));
const TOKEN = 'cli-stdin-test-token';

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);
const BAD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/bad-no-storage.html', import.meta.url)),
  'utf8',
);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI; `stdin` (possibly empty) is written then closed —
 * exactly what a shell pipe or heredoc does. */
function runCli(args: string[], env: Record<string, string>, stdin?: string): Promise<CliResult> {
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
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('nightshift ui validate/install from stdin (Stage 36)', () => {
  let tmpDir: string;
  let app: App;
  let cliEnv: Record<string, string>;

  const cli = (args: string[], stdin?: string): Promise<CliResult> => runCli(args, cliEnv, stdin);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ui-stdin-'));
    app = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        generativeUiEnabled: true,
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

  it('pipes a valid page into `ui validate -`: exit 0, verdict valid (fails before: `-` rejected as unknown option)', async () => {
    const res = await cli(['ui', 'validate', '-'], GOOD_HTML);
    // Before Stage 36 this path died with "unknown option: -" and exit 1.
    expect(res.stderr).not.toContain('unknown option');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Valid.');
  });

  it('pipes a valid page into `ui install - --name stdin-page`: registers v1, visible in the registry', async () => {
    const res = await cli(
      ['ui', 'install', '-', '--name', 'stdin-page', '--provenance', 'stage-36 stdin test'],
      GOOD_HTML,
    );
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Installed.');
    expect(res.stdout).toContain('name:      stdin-page');
    expect(res.stdout).toContain('version:   1');

    // The registered page round-trips byte-identically through the door.
    const show = await cli(['ui', 'show', 'stdin-page', '1', '--json']);
    expect(show.code).toBe(0);
    const json = JSON.parse(show.stdout) as { ok: boolean; resource: { html: string } };
    expect(json.ok).toBe(true);
    expect(json.resource.html).toBe(GOOD_HTML);
  });

  it('pipes an INVALID page into `ui validate -`: exit 1 with the verdict relayed', async () => {
    const res = await cli(['ui', 'validate', '-'], BAD_HTML);
    expect(res.code).toBe(1);
    // House style: an ok:false reply is relayed as `error: …` on stderr —
    // the validate door folds the verdict into the error line.
    expect(res.stderr).toContain('ui validation failed');
    expect(res.stderr).toContain('no-storage');
  });

  it('pipes an INVALID page into `ui install -`: exit 1, nothing registered', async () => {
    const res = await cli(['ui', 'install', '-', '--name', 'bad-page'], BAD_HTML);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ui validation failed');

    const list = await cli(['ui', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('(no ui resources)');
  });

  it('empty stdin (zero bytes or whitespace-only) is a usage error — nothing reaches the daemon', async () => {
    for (const body of ['', '   \n\t\n']) {
      for (const verb of [
        ['ui', 'validate', '-'],
        ['ui', 'install', '-', '--name', 'ghost'],
      ]) {
        const res = await cli(verb, body);
        expect(res.code).toBe(1);
        expect(res.stderr).toContain('stdin was empty');
        expect(res.stderr).toContain('Usage:');
      }
    }
    // Registry untouched: no ghost install, no version consumed.
    const list = await cli(['ui', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('(no ui resources)');
  });

  it('file-path behavior is unchanged; `-` never names a file even when one named "-" exists', async () => {
    const file = join(tmpDir, 'page.html');
    writeFileSync(file, GOOD_HTML);
    const viaFile = await cli(['ui', 'validate', file]);
    expect(viaFile.code).toBe(0);
    expect(viaFile.stdout).toContain('Valid.');

    // A file literally named "-" in cwd does NOT shadow stdin: the piped
    // (invalid) body is what gets validated, not the valid file on disk.
    writeFileSync(join(tmpDir, '-'), GOOD_HTML);
    const child = spawn(process.execPath, [BIN, 'ui', 'validate', '-'], {
      env: cliEnv,
      cwd: tmpDir,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (c) => resolve(c ?? -1));
      child.stdin.write(BAD_HTML);
      child.stdin.end();
    });
    expect(code).toBe(1);
    expect(stderr).toContain('ui validation failed'); // stdin won, the file did not
  });

  it('USAGE documents the `-` form on both verbs', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('ui validate <file|->');
    expect(help.stdout).toContain('ui install <file|->');
    expect(help.stdout).toContain('ALWAYS means stdin');
  });
});

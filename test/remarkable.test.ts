/**
 * createRemarkablePusher (Stage 19, additive on control-api v1): the transport
 * unit in isolation — the exec is INJECTED (`run`) so nothing ever shells rmapi
 * or touches the reMarkable cloud. Covers: the correct `rmapi put <path>
 * <folder>` argv (captured via the injected run), path confinement to the
 * deliver roots (traversal / outside / symlink escape → rejected, run never
 * called), a non-zero rmapi exit surfaced as a RemarkableError, and the
 * dark-by-default refusal when enabled=false (run never called).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeliverError } from '../src/transport/deliver.js';
import {
  createRemarkablePusher,
  RemarkableError,
  type RemarkableRunResult,
} from '../src/transport/remarkable.js';
import { makeTestLogger } from './helpers.js';

describe('createRemarkablePusher', () => {
  let tmpDir: string;
  let roots: string[];
  /** Every argv the injected run seam was handed (proves nothing hit the cloud). */
  let calls: string[][];

  const okRun = async (argv: string[]): Promise<RemarkableRunResult> => {
    calls.push(argv);
    return { code: 0, stdout: 'uploaded', stderr: '' };
  };

  const makePusher = (
    overrides: Partial<Parameters<typeof createRemarkablePusher>[0]> = {},
  ): ReturnType<typeof createRemarkablePusher> =>
    createRemarkablePusher({
      enabled: true,
      folder: '/Inbox',
      rmapiBin: 'rmapi',
      allowedRoots: roots,
      run: okRun,
      log: makeTestLogger(),
      ...overrides,
    });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-remarkable-unit-'));
    mkdirSync(join(tmpDir, 'projects', 'demo'), { recursive: true });
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    writeFileSync(join(tmpDir, 'projects', 'demo', 'paper.pdf'), Buffer.alloc(64, 1));
    writeFileSync(join(tmpDir, 'secret.txt'), 'outside the roots');
    roots = [join(tmpDir, 'projects'), join(tmpDir, 'logs')];
    calls = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds the correct `rmapi put <path> <folder>` argv and returns the resolved path', async () => {
    const pusher = makePusher();
    const file = join(tmpDir, 'projects', 'demo', 'paper.pdf');
    const result = await pusher.push(file);

    expect(result.folder).toBe('/Inbox');
    expect(result.path).toBe(file);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['rmapi', 'put', file, '/Inbox']);
  });

  it('honors a custom rmapiBin + folder in the argv', async () => {
    const pusher = makePusher({ rmapiBin: '/opt/rmapi/rmapi', folder: '/Reading' });
    const file = join(tmpDir, 'projects', 'demo', 'paper.pdf');
    await pusher.push(file);
    expect(calls[0]).toEqual(['/opt/rmapi/rmapi', 'put', file, '/Reading']);
  });

  it('rejects a path outside the allowed roots — and never shells rmapi', async () => {
    const pusher = makePusher();
    await expect(pusher.push(join(tmpDir, 'secret.txt'))).rejects.toBeInstanceOf(DeliverError);
    expect(calls).toHaveLength(0);
  });

  it('rejects traversal + symlink escape + a non-absolute path (nothing runs)', async () => {
    // A symlink INSIDE an allowed root pointing OUTSIDE it.
    symlinkSync(join(tmpDir, 'secret.txt'), join(tmpDir, 'projects', 'demo', 'leak.pdf'));
    const pusher = makePusher();

    for (const path of [
      `${tmpDir}/projects/../secret.txt`, // dot-dot traversal
      join(tmpDir, 'projects', 'demo', 'leak.pdf'), // symlink escape
      '/etc/passwd', // arbitrary filesystem
      'projects/demo/paper.pdf', // not absolute
    ]) {
      await expect(pusher.push(path), path).rejects.toBeInstanceOf(DeliverError);
    }
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-zero rmapi exit as a RemarkableError (502) naming the command', async () => {
    const failRun = async (argv: string[]): Promise<RemarkableRunResult> => {
      calls.push(argv);
      return { code: 1, stdout: '', stderr: 'cloud auth failed' };
    };
    const pusher = makePusher({ run: failRun });
    const file = join(tmpDir, 'projects', 'demo', 'paper.pdf');

    const err = await pusher.push(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemarkableError);
    expect((err as RemarkableError).status).toBe(502);
    expect((err as RemarkableError).message).toContain('exited 1');
    expect((err as RemarkableError).message).toContain('cloud auth failed');
    expect(calls).toHaveLength(1); // it did try the upload before failing
  });

  it('refuses when enabled=false (dark by default) — RemarkableError 403, run never called', async () => {
    const pusher = makePusher({ enabled: false });
    const file = join(tmpDir, 'projects', 'demo', 'paper.pdf');

    const err = await pusher.push(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemarkableError);
    expect((err as RemarkableError).status).toBe(403);
    expect((err as RemarkableError).message).toContain('NIGHTSHIFT_REMARKABLE_ENABLED');
    expect(calls).toHaveLength(0);
  });
});

/**
 * Notice builder (Stage 10): golden-string tests for every variant — success
 * (summary truncated at a sentence boundary, outputs + delivery hint), failure
 * (attempts, reason, code-fenced log tail), killed, rotation — plus the
 * auto-attach selector (existing regular files ≤ cap, bounded count, 0 disables).
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  failureNotice,
  killedNotice,
  promotionFailureNotice,
  promotionLiveNotice,
  rotationNotice,
  selectAutoAttach,
  successNotice,
  truncateSummary,
} from '../src/notices.js';

describe('truncateSummary', () => {
  it('keeps a one- or two-sentence summary whole', () => {
    expect(truncateSummary('Built the app.')).toBe('Built the app.');
    expect(truncateSummary('Built the app. Tests pass.')).toBe('Built the app. Tests pass.');
  });

  it('truncates a longer summary at the second sentence boundary', () => {
    expect(truncateSummary('One done. Two done. Three done. Four done.')).toBe(
      'One done. Two done.',
    );
    expect(truncateSummary('Deployed! Is it live? Yes it is.')).toBe('Deployed! Is it live?');
  });

  it('does not split on punctuation inside tokens (versions, filenames)', () => {
    expect(truncateSummary('Shipped v1.2 of app.js today. All good. Extra tail.')).toBe(
      'Shipped v1.2 of app.js today. All good.',
    );
  });

  it('returns the whole trimmed text when there is no sentence boundary', () => {
    expect(truncateSummary('  no terminal punctuation at all  ')).toBe(
      'no terminal punctuation at all',
    );
  });
});

describe('notice variants (golden strings)', () => {
  it('success: bold title, truncated summary, outputs line, delivery hint', () => {
    const notice = successNotice({
      title: 'Lighthouse story',
      type: 'story',
      summary: 'Rendered the video. Narration is loudness-matched. Ignore this third sentence.',
      outputs: ['final.mp4', 'cover.png'],
    });
    expect(notice).toBe(
      '✅ **Lighthouse story** — story finished\n' +
        '\n' +
        'Rendered the video. Narration is loudness-matched.\n' +
        '\n' +
        'Outputs: final.mp4, cover.png\n' +
        'Say "send me <file>" for delivery.',
    );
  });

  it('success without outputs: no outputs line, no hint line', () => {
    const notice = successNotice({
      title: 'Cleanup',
      type: 'generic',
      summary: 'Done.',
      outputs: [],
    });
    expect(notice).toBe('✅ **Cleanup** — generic finished\n\nDone.');
    expect(notice).not.toContain('Outputs:');
    expect(notice).not.toContain('send me');
  });

  it('failure: attempts, reason, log tail in a code fence', () => {
    const notice = failureNotice({
      title: 'Nightly build',
      type: 'app-build',
      attempts: 2,
      reason: 'no completion sentinel was written (exit code 3, signal none)',
      logTail: 'line a\nline b',
    });
    expect(notice).toBe(
      '❌ **Nightly build** — app-build failed after 2 attempt(s)\n' +
        'Reason: no completion sentinel was written (exit code 3, signal none)\n' +
        '\n' +
        'Last log lines:\n' +
        '```\n' +
        'line a\nline b\n' +
        '```',
    );
  });

  it('killed', () => {
    expect(killedNotice({ title: 'Sleeper', type: 'generic' })).toBe(
      '⏹ **Sleeper** — generic killed',
    );
  });

  it('rotation', () => {
    expect(rotationNotice('daily', 'logs/daily/2026-07-06.md')).toBe(
      '🌀 Session rotated (daily) — summary at logs/daily/2026-07-06.md',
    );
  });

  it('promotion live (Stage 11): 🚀 with the URL first, then the repo', () => {
    const notice = promotionLiveNotice({
      title: 'Subnetting Study',
      slug: 'subnet-study',
      url: 'https://subnet-study.seanmahoney.ai',
      repoUrl: 'https://github.com/seanerama/subnet-study',
    });
    expect(notice).toBe(
      '🚀 **Subnetting Study** — promotion `subnet-study` is live\n' +
        'https://subnet-study.seanmahoney.ai\n' +
        'Repo: https://github.com/seanerama/subnet-study',
    );
  });

  it('promotion failed (Stage 11): 🚀 naming the failed step and the error', () => {
    const notice = promotionFailureNotice({
      title: 'Subnetting Study',
      slug: 'subnet-study',
      step: 'coolify',
      error: 'Coolify app create returned HTTP 500',
    });
    expect(notice).toBe(
      '🚀 **Subnetting Study** — promotion `subnet-study` FAILED at step `coolify`\n' +
        'Coolify app create returned HTTP 500',
    );
  });
});

describe('selectAutoAttach', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightshift-notices-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks existing regular files at or under the cap, resolving relative paths', () => {
    writeFileSync(join(dir, 'small.txt'), 'hello');
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024));
    mkdirSync(join(dir, 'a-directory'));
    const picked = selectAutoAttach(
      ['small.txt', 'big.bin', 'a-directory', 'never-made.txt', join(dir, 'small.txt')],
      dir,
      1, // 1MB cap: big.bin (2MB) is silently skipped
    );
    expect(picked).toEqual([join(dir, 'small.txt'), join(dir, 'small.txt')]);
  });

  it('bounds the count at 3 (first three eligible)', () => {
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(dir, name), name);
    expect(selectAutoAttach(['a', 'b', 'c', 'd'], dir, 10)).toEqual([
      join(dir, 'a'),
      join(dir, 'b'),
      join(dir, 'c'),
    ]);
  });

  it('0 disables auto-attach entirely', () => {
    writeFileSync(join(dir, 'small.txt'), 'hello');
    expect(selectAutoAttach(['small.txt'], dir, 0)).toEqual([]);
  });

  it('skips dangling symlinks but follows real ones (stat, not lstat)', () => {
    writeFileSync(join(dir, 'real.txt'), 'x');
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    symlinkSync(join(dir, 'gone.txt'), join(dir, 'dangling.txt'));
    expect(selectAutoAttach(['link.txt', 'dangling.txt'], dir, 10)).toEqual([
      join(dir, 'link.txt'),
    ]);
  });
});

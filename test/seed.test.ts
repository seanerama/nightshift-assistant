/** Seed builder: concatenation order, latest-summary selection, byte bounding. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSeed, latestDailyFile } from '../src/session/seed.js';

describe('buildSeed', () => {
  let appDir: string;

  const write = (rel: string, content: string): void => {
    const path = join(appDir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  };

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), 'nightshift-seed-'));
  });

  afterEach(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  it('returns "" when there is nothing to seed (fresh install)', () => {
    expect(buildSeed(appDir, 16384)).toBe('');
  });

  it('concatenates memory files and ONLY the latest daily summary', () => {
    write('memory/MEMORY.md', '# Memory Index\n- [2026-07-05](2026-07-05.md)\n');
    write('memory/2026-07-05.md', 'Owner prefers rotation at 4am.');
    write('logs/daily/2026-07-04.md', 'OLD summary about apples.');
    write('logs/daily/2026-07-05.md', 'NEW summary about bananas.');

    const seed = buildSeed(appDir, 16384);
    expect(seed).toContain('# Memory Index');
    expect(seed).toContain('Owner prefers rotation at 4am.');
    expect(seed).toContain('NEW summary about bananas.');
    expect(seed).not.toContain('apples');
    // Labeled so the model knows where the context came from.
    expect(seed).toContain('memory/2026-07-05.md');
    expect(seed).toContain('logs/daily/2026-07-05.md');
  });

  it('treats the highest same-day suffix as the latest daily summary', () => {
    write('logs/daily/2026-07-05.md', 'first rotation of the day');
    write('logs/daily/2026-07-05-2.md', 'second rotation of the day');
    write('logs/daily/2026-07-04.md', 'yesterday');

    expect(latestDailyFile(join(appDir, 'logs', 'daily'))).toBe(
      join(appDir, 'logs', 'daily', '2026-07-05-2.md'),
    );
    const seed = buildSeed(appDir, 16384);
    expect(seed).toContain('second rotation of the day');
    expect(seed).not.toContain('first rotation of the day');
  });

  it('truncates an oversized seed to the byte bound, newest content wins', () => {
    write('memory/2026-07-01.md', `OLDEST-MARKER\n${'x'.repeat(2000)}`);
    write('memory/2026-07-05.md', `RECENT-MARKER\n${'y'.repeat(100)}`);
    write('logs/daily/2026-07-05.md', `${'z'.repeat(100)}\nNEWEST-MARKER`);

    const maxBytes = 512;
    const seed = buildSeed(appDir, maxBytes);
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(maxBytes);
    expect(seed).toContain('NEWEST-MARKER');
    expect(seed).not.toContain('OLDEST-MARKER');
    expect(seed).toContain('[seed truncated');
  });

  it('keeps everything when under the bound', () => {
    write('memory/2026-07-05.md', 'small fact');
    const seed = buildSeed(appDir, 16384);
    expect(seed).not.toContain('[seed truncated');
    expect(seed).toContain('small fact');
  });
});

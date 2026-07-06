/**
 * Seed context for a brand-new conversational session (contract ritual step 5):
 * concatenated memory/ files + the most recent logs/daily/ summary, size-bounded
 * with newest-content-wins truncation (oldest bytes drop first). Returns '' when
 * there is nothing to seed — the caller then adds no seed argument at all.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.md$/;
const TRUNCATION_NOTICE = '[seed truncated: oldest content dropped to fit the size bound]\n';

/** Newest logs/daily file: latest date wins, then the highest same-day suffix. */
export function latestDailyFile(dailyDir: string): string | null {
  if (!existsSync(dailyDir)) return null;
  let best: { date: string; suffix: number; name: string } | null = null;
  for (const name of readdirSync(dailyDir)) {
    const match = DAILY_FILE.exec(name);
    if (match?.[1] === undefined) continue;
    const date = match[1];
    const suffix = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
    if (best === null || date > best.date || (date === best.date && suffix > best.suffix)) {
      best = { date, suffix, name };
    }
  }
  return best === null ? null : join(dailyDir, best.name);
}

/** Build the seed text from <appDir>/memory + <appDir>/logs/daily, ≤ maxBytes. */
export function buildSeed(appDir: string, maxBytes: number): string {
  const pieces: Array<{ label: string; content: string }> = [];

  const memoryDir = join(appDir, 'memory');
  if (existsSync(memoryDir)) {
    const names = readdirSync(memoryDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    // MEMORY.md (the index) first so it is the first to drop under truncation;
    // dated files follow oldest→newest so the newest content survives.
    const ordered = [
      ...names.filter((n) => n === 'MEMORY.md'),
      ...names.filter((n) => n !== 'MEMORY.md'),
    ];
    for (const name of ordered) {
      pieces.push({
        label: `memory/${name}`,
        content: readFileSync(join(memoryDir, name), 'utf8'),
      });
    }
  }

  const latest = latestDailyFile(join(appDir, 'logs', 'daily'));
  if (latest !== null) {
    pieces.push({
      label: `logs/daily/${basename(latest)}`,
      content: readFileSync(latest, 'utf8'),
    });
  }

  if (pieces.length === 0) return '';

  const body = pieces.map((p) => `--- ${p.label} ---\n${p.content.trim()}`).join('\n\n');
  const full = `Restored context from previous sessions (memory files + latest daily summary):\n\n${body}`;
  const buf = Buffer.from(full, 'utf8');
  if (buf.length <= maxBytes) return full;

  // Newest-wins truncation: keep the tail bytes, drop the partial leading line
  // (which also discards any multi-byte character sliced in half).
  const keep = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8'));
  let tail = buf.subarray(buf.length - keep).toString('utf8');
  const firstNewline = tail.indexOf('\n');
  if (firstNewline !== -1) tail = tail.slice(firstNewline + 1);
  return TRUNCATION_NOTICE + tail;
}

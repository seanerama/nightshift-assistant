/**
 * Rotation ritual file operations (contracts/assistant-session.md). The session
 * manager OWNS this layout — single source of truth for these paths:
 *   logs/daily/YYYY-MM-DD.md   — rotation summaries (permanent record)
 *   memory/                    — durable memory loaded into every new session
 *   logs/transcripts/          — archived transcript locations
 * Kept as plain helpers so the manager stays orchestration-only.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DURABLE_START = '=== DURABLE MEMORY ===';
export const DURABLE_END = '=== END DURABLE MEMORY ===';

/** Fixed summarization prompt for the outgoing session's final turn. */
export const SUMMARY_PROMPT = [
  'This conversational session is being rotated out. Write a concise end-of-session',
  'summary in markdown covering: what was discussed, what was decided, what was',
  'built, and what is unfinished.',
  '',
  `Then append a durable-memory block delimited EXACTLY by the lines "${DURABLE_START}"`,
  `and "${DURABLE_END}", containing one durable fact worth keeping across sessions`,
  'per line. Leave the block empty if there are none.',
].join('\n');

/** Local YYYY-MM-DD for a Date (rotation boundaries and filenames are local time). */
export function localDateStamp(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Extract the durable-memory block from a summary ('' when absent or empty). */
export function extractDurableMemory(summary: string): string {
  const start = summary.indexOf(DURABLE_START);
  if (start === -1) return '';
  const afterStart = start + DURABLE_START.length;
  const end = summary.indexOf(DURABLE_END, afterStart);
  if (end === -1) return '';
  return summary.slice(afterStart, end).trim();
}

/** Write the day-summary to logs/daily/YYYY-MM-DD.md (suffix -2, -3… on repeats). */
export function writeDailySummary(appDir: string, date: Date, content: string): string {
  const dir = join(appDir, 'logs', 'daily');
  mkdirSync(dir, { recursive: true });
  const stamp = localDateStamp(date);
  let path = join(dir, `${stamp}.md`);
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, `${stamp}-${n}.md`);
  }
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Promote durable facts into memory/: dated append file + MEMORY.md index line
 * (no dedup intelligence yet — Stage 2 scope). Returns the dated file path, or
 * null when there was nothing to promote.
 */
export function promoteDurableMemory(
  appDir: string,
  date: Date,
  rotatedAt: string,
  facts: string,
): string | null {
  if (facts === '') return null;
  const dir = join(appDir, 'memory');
  mkdirSync(dir, { recursive: true });
  const stamp = localDateStamp(date);
  const datedPath = join(dir, `${stamp}.md`);
  const isNewFile = !existsSync(datedPath);
  appendFileSync(datedPath, `## Promoted at ${rotatedAt}\n\n${facts}\n\n`, 'utf8');

  const indexPath = join(dir, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, '# Memory Index\n\n', 'utf8');
  }
  if (isNewFile) {
    appendFileSync(indexPath, `- [${stamp}](${stamp}.md)\n`, 'utf8');
  }
  return datedPath;
}

/** Default claude CLI projects root (the transcript-lookup test seam overrides it). */
export function defaultProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * claude CLI project-transcript convention:
 * <projectsRoot>/<cwd-slug>/<session-id>.jsonl, where the slug is the absolute
 * cwd with every non-alphanumeric character replaced by '-'.
 */
export function transcriptPathFor(projectsRoot: string, cwd: string, sessionId: string): string {
  const slug = resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return join(projectsRoot, slug, `${sessionId}.jsonl`);
}

/** Record the transcript location in logs/transcripts/ (copying is optional). */
export function recordTranscriptLocation(
  appDir: string,
  rotatedAt: string,
  sessionId: string,
  transcriptPath: string,
): void {
  const dir = join(appDir, 'logs', 'transcripts');
  mkdirSync(dir, { recursive: true });
  const location = transcriptPath === '' ? '(transcript not found)' : transcriptPath;
  appendFileSync(join(dir, 'index.md'), `- ${rotatedAt} ${sessionId}: ${location}\n`, 'utf8');
}

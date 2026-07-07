/**
 * Notice builder (Stage 10): the ONE place every proactive Webex notice gets
 * its shape — job success/failure/killed (the runner) and session rotation
 * (the session manager). Compact, consistent, golden-string-tested; no raw
 * sentinel dumps anywhere. The auto-attach selector lives here too so the
 * success notice and its attachments come from the same module.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { RotationReason } from './types.js';

/** Success notices auto-attach at most this many outputs; the rest stay on-request. */
export const AUTOATTACH_MAX_FILES = 3;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Truncate a sentinel summary at a sentence boundary: at most `maxSentences`
 * sentences. A boundary is `.`/`!`/`?` followed by whitespace or end-of-text
 * (so "v1.2" never splits). No boundary at all → the whole (trimmed) text.
 */
export function truncateSummary(summary: string, maxSentences = 2): string {
  const text = summary.trim();
  const boundary = /[.!?]+(?=\s|$)/g;
  let count = 0;
  let match = boundary.exec(text);
  while (match !== null) {
    count += 1;
    if (count === maxSentences) return text.slice(0, match.index + match[0].length);
    match = boundary.exec(text);
  }
  return text;
}

/**
 * ✅ success: bold title, ≤2-sentence summary, outputs line + delivery hint
 * (both only when the sentinel listed outputs).
 */
export function successNotice(input: {
  title: string;
  type: string;
  summary: string;
  outputs: string[];
}): string {
  const lines = [
    `✅ **${input.title}** — ${input.type} finished`,
    '',
    truncateSummary(input.summary),
  ];
  if (input.outputs.length > 0) {
    lines.push('', `Outputs: ${input.outputs.join(', ')}`, 'Say "send me <file>" for delivery.');
  }
  return lines.join('\n');
}

/** ❌ chain-terminal failure: attempts, reason, log tail in a code fence. */
export function failureNotice(input: {
  title: string;
  type: string;
  attempts: number;
  reason: string;
  logTail: string;
}): string {
  return (
    `❌ **${input.title}** — ${input.type} failed after ${input.attempts} attempt(s)\n` +
    `Reason: ${input.reason}\n\n` +
    `Last log lines:\n\`\`\`\n${input.logTail}\n\`\`\``
  );
}

/** ⏹ killed. */
export function killedNotice(input: { title: string; type: string }): string {
  return `⏹ **${input.title}** — ${input.type} killed`;
}

/** 🌀 session rotation. */
export function rotationNotice(reason: RotationReason, summaryPath: string): string {
  return `🌀 Session rotated (${reason}) — summary at ${summaryPath}`;
}

/**
 * Pick the sentinel outputs that ride a success notice: existing regular
 * files at or under `maxMb`, first `maxFiles` of them (the rest — and
 * anything video-sized — stay on-request via `nightshift deliver`). Relative
 * outputs resolve against the job's workdir. 0 disables auto-attach entirely.
 */
export function selectAutoAttach(
  outputs: string[],
  workdir: string,
  maxMb: number,
  maxFiles: number = AUTOATTACH_MAX_FILES,
): string[] {
  if (maxMb <= 0) return [];
  const picked: string[] = [];
  for (const output of outputs) {
    if (picked.length >= maxFiles) break;
    const path = isAbsolute(output) ? output : join(workdir, output);
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size > maxMb * BYTES_PER_MB) continue;
      picked.push(path);
    } catch {
      // Listed but never produced (or unreadable): silently skip.
    }
  }
  return picked;
}

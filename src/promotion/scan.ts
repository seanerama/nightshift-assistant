/**
 * Pre-push secret scan (contracts/promotion.md step 2; FIX-M8 carryover per
 * ADR 0008). Promotion publishes a PUBLIC GitHub repo, so ANY hit aborts the
 * pipeline BEFORE git init — nothing leaves the box. Two layers:
 *   1. filename deny-patterns — .env*, *.pem, *key*, credentials*,
 *      service-account* (spec-fixed; deliberately over-broad — a false
 *      positive costs a rename, a false negative costs a leaked credential);
 *   2. a light content scan of text files for obvious token shapes (AWS keys,
 *      PEM private-key blocks, GitHub/Slack/API tokens, quoted secret
 *      assignments).
 * Deterministic and dependency-free — no LLM, no network (ADR 0008).
 */

import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One scan finding: the offending file (relative to the scan root) + why. */
export interface ScanHit {
  file: string;
  reason: string;
}

/** Filename deny-patterns from the stage spec (matched against the basename). */
const FILENAME_DENY: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^\.env(?:$|\.|-)/i, label: 'env file (.env*)' },
  { pattern: /\.pem$/i, label: 'PEM file (*.pem)' },
  { pattern: /key/i, label: 'key-named file (*key*)' },
  { pattern: /^credentials/i, label: 'credentials file (credentials*)' },
  { pattern: /^service-account/i, label: 'service-account file (service-account*)' },
];

/** Obvious token shapes for the light content scan. */
const CONTENT_DENY: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'PEM private key block' },
  { pattern: /gh[pousr]_[A-Za-z0-9]{36,}/, label: 'GitHub token' },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/, label: 'GitHub fine-grained token' },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  { pattern: /sk-[A-Za-z0-9_-]{32,}/, label: 'sk- API key' },
  {
    pattern: /(?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
    label: 'quoted secret assignment',
  },
];

/** Read at most `max` bytes of a file without pulling a huge blob into memory. */
function readHead(path: string, max: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

const CONTENT_SCAN_MAX_BYTES = 1024 * 1024; // scan at most the first 1MB of each file

/**
 * Walk `root` (skipping .git) and return every hit. Empty array = clean.
 * Read-only by construction — safe to run before ANY side effect.
 */
export function scanForSecrets(root: string): ScanHit[] {
  const hits: ScanHit[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full);

      const nameHit = FILENAME_DENY.find(({ pattern }) => pattern.test(entry.name));
      if (nameHit !== undefined) {
        hits.push({ file: rel, reason: nameHit.label });
        continue; // one reason per file is enough to abort
      }

      const head = readHead(full, CONTENT_SCAN_MAX_BYTES);
      if (head.includes(0)) continue; // binary — filename layer is its only gate
      const text = head.toString('utf8');
      const contentHit = CONTENT_DENY.find(({ pattern }) => pattern.test(text));
      if (contentHit !== undefined) {
        hits.push({ file: rel, reason: contentHit.label });
      }
    }
  };
  walk(root);
  return hits;
}

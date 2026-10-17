/**
 * Shared bearer-token check for every token-gated door: the control API
 * (/api/v1, NIGHTSHIFT_API_TOKEN), the app transport (/app/v1,
 * NIGHTSHIFT_APP_TOKEN) and the hook ingress (/hook/v1,
 * NIGHTSHIFT_HOOK_TOKEN). Extracted verbatim from the two private copies
 * (Stage 39) — one implementation, identical behavior at every call site.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time bearer check. Both sides are hashed to fixed length first so
 * timingSafeEqual is applicable (it requires equal lengths) and the comparison
 * leaks neither content nor length of the expected token. Empty expected
 * token → fail closed, never compare.
 */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (expected === '') return false;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

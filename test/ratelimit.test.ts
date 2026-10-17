/**
 * Stage 39: the in-memory token bucket behind the hook ingress rate limit
 * (contracts/hook-ingress.md) — burst admitted, steady refill, integral
 * Retry-After, capped capacity, and a backwards clock refilling nothing.
 * Plus the extracted shared bearer helper (src/transport/auth.ts), whose
 * behavior the control API and app transport suites pin end to end.
 */

import { describe, expect, it } from 'vitest';
import { tokenMatches } from '../src/transport/auth.js';
import { createTokenBucket } from '../src/transport/ratelimit.js';

describe('createTokenBucket', () => {
  it('admits the burst, then refuses with whole-second Retry-After until refill', () => {
    let t = 1_000_000;
    const bucket = createTokenBucket({ ratePerMin: 6, burst: 3, now: () => t });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take()).toEqual({ ok: false, retryAfterSec: 10 });
    t += 4_000;
    expect(bucket.take()).toEqual({ ok: false, retryAfterSec: 6 });
    t += 6_000;
    expect(bucket.take()).toEqual({ ok: true });
    expect(bucket.take().ok).toBe(false);
  });

  it('never refills past capacity, and a clock going backwards refills nothing', () => {
    let t = 0;
    const bucket = createTokenBucket({ ratePerMin: 60, burst: 2, now: () => t });
    t += 3_600_000; // an idle hour still only holds `burst` tokens
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(true);
    expect(bucket.take().ok).toBe(false);
    t -= 10_000;
    expect(bucket.take().ok).toBe(false);
  });
});

describe('tokenMatches (shared bearer helper)', () => {
  it('constant-time match on "Bearer <token>"; fails closed on an empty expected token', () => {
    expect(tokenMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(tokenMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(tokenMatches('Bearer s3cretX', 's3cret')).toBe(false);
    expect(tokenMatches('bearer s3cret', 's3cret')).toBe(false);
    expect(tokenMatches('s3cret', 's3cret')).toBe(false);
    expect(tokenMatches(undefined, 's3cret')).toBe(false);
    expect(tokenMatches('Bearer ', '')).toBe(false);
    expect(tokenMatches(undefined, '')).toBe(false);
  });
});

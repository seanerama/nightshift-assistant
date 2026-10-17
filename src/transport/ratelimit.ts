/**
 * Minimal in-memory token bucket (Stage 39, contracts/hook-ingress.md) — the
 * first rate limiter in the daemon, hand-rolled on purpose (no dependency).
 * Single-user daemon, single credential: one bucket per guarded door, not per
 * client. State is process memory only — a restart refills every bucket,
 * which is acceptable because the relay queue it protects restarts empty too.
 */

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface TokenBucket {
  /** Consume one token if available; otherwise say how long until one is. */
  take(): TakeResult;
}

export interface TokenBucketOptions {
  /** Steady-state refill rate. */
  ratePerMin: number;
  /** Bucket capacity — how many requests may arrive back-to-back. */
  burst: number;
  /** Clock seam (ms since epoch) — tests only. */
  now?: () => number;
}

export function createTokenBucket(opts: TokenBucketOptions): TokenBucket {
  const now = opts.now ?? ((): number => Date.now());
  const capacity = Math.max(1, opts.burst);
  const perMs = opts.ratePerMin / 60_000;
  // Starts full: the first burst after boot is always admitted.
  let tokens = capacity;
  let last = now();

  return {
    take(): TakeResult {
      const t = now();
      // Refill for the elapsed time, capped at capacity; a clock that went
      // backwards refills nothing (never a negative elapsed).
      tokens = Math.min(capacity, tokens + Math.max(0, t - last) * perMs);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      // Whole seconds until one full token exists (Retry-After is integral).
      const retryAfterSec = Math.max(1, Math.ceil((1 - tokens) / perMs / 1000));
      return { ok: false, retryAfterSec };
    },
  };
}

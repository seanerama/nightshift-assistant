/** Daily-rotation boundary logic — pure functions, injected clocks only. */

import { describe, expect, it } from 'vitest';
import { isPastDailyBoundary, lastBoundary } from '../src/session/boundary.js';

/** Local-time Date builder (the boundary is local, like NIGHTSHIFT_ROTATE_HOUR). */
const local = (y: number, mo: number, d: number, h: number, mi = 0): Date =>
  new Date(y, mo - 1, d, h, mi);

describe('lastBoundary', () => {
  it('is today at the rotate hour once the hour has passed', () => {
    expect(lastBoundary(local(2026, 7, 6, 5), 4).getTime()).toBe(local(2026, 7, 6, 4).getTime());
  });

  it('is yesterday at the rotate hour before the hour', () => {
    expect(lastBoundary(local(2026, 7, 6, 3), 4).getTime()).toBe(local(2026, 7, 5, 4).getTime());
  });

  it('is exactly now at the boundary instant', () => {
    expect(lastBoundary(local(2026, 7, 6, 4), 4).getTime()).toBe(local(2026, 7, 6, 4).getTime());
  });
});

describe('isPastDailyBoundary', () => {
  it('a session started yesterday rotates once today passes the hour', () => {
    expect(isPastDailyBoundary(local(2026, 7, 6, 4, 1), 4, local(2026, 7, 5, 22))).toBe(true);
  });

  it('a session started today after the boundary does not rotate', () => {
    expect(isPastDailyBoundary(local(2026, 7, 6, 12), 4, local(2026, 7, 6, 4, 30))).toBe(false);
  });

  it('a missed boundary (daemon down at the hour) still rotates at the next check', () => {
    // 02:00 now; session started two days ago — yesterday's 04:00 was missed.
    expect(isPastDailyBoundary(local(2026, 7, 6, 2), 4, local(2026, 7, 4, 12))).toBe(true);
  });

  it('does not rotate before the first boundary after the session started', () => {
    // Started 22:00 yesterday; it is 03:00 — today's 04:00 has not arrived yet.
    expect(isPastDailyBoundary(local(2026, 7, 6, 3), 4, local(2026, 7, 5, 22))).toBe(false);
  });
});

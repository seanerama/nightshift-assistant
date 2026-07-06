/**
 * Daily-rotation boundary logic — pure functions over an injected clock, so
 * tests never need real time. The boundary is "NIGHTSHIFT_ROTATE_HOUR local";
 * a session rotates when it started before the MOST RECENT boundary. That one
 * rule also covers missed boundaries (daemon down at the hour): the next check
 * still sees started < boundary and rotates.
 */

/** The most recent local rotation boundary at or before `now`. */
export function lastBoundary(now: Date, rotateHour: number): Date {
  const boundary = new Date(now);
  boundary.setHours(rotateHour, 0, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}

/** True when the session predates the most recent daily boundary (rotation due). */
export function isPastDailyBoundary(
  now: Date,
  rotateHour: number,
  sessionStartedAt: Date,
): boolean {
  return sessionStartedAt.getTime() < lastBoundary(now, rotateHour).getTime();
}

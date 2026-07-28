/**
 * app_outbox (ADR 0010, migration 0007): the single-counter delivery log for
 * the app transport. append() commits the row BEFORE notifying any live
 * listener — a crash (or a broken SSE socket) between commit and emit loses
 * nothing, because both the SSE Last-Event-ID resume and GET /outbox?after=
 * re-read from SQLite by the same `id` cursor. One counter, no exceptions:
 * `id` is simultaneously the SSE `id:` field and the `?after=` cursor
 * (harness `cursor.equivalence`). The ack row doubles as the DURABLE inbound
 * dedup record: acceptance of a client messageId is exactly "an ack row for
 * it exists", so a daemon restart cannot turn a client retry into a duplicate
 * conversation turn.
 */

import type Database from 'better-sqlite3';
import type { Logger } from '../../log.js';

/** The v1.0.0 event types this daemon emits. The WIRE set is open (additive) — never an enum on the wire. */
export type AppEventType = 'ack' | 'reply' | 'notice';

/** Mirror of the pinned schemas/v1/event-envelope.json — the one shape both routes serve. */
export interface AppEvent {
  schema: 1;
  /** Monotonic — BOTH the SSE Last-Event-ID and the ?after= cursor. */
  id: number;
  type: string;
  /** ISO 8601 emit time; display only — ordering is `id`, never this field. */
  at: string;
  payload: Record<string, unknown>;
}

export interface AppOutbox {
  /** Durably append one event; live listeners are notified AFTER the row is committed. */
  append(type: AppEventType, payload: Record<string, unknown>): AppEvent;
  /** Events strictly after the cursor, ascending id — the shared replay read. */
  after(afterId: number): AppEvent[];
  /** Register a live listener; returns unsubscribe. A listener failure never loses the row. */
  onAppend(listener: (event: AppEvent) => void): () => void;
  /** True when an ack row for this client messageId exists (durable dedup, invariant 5). */
  hasAck(messageId: string): boolean;
}

interface OutboxRow {
  id: number;
  type: string;
  payload: string;
  created_at: string;
}

export function createAppOutbox(db: Database.Database, log: Logger): AppOutbox {
  const listeners = new Set<(event: AppEvent) => void>();
  const insert = db.prepare('INSERT INTO app_outbox (type, payload, created_at) VALUES (?, ?, ?)');
  const select = db.prepare(
    'SELECT id, type, payload, created_at FROM app_outbox WHERE id > ? ORDER BY id ASC',
  );
  const ackExists = db.prepare(
    "SELECT 1 FROM app_outbox WHERE type = 'ack' AND json_extract(payload, '$.messageId') = ? LIMIT 1",
  );

  return {
    append(type: AppEventType, payload: Record<string, unknown>): AppEvent {
      const at = new Date().toISOString();
      const info = insert.run(type, JSON.stringify(payload), at);
      const event: AppEvent = { schema: 1, id: Number(info.lastInsertRowid), type, at, payload };
      // The row is committed from here on. A failing live emit must neither
      // lose it nor block the others — the client recovers it by cursor.
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          log.error('app outbox live emit failed (row is durable; client resumes by cursor)', {
            id: event.id,
            type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return event;
    },
    after(afterId: number): AppEvent[] {
      const rows = select.all(afterId) as OutboxRow[];
      return rows.map((row) => ({
        schema: 1,
        id: row.id,
        type: row.type,
        at: row.created_at,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }));
    },
    onAppend(listener: (event: AppEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasAck(messageId: string): boolean {
      return ackExists.get(messageId) !== undefined;
    },
  };
}

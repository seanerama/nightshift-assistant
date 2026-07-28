/**
 * Stage 24 proactive-send fan-out (ADR 0010): the Webex leg is byte-identical
 * — golden assertions on the exact arguments the wrapped sender receives —
 * and the app leg is one durable `notice` outbox row per proactive send.
 * Dark (outbox null) → the fan-out IS the Webex sender (passthrough by
 * identity, so flag-off behavior cannot drift by construction).
 */

import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { createNotifyFanout } from '../src/transport/app/fanout.js';
import { type AppOutbox, createAppOutbox } from '../src/transport/app/outbox.js';
import type { Sender } from '../src/transport/send.js';
import type { MessageDestination } from '../src/transport/webex.js';
import { MIGRATIONS_DIR, makeTestLogger } from './helpers.js';

type RecordedCall = [MessageDestination, string, string[] | undefined];

function recordingSender(failWith?: Error): { sender: Sender; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sender: {
      async send(dest, markdown, files): Promise<void> {
        calls.push([dest, markdown, files]);
        if (failWith !== undefined) throw failWith;
      },
    },
  };
}

function makeOutbox(): { outbox: AppOutbox; close(): void } {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS_DIR);
  return { outbox: createAppOutbox(db, makeTestLogger()), close: () => db.close() };
}

const DEST = { roomId: 'room-1' };

describe('notify fan-out', () => {
  it('dark (outbox null) → passthrough: the fan-out IS the wrapped sender', () => {
    const { sender } = recordingSender();
    expect(createNotifyFanout(sender, null, makeTestLogger())).toBe(sender);
  });

  it('flag on → Webex receives BYTE-IDENTICAL calls (golden) plus one notice row each', async () => {
    const { sender, calls } = recordingSender();
    const { outbox, close } = makeOutbox();
    try {
      const fanout = createNotifyFanout(sender, outbox, makeTestLogger());
      await fanout.send(DEST, '🌙 job finished', ['/home/x/projects/out.pdf']);
      await fanout.send(DEST, 'rotation notice');
      // Golden: exact args, exact order — chunking/fallback/attachments all
      // live inside the wrapped sender, nothing re-implemented.
      expect(calls).toEqual([
        [DEST, '🌙 job finished', ['/home/x/projects/out.pdf']],
        [DEST, 'rotation notice', undefined],
      ]);
      const rows = outbox.after(0);
      expect(rows.map((r) => r.type)).toEqual(['notice', 'notice']);
      // Local attachment paths never leak to the wire — files is servable
      // ids only, and none exist until the files capability lands.
      expect(rows[0]?.payload).toEqual({ schema: 1, text: '🌙 job finished', files: [] });
      expect(rows[1]?.payload).toEqual({ schema: 1, text: 'rotation notice', files: [] });
    } finally {
      close();
    }
  });

  it('a Webex failure still propagates AND the notice row is already durable', async () => {
    const boom = new Error('webex is down');
    const { sender, calls } = recordingSender(boom);
    const { outbox, close } = makeOutbox();
    try {
      const fanout = createNotifyFanout(sender, outbox, makeTestLogger());
      await expect(fanout.send(DEST, 'important notice')).rejects.toThrow('webex is down');
      expect(calls).toHaveLength(1);
      // The app client still gets the notice — that is the point of a second door.
      expect(outbox.after(0).map((r) => r.type)).toEqual(['notice']);
    } finally {
      close();
    }
  });

  it('an outbox failure never costs the Webex leg', async () => {
    const { sender, calls } = recordingSender();
    const log = makeTestLogger();
    const brokenOutbox = {
      append(): never {
        throw new Error('disk full');
      },
      after: () => [],
      onAppend: () => () => undefined,
      hasAck: () => false,
    } satisfies AppOutbox;
    const fanout = createNotifyFanout(sender, brokenOutbox, log);
    await fanout.send(DEST, 'still delivered to webex');
    expect(calls).toEqual([[DEST, 'still delivered to webex', undefined]]);
    expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('outbox write'))).toBe(
      true,
    );
  });
});

/**
 * Proactive-send fan-out (Stages 24+26, ADR 0010): the Webex leg is
 * byte-identical — golden assertions on the exact arguments the wrapped
 * sender receives — and the app leg is one durable `notice` outbox row per
 * proactive send, with confined attachment paths issued servable file ids
 * (unconfined paths dropped). Dark (sink null) → the fan-out IS the Webex
 * sender (passthrough by identity, so flag-off behavior cannot drift by
 * construction).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { type AppSink, createNotifyFanout } from '../src/transport/app/fanout.js';
import { createAppFiles } from '../src/transport/app/files.js';
import { type AppOutbox, createAppOutbox } from '../src/transport/app/outbox.js';
import type { Sender } from '../src/transport/send.js';
import type { MessageDestination } from '../src/transport/webex.js';
import { MIGRATIONS_DIR, makeTestLogger, type TestLogger } from './helpers.js';

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

const DEST = { roomId: 'room-1' };

describe('notify fan-out', () => {
  let dir: string;
  let confinedDir: string;
  let sink: AppSink;
  let log: TestLogger;
  let closeDb: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nightshift-fanout-'));
    confinedDir = join(dir, 'jobs');
    mkdirSync(confinedDir, { recursive: true });
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    log = makeTestLogger();
    sink = {
      outbox: createAppOutbox(db, log),
      files: createAppFiles(db, log, { uploadsDir: join(dir, 'uploads'), roots: [confinedDir] }),
    };
    closeDb = () => db.close();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dark (sink null) → passthrough: the fan-out IS the wrapped sender', () => {
    const { sender } = recordingSender();
    expect(createNotifyFanout(sender, null, makeTestLogger())).toBe(sender);
  });

  it('flag on → Webex receives BYTE-IDENTICAL calls (golden) plus one notice row each', async () => {
    const confinedFile = join(confinedDir, 'out.pdf');
    writeFileSync(confinedFile, 'job output');
    const { sender, calls } = recordingSender();
    const fanout = createNotifyFanout(sender, sink, log);
    await fanout.send(DEST, '🌙 job finished', [confinedFile]);
    await fanout.send(DEST, 'rotation notice');
    // Golden: exact args, exact order — chunking/fallback/attachments all
    // live inside the wrapped sender, nothing re-implemented.
    expect(calls).toEqual([
      [DEST, '🌙 job finished', [confinedFile]],
      [DEST, 'rotation notice', undefined],
    ]);
    const rows = sink.outbox.after(0);
    expect(rows.map((r) => r.type)).toEqual(['notice', 'notice']);
    // The confined attachment rode the notice as a SERVABLE id (Stage 26)…
    const noticeFiles = rows[0]?.payload.files as string[];
    expect(noticeFiles).toHaveLength(1);
    expect(sink.files.resolve(noticeFiles[0] as string)).toBe(confinedFile);
    expect(rows[0]?.payload).toMatchObject({ schema: 1, text: '🌙 job finished' });
    // …and a file-less notice carries none.
    expect(rows[1]?.payload).toEqual({ schema: 1, text: 'rotation notice', files: [] });
  });

  it('an unconfined attachment path is dropped from the notice, never served', async () => {
    const outside = join(dir, 'outside-roots.txt'); // dir itself is NOT a root
    writeFileSync(outside, 'secret');
    const { sender, calls } = recordingSender();
    const fanout = createNotifyFanout(sender, sink, log);
    await fanout.send(DEST, 'notice with stray file', [outside]);
    // Webex leg untouched — it still gets the real path…
    expect(calls).toEqual([[DEST, 'notice with stray file', [outside]]]);
    // …but the app wire carries NO id for it, and a log line records the drop.
    expect(sink.outbox.after(0)[0]?.payload.files).toEqual([]);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg.includes('confined roots'))).toBe(
      true,
    );
  });

  it('a Webex failure still propagates AND the notice row is already durable', async () => {
    const boom = new Error('webex is down');
    const { sender, calls } = recordingSender(boom);
    const fanout = createNotifyFanout(sender, sink, log);
    await expect(fanout.send(DEST, 'important notice')).rejects.toThrow('webex is down');
    expect(calls).toHaveLength(1);
    // The app client still gets the notice — that is the point of a second door.
    expect(sink.outbox.after(0).map((r) => r.type)).toEqual(['notice']);
  });

  it('an outbox failure never costs the Webex leg', async () => {
    const { sender, calls } = recordingSender();
    const brokenSink: AppSink = {
      outbox: {
        append(): never {
          throw new Error('disk full');
        },
        after: () => [],
        onAppend: () => () => undefined,
        hasAck: () => false,
      } satisfies AppOutbox,
      files: sink.files,
    };
    const fanout = createNotifyFanout(sender, brokenSink, log);
    await fanout.send(DEST, 'still delivered to webex');
    expect(calls).toEqual([[DEST, 'still delivered to webex', undefined]]);
    expect(log.entries.some((e) => e.level === 'error' && e.msg.includes('outbox write'))).toBe(
      true,
    );
  });
});

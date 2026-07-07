/**
 * send() attachments (Stage 10, the webex-ingress contract's reserved
 * "accepts optional file attachments"): one file per Webex message — the first
 * chunk carries the first file (multipart), extra files ride their own
 * follow-up messages; files over NIGHTSHIFT_ATTACH_MAX_MB reject with a clear
 * AttachmentError BEFORE anything is sent; the never-silent failure fallback
 * survives; and a file-less send stays exactly the pre-Stage-10 JSON path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentError, createSender, type Sender } from '../src/transport/send.js';
import { createWebexClient } from '../src/transport/webex.js';
import {
  makeConfig,
  makeTestLogger,
  startWebexStub,
  type TestLogger,
  type WebexStub,
} from './helpers.js';

describe('send() with attachments', () => {
  let stub: WebexStub;
  let log: TestLogger;
  let dir: string;
  let sender: Sender;

  const makeSender = (overrides: Parameters<typeof makeConfig>[0] = {}): Sender => {
    const config = makeConfig({ webexApiBase: stub.baseUrl, ...overrides });
    return createSender(createWebexClient(config), log, config);
  };

  beforeEach(async () => {
    stub = await startWebexStub();
    log = makeTestLogger();
    dir = mkdtempSync(join(tmpdir(), 'nightshift-send-'));
    sender = makeSender();
  });

  afterEach(async () => {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a file-less send stays on the JSON path (no multipart, no fileName)', async () => {
    await sender.send({ roomId: 'room-1' }, 'plain **markdown**');
    expect(stub.sends).toHaveLength(1);
    expect(stub.sends[0]).toEqual({ roomId: 'room-1', markdown: 'plain **markdown**' });
    expect(stub.sends[0]).not.toHaveProperty('fileName');
  });

  it('multi-file send: first message carries markdown + first file, extras ride follow-ups', async () => {
    writeFileSync(join(dir, 'one.txt'), 'first file');
    writeFileSync(join(dir, 'two.png'), Buffer.alloc(64, 1));
    writeFileSync(join(dir, 'three.pdf'), Buffer.alloc(32, 2));
    await sender.send({ roomId: 'room-1' }, '✅ done', [
      join(dir, 'one.txt'),
      join(dir, 'two.png'),
      join(dir, 'three.pdf'),
    ]);

    expect(stub.sends).toHaveLength(3); // one file per Webex message
    expect(stub.sends[0]?.roomId).toBe('room-1');
    expect(stub.sends[0]?.markdown).toBe('✅ done');
    expect(stub.sends[0]?.fileName).toBe('one.txt');
    expect(stub.sends[0]?.fileBytes).toBe(10);
    expect(stub.sends[1]).toMatchObject({ roomId: 'room-1', fileName: 'two.png', fileBytes: 64 });
    expect(stub.sends[1]?.markdown).toBeUndefined();
    expect(stub.sends[2]).toMatchObject({ roomId: 'room-1', fileName: 'three.pdf' });
  });

  it('a file-only send (empty markdown) still delivers one message with the file', async () => {
    writeFileSync(join(dir, 'solo.txt'), 'solo');
    await sender.send({ roomId: 'room-1' }, '', [join(dir, 'solo.txt')]);
    expect(stub.sends).toHaveLength(1);
    expect(stub.sends[0]?.fileName).toBe('solo.txt');
  });

  it('long markdown still chunks; ONLY the first chunk carries the file', async () => {
    writeFileSync(join(dir, 'one.txt'), 'x');
    const long = 'A'.repeat(9000); // over the ~7439-byte Webex cap → 2 chunks
    await sender.send({ roomId: 'room-1' }, long, [join(dir, 'one.txt')]);
    expect(stub.sends).toHaveLength(2);
    expect(stub.sends[0]?.fileName).toBe('one.txt');
    expect(stub.sends[1]).not.toHaveProperty('fileName');
  });

  it('over-cap file → clear AttachmentError naming the knob, NOTHING sent', async () => {
    const small = makeSender({ attachMaxMb: 1 });
    writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(join(dir, 'ok.txt'), 'fine');
    await expect(
      small.send({ roomId: 'room-1' }, 'notice', [join(dir, 'ok.txt'), join(dir, 'huge.bin')]),
    ).rejects.toThrowError(AttachmentError);
    await expect(
      small.send({ roomId: 'room-1' }, 'notice', [join(dir, 'huge.bin')]),
    ).rejects.toThrow(/NIGHTSHIFT_ATTACH_MAX_MB/);
    expect(stub.sends).toHaveLength(0); // rejected before any message went out
  });

  it('NIGHTSHIFT_ATTACH_MAX_MB=0 disables attachments (any non-empty file rejects)', async () => {
    const disabled = makeSender({ attachMaxMb: 0 });
    writeFileSync(join(dir, 'tiny.txt'), 'x');
    await expect(
      disabled.send({ roomId: 'room-1' }, 'notice', [join(dir, 'tiny.txt')]),
    ).rejects.toThrowError(AttachmentError);
    expect(stub.sends).toHaveLength(0);
  });

  it('a missing file rejects with a clear error, nothing sent', async () => {
    await expect(
      sender.send({ roomId: 'room-1' }, 'notice', [join(dir, 'never-made.txt')]),
    ).rejects.toThrow(/not a readable regular file/);
    expect(stub.sends).toHaveLength(0);
  });

  it('send failure mid-set keeps the never-silent fallback and surfaces the error', async () => {
    writeFileSync(join(dir, 'one.txt'), 'x');
    stub.failNext(1); // the first (multipart) message 500s
    await expect(
      sender.send({ roomId: 'room-1' }, 'notice', [join(dir, 'one.txt')]),
    ).rejects.toThrow(/HTTP 500/);
    // The fallback message went out and was logged — never silent.
    expect(stub.sends).toHaveLength(1);
    expect(String(stub.sends[0]?.markdown)).toContain('Reply delivery failed');
    expect(log.entries.some((e) => e.msg === 'send failed; delivering fallback')).toBe(true);
  });
});

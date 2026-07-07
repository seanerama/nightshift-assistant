/**
 * Stage 8 — deferred human ack: when relay() outlives NIGHTSHIFT_ACK_AFTER_SEC,
 * exactly ONE receipt is sent before the real reply; fast turns, threshold 0,
 * and dedup'd duplicates never ack; an ack send failure is logged and never
 * suppresses the real reply. The fixture Webex server records send order.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import { ACK_TEXT } from '../src/transport/server.js';
import {
  makeConfig,
  makeTestLogger,
  sign,
  startWebexStub,
  type TestLogger,
  type WebexStub,
  waitFor,
  webhookBody,
} from './helpers.js';

const SECRET = 'test-webhook-secret';
const ACK_AFTER_SEC = 1; // small threshold so slow-turn tests stay fast
const SLOW_MS = 1800; // agent-stub delay comfortably past the threshold

describe('deferred ack for slow turns', () => {
  let stub: WebexStub;
  let app: App;
  let log: TestLogger;
  let baseUrl: string;
  let tmpDir: string;

  const startApp = async (ackAfterSec: number): Promise<void> => {
    log = makeTestLogger();
    app = createApp(
      makeConfig({ webexApiBase: stub.baseUrl, dbPath: join(tmpDir, 'test.db'), ackAfterSec }),
      log,
    );
    const port = await app.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  };

  const postWebhook = async (messageId: string): Promise<Response> => {
    const body = webhookBody(messageId);
    return fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Spark-Signature': sign(body, SECRET),
      },
      body,
    });
  };

  const addOwnerMessage = (id: string, text: string): void => {
    stub.addMessage({ id, roomId: 'room-1', personId: 'owner-person-id', text });
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-ack-test-'));
    delete process.env.AGENT_STUB_DELAY_MS;
    stub = await startWebexStub();
  });

  afterEach(async () => {
    delete process.env.AGENT_STUB_DELAY_MS;
    await app.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends exactly one ack before the real reply on a slow turn', async () => {
    process.env.AGENT_STUB_DELAY_MS = String(SLOW_MS);
    await startApp(ACK_AFTER_SEC);
    addOwnerMessage('msg-ack-slow', 'take your time');

    await postWebhook('msg-ack-slow');
    await waitFor(() => stub.sends.length >= 2);

    // Order: ack first, real reply second; texts distinct; exactly one ack.
    expect(stub.sends).toHaveLength(2);
    expect(String(stub.sends[0]?.markdown)).toBe(ACK_TEXT);
    expect(String(stub.sends[1]?.markdown)).toBe('pong: take your time');
    expect(stub.sends[0]?.roomId).toBe('room-1');
    expect(stub.sends.filter((s) => String(s.markdown) === ACK_TEXT)).toHaveLength(1);
  });

  it('sends no ack when the reply beats the threshold (fast turn)', async () => {
    await startApp(ACK_AFTER_SEC);
    addOwnerMessage('msg-ack-fast', 'quick one');

    await postWebhook('msg-ack-fast');
    await waitFor(() => stub.sends.length >= 1);

    // Let the (cancelled) timer's deadline pass, then assert nothing else came.
    await new Promise((r) => setTimeout(r, ACK_AFTER_SEC * 1000 + 300));
    expect(stub.sends).toHaveLength(1);
    expect(String(stub.sends[0]?.markdown)).toBe('pong: quick one');
  });

  it('sends no ack when NIGHTSHIFT_ACK_AFTER_SEC=0, even on a slow turn', async () => {
    process.env.AGENT_STUB_DELAY_MS = String(SLOW_MS);
    await startApp(0);
    addOwnerMessage('msg-ack-off', 'slow but silent');

    await postWebhook('msg-ack-off');
    await waitFor(() => stub.sends.length >= 1);

    expect(stub.sends).toHaveLength(1);
    expect(String(stub.sends[0]?.markdown)).toBe('pong: slow but silent');
    expect(log.entries.some((e) => e.msg.includes('sending receipt ack'))).toBe(false);
  });

  it('logs an ack send failure and still delivers the real reply', async () => {
    process.env.AGENT_STUB_DELAY_MS = String(SLOW_MS);
    await startApp(ACK_AFTER_SEC);
    addOwnerMessage('msg-ack-fail', 'ack will 500');

    stub.failNext(1); // the first send (the ack) 500s; everything after succeeds
    await postWebhook('msg-ack-fail');
    await waitFor(() => stub.sends.some((s) => String(s.markdown) === 'pong: ack will 500'));

    // The failure is logged, never fatal, and the real reply is delivered.
    await waitFor(() => log.entries.some((e) => e.msg.includes('ack send failed')));
    expect(stub.sends.filter((s) => String(s.markdown) === ACK_TEXT)).toHaveLength(0);
    expect(String(stub.sends.at(-1)?.markdown)).toBe('pong: ack will 500');
  });

  it('sends no ack for a duplicate messageId (nothing processed)', async () => {
    await startApp(ACK_AFTER_SEC);
    addOwnerMessage('msg-ack-dup', 'once only');

    await postWebhook('msg-ack-dup');
    await waitFor(() => stub.sends.length >= 1);

    const dup = await postWebhook('msg-ack-dup');
    expect(dup.status).toBe(200); // duplicates still ack 200 at the HTTP layer

    // Past the ack deadline for the duplicate: no ack, no second reply.
    await new Promise((r) => setTimeout(r, ACK_AFTER_SEC * 1000 + 300));
    expect(stub.sends).toHaveLength(1);
    expect(stub.sends.filter((s) => String(s.markdown) === ACK_TEXT)).toHaveLength(0);
  });
});

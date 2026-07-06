/**
 * Round-trip: valid webhook → relay → stub NIGHTSHIFT_AGENT_BIN (canned
 * headless JSON) → reply captured through the send() path (the fixture Webex
 * server records the send). Duplicate messageId → no second execution.
 * Session id persists and later turns resume it. Agent death → error reply.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
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

interface StubInvocation {
  args: string[];
  input: string;
}

describe('webhook → relay → agent stub → send() round-trip', () => {
  let stub: WebexStub;
  let app: App;
  let log: TestLogger;
  let baseUrl: string;
  let tmpDir: string;
  let invocationLog: string;

  const invocations = (): StubInvocation[] => {
    try {
      return readFileSync(invocationLog, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as StubInvocation);
    } catch {
      return [];
    }
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

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-test-'));
    invocationLog = join(tmpDir, 'agent-invocations.jsonl');
    process.env.AGENT_STUB_LOG = invocationLog;
    delete process.env.AGENT_STUB_MODE;

    stub = await startWebexStub();
    log = makeTestLogger();
    app = createApp(
      makeConfig({ webexApiBase: stub.baseUrl, dbPath: join(tmpDir, 'test.db') }),
      log,
    );
    const port = await app.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete process.env.AGENT_STUB_LOG;
    delete process.env.AGENT_STUB_MODE;
    await app.close();
    await stub.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('relays an owner message through the agent and back out via send()', async () => {
    stub.addMessage({
      id: 'msg-rt-1',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'ping',
    });

    const res = await postWebhook('msg-rt-1');
    expect(res.status).toBe(200);

    await waitFor(() => stub.sends.length >= 1);
    expect(stub.sends[0]?.roomId).toBe('room-1');
    expect(String(stub.sends[0]?.markdown)).toBe('pong: ping');

    // The session id from the agent's JSON output is persisted as current.
    const row = app.db.prepare('SELECT session_id FROM sessions WHERE is_current = 1').get() as {
      session_id: string;
    };
    expect(row.session_id).toBe('sess-canned-1');
  });

  it('resumes the persisted session on the next turn', async () => {
    stub.addMessage({
      id: 'msg-rt-2',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'first',
    });
    stub.addMessage({
      id: 'msg-rt-3',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'second',
    });

    await postWebhook('msg-rt-2');
    await waitFor(() => stub.sends.length >= 1);
    await postWebhook('msg-rt-3');
    await waitFor(() => stub.sends.length >= 2);

    const calls = invocations();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).not.toContain('--resume');
    const resumeIdx = calls[1]?.args.indexOf('--resume') ?? -1;
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(calls[1]?.args[resumeIdx + 1]).toBe('sess-canned-1');
  });

  it('does not re-execute a duplicate messageId', async () => {
    stub.addMessage({
      id: 'msg-dup',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'once only',
    });

    const first = await postWebhook('msg-dup');
    expect(first.status).toBe(200);
    await waitFor(() => stub.sends.length >= 1);

    const dup = await postWebhook('msg-dup');
    expect(dup.status).toBe(200); // duplicates still ack 200

    // Give any (incorrect) re-execution time to surface, then assert exactly one.
    await new Promise((r) => setTimeout(r, 300));
    expect(invocations()).toHaveLength(1);
    expect(stub.sends).toHaveLength(1);
    expect(log.entries.some((e) => e.msg.includes('duplicate messageId'))).toBe(true);
  });

  it('replies with an error (never silence) when the agent dies mid-turn', async () => {
    process.env.AGENT_STUB_MODE = 'die';
    stub.addMessage({
      id: 'msg-die',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'crash please',
    });

    await postWebhook('msg-die');
    await waitFor(() => stub.sends.length >= 1);
    expect(String(stub.sends[0]?.markdown)).toContain('error');
  });
});

/**
 * webex-ingress verification chain: forged/missing signature → 401; secret
 * unset → ALL rejected (fail closed); valid + non-owner fetched sender →
 * 200-drop; valid + owner → processed. Webex API stubbed at the
 * WEBEX_API_BASE seam with a local fixture server.
 */

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

describe('webhook signature chain', () => {
  let stub: WebexStub;
  let app: App;
  let log: TestLogger;
  let baseUrl: string;

  const startApp = async (overrides: Parameters<typeof makeConfig>[0] = {}): Promise<void> => {
    log = makeTestLogger();
    app = createApp(makeConfig({ webexApiBase: stub.baseUrl, ...overrides }), log);
    const port = await app.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  };

  const postWebhook = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  beforeEach(async () => {
    stub = await startWebexStub();
  });

  afterEach(async () => {
    await app.close();
    await stub.close();
  });

  it('rejects a forged signature with 401', async () => {
    await startApp();
    const body = webhookBody('msg-forged');
    const res = await postWebhook(body, { 'X-Spark-Signature': sign(body, 'wrong-secret') });
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature header with 401', async () => {
    await startApp();
    const res = await postWebhook(webhookBody('msg-noheader'));
    expect(res.status).toBe(401);
  });

  it('rejects ALL requests when the secret is unset (fail closed)', async () => {
    await startApp({ webexWebhookSecret: '' });
    const body = webhookBody('msg-nosecret');
    // Even a request signed with an empty secret must be rejected.
    const signed = await postWebhook(body, { 'X-Spark-Signature': sign(body, '') });
    expect(signed.status).toBe(401);
    const unsigned = await postWebhook(body);
    expect(unsigned.status).toBe(401);
  });

  it('acks 200 and drops when the FETCHED sender is not the owner', async () => {
    await startApp();
    stub.addMessage({
      id: 'msg-stranger',
      roomId: 'room-1',
      personId: 'stranger-person-id', // fetched sender ≠ owner
      text: 'let me in',
    });
    // Webhook body claims the owner sent it — authorization must use the FETCHED sender.
    const body = webhookBody('msg-stranger', { personId: 'owner-person-id' });
    const res = await postWebhook(body, { 'X-Spark-Signature': sign(body, SECRET) });
    expect(res.status).toBe(200);

    await waitFor(() => log.entries.some((e) => e.msg.includes('not the owner')));
    expect(stub.sends).toHaveLength(0);
  });

  it('processes a valid signature from the owner end-to-end', async () => {
    await startApp();
    stub.addMessage({
      id: 'msg-owner',
      roomId: 'room-1',
      personId: 'owner-person-id',
      text: 'hello',
    });
    const body = webhookBody('msg-owner');
    const res = await postWebhook(body, { 'X-Spark-Signature': sign(body, SECRET) });
    expect(res.status).toBe(200);

    await waitFor(() => stub.sends.length >= 1);
    expect(String(stub.sends[0]?.markdown)).toContain('pong: hello');
  });

  it('serves GET /health with ok, version and uptimeSec', async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as { ok: boolean; version: string; uptimeSec: number };
    expect(health.ok).toBe(true);
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

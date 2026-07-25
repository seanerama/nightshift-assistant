/**
 * Control API (contracts/control-api.md): every endpoint happy-path against a
 * real app instance with the worker stub, plus the gates — kill-switch (flag
 * off → 403 for the whole surface), bearer auth (missing/wrong/short token →
 * 401; empty configured token fails closed), unknown job → 404, invalid
 * submit → 400 with the JobError message. No live claude anywhere.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { InboundMessage } from '../src/types.js';
import { makeConfig, makeTestLogger, WORKER_STUB, waitFor } from './helpers.js';

const TOKEN = 'test-api-token';

const inbound = (text: string): InboundMessage => ({
  schema: 1,
  messageId: `msg-${Math.random().toString(36).slice(2)}`,
  personId: 'owner-person-id',
  text,
  attachments: [],
  receivedAt: new Date().toISOString(),
});

describe('control API (/api/v1)', () => {
  let tmpDir: string;
  let workdir: string;
  let app: App | null;
  let baseUrl: string;

  const makeApp = async (overrides: Partial<Config> = {}): Promise<App> => {
    const a = createApp(
      makeConfig({
        agentBin: WORKER_STUB,
        controlEnabled: true,
        apiToken: TOKEN,
        jobsEnabled: true,
        jobKillGraceSec: 1,
        ...overrides,
      }),
      makeTestLogger(),
      { appDir: tmpDir, home: tmpDir },
    );
    const port = await a.listen();
    baseUrl = `http://127.0.0.1:${port}`;
    app = a;
    return a;
  };

  const call = (
    method: string,
    path: string,
    opts: { token?: string | null; body?: unknown } = {},
  ): Promise<Response> => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  };

  const submitBody = (instruction: string): Record<string, unknown> => ({
    schema: 1,
    type: 'test',
    title: 'api job',
    instruction,
    workdir,
    env: 'minimal',
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nightshift-api-'));
    workdir = join(tmpDir, 'work');
    mkdirSync(workdir);
    app = null;
  });

  afterEach(async () => {
    if (app !== null) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('kill-switch (NIGHTSHIFT_CONTROL_ENABLED off)', () => {
    it('the ENTIRE surface returns 403 with a clear error, even with a valid token', async () => {
      await makeApp({ controlEnabled: false });
      for (const [method, path] of [
        ['GET', '/api/v1/status'],
        ['GET', '/api/v1/jobs'],
        ['POST', '/api/v1/jobs'],
        ['GET', '/api/v1/jobs/some-id'],
        ['POST', '/api/v1/jobs/some-id/kill'],
        ['POST', '/api/v1/session/rotate'],
        ['POST', '/api/v1/deliver'],
        ['POST', '/api/v1/promote'],
        ['POST', '/api/v1/remarkable'],
      ] as const) {
        const res = await call(method, path);
        expect(res.status, `${method} ${path}`).toBe(403);
        const json = (await res.json()) as { ok: boolean; error: string };
        expect(json.ok).toBe(false);
        expect(json.error).toContain('NIGHTSHIFT_CONTROL_ENABLED');
      }
    });

    it('does not disturb the existing surface: /health still answers', async () => {
      await makeApp({ controlEnabled: false });
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });

  describe('bearer auth', () => {
    it('401 with no Authorization header', async () => {
      await makeApp();
      const res = await call('GET', '/api/v1/status', { token: null });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    });

    it('401 with a wrong token (same and different length — the hashed compare is length-safe)', async () => {
      await makeApp();
      expect((await call('GET', '/api/v1/status', { token: 'test-api-tokeX' })).status).toBe(401);
      expect((await call('GET', '/api/v1/status', { token: 'x' })).status).toBe(401);
      expect(
        (await call('GET', '/api/v1/status', { token: `${TOKEN}-and-then-some` })).status,
      ).toBe(401);
    });

    it('fails closed when the configured token is empty: 401 for everyone', async () => {
      await makeApp({ apiToken: '' });
      expect((await call('GET', '/api/v1/status', { token: '' })).status).toBe(401);
      expect((await call('GET', '/api/v1/status', { token: null })).status).toBe(401);
      expect((await call('GET', '/api/v1/status', { token: TOKEN })).status).toBe(401);
    });
  });

  describe('jobs endpoints', () => {
    it('POST /api/v1/jobs submits; GET by id tracks it to succeeded', async () => {
      const a = await makeApp();
      const res = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      expect(res.status).toBe(200);
      const { ok, job } = (await res.json()) as {
        ok: boolean;
        job: { id: string; status: string };
      };
      expect(ok).toBe(true);
      expect(job.status).toBe('running');

      await waitFor(() => a.jobs.get(job.id)?.status === 'succeeded');
      const got = await call('GET', `/api/v1/jobs/${job.id}`);
      expect(got.status).toBe(200);
      const gotJson = (await got.json()) as { ok: boolean; job: { status: string } };
      expect(gotJson.job.status).toBe('succeeded');
    });

    it('invalid submit → 400 carrying the JobError message', async () => {
      await makeApp();
      const bad = { ...submitBody('MODE=success'), env: 'full' };
      const res = await call('POST', '/api/v1/jobs', { body: bad });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('env must be exactly');
    });

    it('submit with the job runner disabled → 400 with the JobError message', async () => {
      await makeApp({ jobsEnabled: false });
      const res = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('job runner is disabled');
    });

    it('non-JSON submit body → 400', async () => {
      await makeApp();
      const res = await fetch(`${baseUrl}/api/v1/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('GET /api/v1/jobs lists all and filters by ?status=', async () => {
      const a = await makeApp();
      const res1 = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      const id = ((await res1.json()) as { job: { id: string } }).job.id;
      await waitFor(() => a.jobs.get(id)?.status === 'succeeded');

      const all = (await (await call('GET', '/api/v1/jobs')).json()) as {
        ok: boolean;
        jobs: Array<{ id: string }>;
      };
      expect(all.ok).toBe(true);
      expect(all.jobs.map((j) => j.id)).toContain(id);

      const succeeded = (await (await call('GET', '/api/v1/jobs?status=succeeded')).json()) as {
        jobs: Array<{ id: string }>;
      };
      expect(succeeded.jobs.map((j) => j.id)).toContain(id);
      const failed = (await (await call('GET', '/api/v1/jobs?status=failed')).json()) as {
        jobs: unknown[];
      };
      expect(failed.jobs).toHaveLength(0);
    });

    it('invalid ?status= filter → 400', async () => {
      await makeApp();
      const res = await call('GET', '/api/v1/jobs?status=exploded');
      expect(res.status).toBe(400);
    });

    it('unknown job id → 404 on GET and on kill', async () => {
      await makeApp();
      expect((await call('GET', '/api/v1/jobs/no-such-id')).status).toBe(404);
      expect((await call('POST', '/api/v1/jobs/no-such-id/kill')).status).toBe(404);
    });

    it('POST /api/v1/jobs/<id>/kill kills a running job', async () => {
      await makeApp();
      const res = await call('POST', '/api/v1/jobs', {
        body: submitBody('MODE=sleep SLEEP_MS=60000'),
      });
      const id = ((await res.json()) as { job: { id: string } }).job.id;

      const killed = await call('POST', `/api/v1/jobs/${id}/kill`);
      expect(killed.status).toBe(200);
      const json = (await killed.json()) as { ok: boolean; job: { status: string } };
      expect(json.ok).toBe(true);
      expect(json.job.status).toBe('killed');
    });
  });

  describe('typed submits (Stage 6, the contract-reserved { type, params } body)', () => {
    it('POST { type, params } renders the job through the registry', async () => {
      const a = await makeApp({ typesEnabled: true });
      const res = await call('POST', '/api/v1/jobs', {
        body: { type: 'story', params: { idea: 'MODE=success bedtime turtles' } },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        ok: boolean;
        job: { id: string; type: string; title: string; workdir: string };
      };
      expect(json.ok).toBe(true);
      expect(json.job.type).toBe('story');
      expect(json.job.title).toBe('Story: MODE=success bedtime turtles');
      expect(json.job.workdir).toBe(join(tmpDir, 'projects', 'mode-success-bedtime-turtles'));
      await waitFor(() => a.jobs.get(json.job.id)?.status === 'succeeded');
    });

    it('unknown type → 400 listing the known types', async () => {
      await makeApp({ typesEnabled: true });
      const res = await call('POST', '/api/v1/jobs', { body: { type: 'research', params: {} } });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toContain('unknown job type: research');
      expect(json.error).toContain('known types:');
      expect(json.error).toContain('story');
    });

    it('types kill-switch OFF → non-generic 400 with a clear error; raw submit unaffected', async () => {
      await makeApp(); // typesEnabled stays false
      const typed = await call('POST', '/api/v1/jobs', {
        body: { type: 'story', params: { idea: 'bedtime' } },
      });
      expect(typed.status).toBe(400);
      expect(((await typed.json()) as { error: string }).error).toContain(
        'NIGHTSHIFT_TYPES_ENABLED',
      );

      const raw = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      expect(raw.status).toBe(200);
    });

    it('bad params → 400 naming the missing field; missing type string → 400', async () => {
      await makeApp({ typesEnabled: true });
      const missing = await call('POST', '/api/v1/jobs', { body: { type: 'story', params: {} } });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toContain('"idea"');

      const untyped = await call('POST', '/api/v1/jobs', { body: { params: { idea: 'x' } } });
      expect(untyped.status).toBe(400);
      expect(((await untyped.json()) as { error: string }).error).toContain(
        'typed submit requires "type"',
      );
    });

    it('the raw submit shape keeps working with the registry ENABLED', async () => {
      const a = await makeApp({ typesEnabled: true });
      const res = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; job: { id: string; workdir: string } };
      expect(json.job.workdir).toBe(workdir); // caller-provided, not registry-derived
      await waitFor(() => a.jobs.get(json.job.id)?.status === 'succeeded');
    });
  });

  describe('session + status endpoints', () => {
    it('POST /api/v1/session/rotate rotates and returns the RotationRecord', async () => {
      const a = await makeApp();
      await a.sessions.relay(inbound('hello')); // materialize a session to rotate
      const before = a.sessions.info().id;

      const res = await call('POST', '/api/v1/session/rotate', { body: { reason: 'manual' } });
      expect(res.status).toBe(200);
      const { ok, rotation } = (await res.json()) as {
        ok: boolean;
        rotation: { closedSessionId: string; newSessionId: string; reason: string };
      };
      expect(ok).toBe(true);
      expect(rotation.reason).toBe('manual');
      expect(rotation.closedSessionId).toBe(before);
      expect(rotation.newSessionId).not.toBe(before);
    });

    it('rotate accepts an empty body and rejects a non-manual reason with 400', async () => {
      const a = await makeApp();
      await a.sessions.relay(inbound('hello'));
      const bad = await call('POST', '/api/v1/session/rotate', { body: { reason: 'daily' } });
      expect(bad.status).toBe(400);
      const empty = await call('POST', '/api/v1/session/rotate');
      expect(empty.status).toBe(200);
    });

    it('GET /api/v1/status returns the contract shape with real counts', async () => {
      const a = await makeApp();
      await a.sessions.relay(inbound('hello'));
      const res1 = await call('POST', '/api/v1/jobs', { body: submitBody('MODE=success') });
      const id = ((await res1.json()) as { job: { id: string } }).job.id;
      await waitFor(() => a.jobs.get(id)?.status === 'succeeded');

      const res = await call('GET', '/api/v1/status');
      expect(res.status).toBe(200);
      const status = (await res.json()) as {
        ok: boolean;
        version: string;
        uptimeSec: number;
        session: { id: string | null; turns: number };
        jobs: Record<string, number>;
        rotation: { enabled: boolean };
        jobsEnabled: boolean;
      };
      expect(status.ok).toBe(true);
      expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(status.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(status.session.id).toBe('sess-canned-1');
      expect(status.session.turns).toBe(1);
      expect(status.jobs).toEqual({ queued: 0, running: 0, succeeded: 1, failed: 0, killed: 0 });
      expect(status.rotation.enabled).toBe(false);
      expect(status.jobsEnabled).toBe(true);
    });

    it('unknown /api/v1 route → 404', async () => {
      await makeApp();
      const res = await call('GET', '/api/v1/nope');
      expect(res.status).toBe(404);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    });
  });
});

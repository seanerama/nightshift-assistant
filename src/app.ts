/**
 * Wire the modules into one app: db + migrations, session manager, transport.
 * Tests construct this directly with a test Config (stub seams: WEBEX_API_BASE
 * for the Webex cloud, NIGHTSHIFT_AGENT_BIN for the claude binary).
 */

import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { migrate, openDatabase } from './db/migrate.js';
import { createJobRunner, type JobRunner } from './jobs/runner.js';
import type { Logger } from './log.js';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerHooks,
} from './session/manager.js';
import { createApiHandler } from './transport/api.js';
import { createSender } from './transport/send.js';
import { createTransportServer } from './transport/server.js';
import { createWebexClient } from './transport/webex.js';

/** How often the in-daemon daily-rotation check runs (only when enabled). */
const DAILY_CHECK_INTERVAL_MS = 60_000;

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export interface App {
  server: Server;
  db: Database.Database;
  /** Session manager — operator/assistant-exposed via POST /api/v1/session/rotate (Stage 5). */
  sessions: SessionManager;
  /** Job runner (Stage 4) — operator/assistant-exposed via /api/v1/jobs* (Stage 5). */
  jobs: JobRunner;
  /** Listen on 127.0.0.1 ONLY (ADR 0001: loopback bind; tunnel exposes /webhook). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** Test-only seams: the session-manager hooks plus the typed-job workdir root. */
export type AppHooks = Omit<SessionManagerHooks, 'notify'> & {
  /** Root for typed jobs' ~/projects/<slug> workdirs (default: os.homedir()). */
  home?: string;
};

export function createApp(
  config: Config,
  log: Logger,
  // Session-manager seams (clock, appDir, projectsRoot) — tests only; the
  // daemon always uses the defaults. notify is wired here, not injectable.
  sessionHooks: AppHooks = {},
): App {
  const db = openDatabase(config.dbPath);
  migrate(db, MIGRATIONS_DIR, log);

  const webex = createWebexClient(config);
  const sender = createSender(webex, log);

  // The owner's most recent roomId, for proactive notices (rotation). Tracked
  // in-memory for this stage: a daemon restart forgets it until the next
  // inbound message, and rotation then skips the notice (logged, not an error).
  let lastOwnerRoomId: string | null = null;

  const sessions = createSessionManager(db, log, config, {
    ...sessionHooks,
    notify: async (text: string): Promise<void> => {
      if (lastOwnerRoomId === null) {
        log.info('rotation notice skipped: no owner room seen yet');
        return;
      }
      await sender.send({ roomId: lastOwnerRoomId }, text);
    },
  });

  // Job runner (Stage 4). Finish notices reuse the same owner-room tracking as
  // rotation's notify; with no room seen yet the notice is logged and skipped.
  const jobs = createJobRunner(db, log, config, {
    ...(sessionHooks.appDir === undefined ? {} : { appDir: sessionHooks.appDir }),
    ...(sessionHooks.home === undefined ? {} : { home: sessionHooks.home }),
  });
  jobs.onFinish(async (job, notice): Promise<void> => {
    if (lastOwnerRoomId === null) {
      log.info('job finish notice skipped: no owner room seen yet', { jobId: job.id });
      return;
    }
    await sender.send({ roomId: lastOwnerRoomId }, notice);
  });

  const server = createTransportServer({
    config,
    log,
    webex,
    sender,
    relay: (msg) => sessions.relay(msg),
    onOwnerRoom: (roomId) => {
      lastOwnerRoomId = roomId;
    },
    version: appVersion(),
    // Control API (Stage 5): mounted on the same loopback server; the handler
    // owns its own kill-switch (403 dark by default) and bearer auth.
    api: createApiHandler({ config, log, jobs, sessions, version: appVersion() }),
  });

  // Daily-rotation trigger: minimal in-daemon interval check (no external
  // scheduler yet). Dark unless NIGHTSHIFT_ROTATION_ENABLED=true.
  let dailyTimer: NodeJS.Timeout | null = null;
  if (config.rotationEnabled) {
    dailyTimer = setInterval(() => {
      sessions.maybeRotateDaily().catch((err: unknown) => {
        log.error('daily rotation check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, DAILY_CHECK_INTERVAL_MS);
    dailyTimer.unref();
  }

  // Job reconciler: startup pass (re-adopt persisted running/queued rows from a
  // previous daemon life) + the same 60s cadence. Dark unless
  // NIGHTSHIFT_JOBS_ENABLED=true — no interval, no reconcile, submit() rejects.
  let jobsTimer: NodeJS.Timeout | null = null;
  if (config.jobsEnabled) {
    try {
      jobs.reconcile();
    } catch (err) {
      log.error('startup job reconcile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    jobsTimer = setInterval(() => {
      try {
        jobs.reconcile();
      } catch (err) {
        log.error('job reconcile tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, DAILY_CHECK_INTERVAL_MS);
    jobsTimer.unref();
  }

  return {
    server,
    db,
    sessions,
    jobs,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : config.port;
          log.info('listening', { host: '127.0.0.1', port });
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      // Intervals only — running workers are NOT killed on daemon shutdown;
      // the reconciler re-adopts them on restart via their persisted pids.
      if (dailyTimer !== null) clearInterval(dailyTimer);
      if (jobsTimer !== null) clearInterval(jobsTimer);
      return new Promise((resolve, reject) => {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

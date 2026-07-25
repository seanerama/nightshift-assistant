/**
 * Wire the modules into one app: db + migrations, session manager, transport.
 * Tests construct this directly with a test Config (stub seams: WEBEX_API_BASE
 * for the Webex cloud, NIGHTSHIFT_AGENT_BIN for the claude binary).
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { migrate, openDatabase } from './db/migrate.js';
import { createJobRunner, type JobRunner } from './jobs/runner.js';
import type { Logger } from './log.js';
import { selectAutoAttach } from './notices.js';
import { createPromoter, type PromoterHooks } from './promotion/pipeline.js';
import { createPromotionRouter } from './promotion/route.js';
import { createSitePromoter, type SitePromoterHooks } from './promotion/site.js';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerHooks,
} from './session/manager.js';
import { createApiHandler } from './transport/api.js';
import { createDeliverer } from './transport/deliver.js';
import { createRemarkablePusher } from './transport/remarkable.js';
import { AttachmentError, createSender } from './transport/send.js';
import { createTransportServer } from './transport/server.js';
import { createWebexClient } from './transport/webex.js';

/** How often the in-daemon daily-rotation check runs (only when enabled). */
const DAILY_CHECK_INTERVAL_MS = 60_000;

/** Wall-clock bound on a single `rmapi put` upload (Stage 19). */
const RMAPI_TIMEOUT_MS = 120_000;

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
  /** Stage 11 promotion seams (git/gh PATH shim env, retry bounds) — tests only. */
  promote?: PromoterHooks;
  /** Stage 13 site-promotion seams (spawn env, health/build bounds) — tests only. */
  site?: SitePromoterHooks;
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

  const appDir = sessionHooks.appDir ?? process.cwd();
  const home = sessionHooks.home ?? homedir();

  const webex = createWebexClient(config);
  const sender = createSender(webex, log, config);

  // The owner's most recent roomId, for proactive notices (rotation, job
  // finishes) and /api/v1/deliver. Persisted in the settings table (migration
  // 0005) so a daemon restart keeps routing notices; the in-memory copy is the
  // hot read, refreshed on every authorized inbound message.
  const OWNER_ROOM_KEY = 'owner_room_id';
  let lastOwnerRoomId: string | null =
    (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(OWNER_ROOM_KEY) as
        | { value: string }
        | undefined
    )?.value ?? null;
  const persistOwnerRoom = (roomId: string): void => {
    lastOwnerRoomId = roomId;
    try {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(OWNER_ROOM_KEY, roomId, new Date().toISOString());
    } catch (err) {
      // The in-memory value still routes this life's notices — log, don't fail.
      log.error('owner room persist failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

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
  jobs.onFinish(async (job, notice, outputs): Promise<void> => {
    if (lastOwnerRoomId === null) {
      log.info('job finish notice skipped: no owner room seen yet', { jobId: job.id });
      return;
    }
    const dest = { roomId: lastOwnerRoomId };
    // Auto-attach (Stage 10): small success outputs ride the notice. Dark
    // unless the control surface is enabled (same switch as on-request
    // delivery); NIGHTSHIFT_AUTOATTACH_MAX_MB=0 disables it independently.
    const files = config.controlEnabled
      ? selectAutoAttach(outputs, job.workdir, config.autoAttachMaxMb)
      : [];
    try {
      await sender.send(dest, notice, files);
    } catch (err) {
      // An attachment that grew/vanished after selection must never cost the
      // notice itself — retry without files (send failures still propagate).
      if (files.length === 0 || !(err instanceof AttachmentError)) throw err;
      log.warn('auto-attach failed; delivering the notice without attachments', {
        jobId: job.id,
        error: err.message,
      });
      await sender.send(dest, notice);
    }
  });

  // Promotion modules (Stages 11 + 13, ADR 0008): daemon-resident
  // deterministic pipelines; the 🚀 completion/failure notices reuse the same
  // owner-room tracking as rotation and job finishes. Constructed
  // unconditionally — the API endpoint owns the NIGHTSHIFT_PROMOTE_ENABLED
  // kill-switch. The ROUTER is the promote face: study content → the website
  // pipeline (contracts/site-promotion.md), story content → explicit
  // rejection; the subdomain pipeline is retained for future app promotion
  // but is unreachable for study/story content.
  const promoteNotify = async (text: string): Promise<void> => {
    if (lastOwnerRoomId === null) {
      log.info('promotion notice skipped: no owner room seen yet');
      return;
    }
    await sender.send({ roomId: lastOwnerRoomId }, text);
  };
  const promoterDeps = { db, log, config, notify: promoteNotify };
  const subdomainPromoter = createPromoter(promoterDeps, {
    home,
    ...(sessionHooks.promote ?? {}),
  });
  const sitePromoter = createSitePromoter(promoterDeps, { home, ...(sessionHooks.site ?? {}) });
  const promoter = createPromotionRouter({
    site: sitePromoter,
    subdomain: subdomainPromoter,
    home,
  });

  // The allow-listed root set both path-confined capabilities share (Stage 10
  // deliver + Stage 19 reMarkable push): ~/projects and the app's jobs/ + logs/.
  const confinedRoots = [join(home, 'projects'), join(appDir, 'jobs'), join(appDir, 'logs')];

  const server = createTransportServer({
    config,
    log,
    webex,
    sender,
    relay: (msg) => sessions.relay(msg),
    onOwnerRoom: persistOwnerRoom,
    version: appVersion(),
    // Control API (Stage 5): mounted on the same loopback server; the handler
    // owns its own kill-switch (403 dark by default) and bearer auth. The
    // Stage 10 deliverer confines paths to ~/projects + the app's jobs/ and
    // logs/ dirs and routes to the owner's persisted room; the Stage 19
    // reMarkable pusher confines to the SAME roots and shells rmapi.
    api: createApiHandler({
      config,
      log,
      jobs,
      sessions,
      deliver: createDeliverer({
        sender,
        roots: confinedRoots,
        ownerRoom: () => lastOwnerRoomId,
        log,
      }),
      promote: promoter,
      // reMarkable PUSH (Stage 19): the route owns the
      // NIGHTSHIFT_REMARKABLE_ENABLED kill-switch (403 dark by default); the
      // pusher confines the path and shells `rmapi put`. Constructed
      // unconditionally, like the promoter. The exec is the real seam here —
      // tests inject their own `run` (unit) or point RMAPI_BIN at a stub (api).
      remarkable: createRemarkablePusher({
        enabled: config.remarkableEnabled,
        folder: config.remarkableFolder,
        rmapiBin: config.rmapiBin,
        allowedRoots: confinedRoots,
        run: (argv) =>
          new Promise((resolve) => {
            const [cmd, ...args] = argv;
            execFile(
              cmd ?? config.rmapiBin,
              args,
              { timeout: RMAPI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
              (err, stdout, stderr) => {
                if (err === null) {
                  resolve({ code: 0, stdout, stderr });
                  return;
                }
                const code = typeof err.code === 'number' ? err.code : 1;
                resolve({ code, stdout, stderr: stderr === '' ? err.message : stderr });
              },
            );
          }),
        log,
      }),
      version: appVersion(),
    }),
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

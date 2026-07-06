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
import type { Logger } from './log.js';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerHooks,
} from './session/manager.js';
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
  /** Exposed for later stages (manual rotation) — not operator-exposed yet. */
  sessions: SessionManager;
  /** Listen on 127.0.0.1 ONLY (ADR 0001: loopback bind; tunnel exposes /webhook). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createApp(
  config: Config,
  log: Logger,
  // Session-manager seams (clock, appDir, projectsRoot) — tests only; the
  // daemon always uses the defaults. notify is wired here, not injectable.
  sessionHooks: Omit<SessionManagerHooks, 'notify'> = {},
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

  return {
    server,
    db,
    sessions,
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
      if (dailyTimer !== null) clearInterval(dailyTimer);
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

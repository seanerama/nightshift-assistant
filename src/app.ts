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
import { createSessionManager } from './session/manager.js';
import { createSender } from './transport/send.js';
import { createTransportServer } from './transport/server.js';
import { createWebexClient } from './transport/webex.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

export interface App {
  server: Server;
  db: Database.Database;
  /** Listen on 127.0.0.1 ONLY (ADR 0001: loopback bind; tunnel exposes /webhook). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createApp(config: Config, log: Logger): App {
  const db = openDatabase(config.dbPath);
  migrate(db, MIGRATIONS_DIR, log);

  const webex = createWebexClient(config);
  const sender = createSender(webex, log);
  const sessions = createSessionManager(db, log, config);
  const server = createTransportServer({
    config,
    log,
    webex,
    sender,
    relay: (msg) => sessions.relay(msg),
    version: appVersion(),
  });

  return {
    server,
    db,
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

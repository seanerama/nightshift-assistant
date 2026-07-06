/** Daemon entrypoint: load config (fail fast), start the app, structured logs. */

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './log.js';

const log = createLogger({ app: 'nightshift-assistant' });

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('startup refused', { reason: err.message });
      process.exit(1);
    }
    throw err;
  }

  const app = createApp(config, log);
  await app.listen();

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error('shutdown error', {
          error: err instanceof Error ? err.message : String(err),
        });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  log.error('fatal', { error: err instanceof Error ? (err.stack ?? String(err)) : String(err) });
  process.exit(1);
});

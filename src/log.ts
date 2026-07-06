/** Structured JSON logs to stdout — journald picks them up (ADR 0003). */

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
}

export function createLogger(base?: Record<string, unknown>): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
  };
}

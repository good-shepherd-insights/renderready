/**
 * Minimal pluggable logging.
 *
 * The package never reaches for a logging library: it defines the smallest
 * interface it needs and ships a console implementation. Bring your own pino /
 * winston / bunyan by passing anything structurally compatible as `logger`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

function formatMeta(meta: LogMeta | undefined): string {
  if (!meta) {
    return '';
  }
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return '';
  }
  return (
    ' ' +
    entries
      .map(([key, value]) => {
        if (value instanceof Error) {
          return `${key}=${JSON.stringify(value.message)}`;
        }
        if (typeof value === 'string') {
          return `${key}=${JSON.stringify(value)}`;
        }
        try {
          return `${key}=${JSON.stringify(value)}`;
        } catch {
          return `${key}="[unserializable]"`;
        }
      })
      .join(' ')
  );
}

/**
 * Line-oriented console logger. `warn` and `error` go to stderr so that piping
 * stdout somewhere doesn't swallow problems.
 */
export function createConsoleLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_RANK[level];

  const emit = (logLevel: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta): void => {
    if (LEVEL_RANK[logLevel] < threshold) {
      return;
    }
    const line = `${new Date().toISOString()} ${logLevel.toUpperCase().padEnd(5)} renderready ${message}${formatMeta(meta)}`;
    if (logLevel === 'warn' || logLevel === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}

/** Discards everything. The default in tests. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

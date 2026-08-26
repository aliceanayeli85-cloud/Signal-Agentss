import { env } from './env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[env.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(context ?? {}),
  };
  const serialised = JSON.stringify(line, replacer);
  if (level === 'error' || level === 'warn') process.stderr.write(serialised + '\n');
  else process.stdout.write(serialised + '\n');
}

/** Errors do not serialise to JSON by default; keep the message and stack. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
};

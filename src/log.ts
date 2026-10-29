import { redactor } from './redact.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let current: LogLevel = 'warn';
let sink: (line: string) => void = (line) => {
  process.stderr.write(line + '\n');
};

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

function emit(level: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, string | number | boolean | undefined>): void {
  if (ORDER[level] > ORDER[current]) {
    return;
  }
  const extra = fields
    ? ' ' +
      Object.entries(fields)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ')
    : '';
  sink(redactor.redact(`[hb-hub-mcp] ${level} ${message}${extra}`));
}

/** Logs carry metadata only (method, path template, status, timing, request id). Never bodies or tokens. */
export const log = {
  error: (m: string, f?: Record<string, string | number | boolean | undefined>) => emit('error', m, f),
  warn: (m: string, f?: Record<string, string | number | boolean | undefined>) => emit('warn', m, f),
  info: (m: string, f?: Record<string, string | number | boolean | undefined>) => emit('info', m, f),
  debug: (m: string, f?: Record<string, string | number | boolean | undefined>) => emit('debug', m, f),
};

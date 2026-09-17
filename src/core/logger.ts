/**
 * Structured logging.
 *
 * THE ONE RULE THAT BREAKS MCP SERVERS OVER STDIO:
 * stdout is the JSON-RPC channel. A single `console.log` corrupts the frame
 * and the host disconnects with a parse error. Every log line therefore goes
 * to stderr - `console.error` - never `console.log`.
 *
 * In HTTP mode stderr is still the right sink: stdout stays free for the
 * framework, and container runtimes capture both streams anyway.
 */

import type { LogLevel } from '../config.js';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = '[redacted]';

/** Keys whose values must never reach a log sink, at any nesting depth. */
const SECRET_KEY_PATTERN = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }
  return { errorMessage: String(error) };
}

class StderrLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly bindings: LogContext,
  ) {}

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (SEVERITY[level] < SEVERITY[this.level]) return;

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...redact(this.bindings) as Record<string, unknown>,
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    });

    // stderr, always. See the file header.
    process.stderr.write(`${line}\n`);
  }

  debug(message: string, context?: LogContext): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  child(bindings: LogContext): Logger {
    return new StderrLogger(this.level, { ...this.bindings, ...bindings });
  }
}

export function createLogger(level: LogLevel, bindings: LogContext = {}): Logger {
  return new StderrLogger(level, bindings);
}

export { serialiseError };

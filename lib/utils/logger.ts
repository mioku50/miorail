import { redactSecretsV1 } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly context: Record<string, unknown> = {},
    private readonly format: 'json' | 'text' = process.env.NODE_ENV === 'development'
      ? 'text'
      : 'json',
  ) {}

  child(context: Record<string, unknown>): Logger {
    return new Logger({ ...this.context, ...context }, this.format);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...meta,
    };

    // Every line is redacted as written (audit OPS-2, 2026-11-14): an error's text quoted in `meta` named an
    // RPC URL with its key, and the journal kept it for weeks.
    if (this.format === 'json') {
      console[level](redactSecretsV1(JSON.stringify(entry)));
    } else {
      const metaStr = Object.keys(entry)
        .filter((k) => !['level', 'message', 'timestamp'].includes(k))
        .map((k) => `${k}=${JSON.stringify(entry[k])}`)
        .join(' ');

      const formattedMessage =
        `[${entry.timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`.trim();
      console[level](redactSecretsV1(formattedMessage));
    }
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>) {
    this.log('error', message, meta);
  }
}

export const logger = new Logger();

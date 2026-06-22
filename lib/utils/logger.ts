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
    private readonly format: 'json' | 'text' = process.env.NODE_ENV === 'development' ? 'text' : 'json'
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

    if (this.format === 'json') {
      console[level](JSON.stringify(entry));
    } else {
      const metaStr = Object.keys(entry)
        .filter((k) => !['level', 'message', 'timestamp'].includes(k))
        .map((k) => `${k}=${JSON.stringify(entry[k])}`)
        .join(' ');

      const formattedMessage = `[${entry.timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`.trim();
      console[level](formattedMessage);
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

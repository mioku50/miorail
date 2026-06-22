"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
class Logger {
    context;
    format;
    constructor(context = {}, format = process.env.NODE_ENV === 'development' ? 'text' : 'json') {
        this.context = context;
        this.format = format;
    }
    child(context) {
        return new Logger({ ...this.context, ...context }, this.format);
    }
    log(level, message, meta) {
        const entry = {
            level,
            message,
            timestamp: new Date().toISOString(),
            ...this.context,
            ...meta,
        };
        if (this.format === 'json') {
            console[level](JSON.stringify(entry));
        }
        else {
            const metaStr = Object.keys(entry)
                .filter((k) => !['level', 'message', 'timestamp'].includes(k))
                .map((k) => `${k}=${JSON.stringify(entry[k])}`)
                .join(' ');
            const formattedMessage = `[${entry.timestamp}] ${level.toUpperCase()}: ${message} ${metaStr}`.trim();
            console[level](formattedMessage);
        }
    }
    debug(message, meta) {
        this.log('debug', message, meta);
    }
    info(message, meta) {
        this.log('info', message, meta);
    }
    warn(message, meta) {
        this.log('warn', message, meta);
    }
    error(message, meta) {
        this.log('error', message, meta);
    }
}
exports.Logger = Logger;
exports.logger = new Logger();

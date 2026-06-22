"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryRateLimiter = void 0;
class InMemoryRateLimiter {
    defaultOptions;
    store = new Map();
    constructor(defaultOptions) {
        this.defaultOptions = defaultOptions;
    }
    async consume(key, cost = 1, options) {
        const opts = { ...this.defaultOptions, ...options };
        const now = Date.now();
        let record = this.store.get(key);
        if (!record || now > record.resetTime) {
            record = {
                count: 0,
                resetTime: now + opts.windowMs,
            };
        }
        const success = record.count + cost <= opts.max;
        if (success) {
            record.count += cost;
        }
        this.store.set(key, record);
        return {
            success,
            limit: opts.max,
            remaining: Math.max(0, opts.max - record.count),
            resetTime: record.resetTime,
        };
    }
    // Cleanup old entries to prevent memory leaks in long-running processes
    cleanup() {
        const now = Date.now();
        for (const [key, record] of this.store.entries()) {
            if (now > record.resetTime) {
                this.store.delete(key);
            }
        }
    }
}
exports.InMemoryRateLimiter = InMemoryRateLimiter;

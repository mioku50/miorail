export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
}

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export class InMemoryRateLimiter {
  private store = new Map<string, RateLimitRecord>();

  constructor(private readonly defaultOptions: RateLimitOptions) {}

  async consume(
    key: string,
    cost: number = 1,
    options?: Partial<RateLimitOptions>,
  ): Promise<RateLimitResult> {
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

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Storage ceiling for this limiter instance, not a per-request setting. */
  maxKeys?: number;
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

const DEFAULT_MAX_KEYS = 50_000;
const SWEEP_EVERY = 1_000;

export class InMemoryRateLimiter {
  private store = new Map<string, RateLimitRecord>();
  private callsSinceSweep = 0;
  private readonly maxKeys: number;

  constructor(private readonly defaultOptions: RateLimitOptions) {
    this.maxKeys = defaultOptions.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isSafeInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new RangeError('maxKeys must be a positive safe integer');
    }
  }

  async consume(
    key: string,
    cost: number = 1,
    options?: Partial<Pick<RateLimitOptions, 'windowMs' | 'max'>>,
  ): Promise<RateLimitResult> {
    const opts = { ...this.defaultOptions, ...options };
    const now = Date.now();
    if (++this.callsSinceSweep >= SWEEP_EVERY) {
      this.callsSinceSweep = 0;
      this.cleanup(now);
    }

    let record = this.store.get(key);

    if (!record || now >= record.resetTime) {
      record = {
        count: 0,
        resetTime: now + opts.windowMs,
      };
    }

    const success = record.count + cost <= opts.max;

    if (success) {
      record.count += cost;
    }

    // Map insertion order is last access order, including blocked attempts.
    // Overflow evicts one cold key without scanning every live key on each
    // new URL. Eviction forgets a counter; it never creates a new refusal.
    this.store.delete(key);
    if (this.store.size >= this.maxKeys) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, record);

    return {
      success,
      limit: opts.max,
      remaining: Math.max(0, opts.max - record.count),
      resetTime: record.resetTime,
    };
  }

  get size(): number {
    return this.store.size;
  }

  // Periodic cleanup bounds expired entries without a timer per limiter.
  cleanup(now = Date.now()) {
    for (const [key, record] of this.store.entries()) {
      if (now >= record.resetTime) {
        this.store.delete(key);
      }
    }
  }
}

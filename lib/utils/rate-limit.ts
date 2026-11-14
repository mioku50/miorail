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

// ---------------------------------------------------------------------------
// One counter per network, not per address (audit AUTH-3, 2026-11-14).
//
// Every limiter keyed by the client's address took the address whole. An IPv6
// client is routinely handed a whole /64, so it could send each request from a
// new address: no limit applied to it at all (200 requests against a limit of
// 20 a minute, 0 refused), and each new key pushed another client's counter out
// of the 50,000-key store. IPv6 is counted by its /64 prefix now; IPv4, and
// IPv4 carried in IPv6 (::ffff:a.b.c.d), by its own address.
// ---------------------------------------------------------------------------

/** The eight groups of an IPv6 address, or null when the text is not one. */
function ipv6GroupsV1(text: string): number[] | null {
  let head = text;
  const tail: number[] = [];
  // An IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return null;
    tail.push((parts[0]! << 8) | parts[1]!, (parts[2]! << 8) | parts[3]!);
    head = text.slice(0, v4.index);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groupsOf(halves[0]!), right = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const written = left.length + right.length + tail.length;
  if (halves.length === 1 ? written !== 8 : written > 7) return null;
  const zeros = Array.from({ length: 8 - written }, () => 0);
  return [...left.map((group) => parseInt(group, 16)), ...zeros, ...right.map((group) => parseInt(group, 16)), ...tail];
}

/** The key a limiter counts a client address under: an IPv4 address as it is, an IPv6 address by its /64. */
export function rateLimitAddressKeyV1(address: string): string {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text === '') return 'unknown';
  if (!text.includes(':')) return text;
  const groups = ipv6GroupsV1(text);
  if (!groups) return text;
  // IPv4-mapped (::ffff:0:0/96): the IPv4 address is the client.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

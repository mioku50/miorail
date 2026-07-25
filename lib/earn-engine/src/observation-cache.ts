import { BASE_MAINNET_CHAIN_ID_V1 } from './live-types.js';
import type { EarnDataSourceObserveInput, EarnDataSourceV1, EarnObservationResultV1 } from './types.js';

// ---------------------------------------------------------------------------
// T63A §5 — short-lived server-side observation cache.
//
// Four properties this must hold, in order of importance:
//  1. A cached observation is returned VERBATIM — its `observedAt` / `expiresAt`
//     are never re-stamped. A cache hit therefore cannot make an old reading
//     look fresh; the freshness verdict is always computed from the instant the
//     PROVIDER observed the data.
//  2. Concurrent observes for the same key share one in-flight request, so a
//     burst of users produces a single upstream call.
//  3. Failures are cached only briefly (`errorTtlMs`), enough to stop hammering
//     a broken provider, never long enough to keep a recovered one dark.
//  4. On failure, a previously good observation may still be SHOWN within
//     `staleServeMs`. It keeps its original timestamps, so downstream it is
//     stale: displayed, and excluded from every ranked dimension.
//
// The key is provider + pinned contract + chain, and deliberately NOT the
// deposit amount: these observations describe a venue, not a request, so every
// caller shares one entry.
// ---------------------------------------------------------------------------

export interface EarnObservationCacheOptionsV1 {
  /** How long a successful observation may be re-served. Default 30s. */
  ttlMs?: number;
  /** How long a typed failure is remembered. Default 5s. */
  errorTtlMs?: number;
  /** How long a last-known-good observation may be served after the provider
   * starts failing. Default 15 min; 0 disables last-known-good entirely. */
  staleServeMs?: number;
  /** Injectable clock (tests never sleep). Default `Date.now`. */
  now?: () => number;
}

export const DEFAULT_EARN_CACHE_TTL_MS = 30_000;
export const DEFAULT_EARN_CACHE_ERROR_TTL_MS = 5_000;
export const DEFAULT_EARN_CACHE_STALE_SERVE_MS = 15 * 60_000;

interface CacheEntryV1 {
  /** Last successful observation and when it entered the cache. */
  success: { at: number; result: Extract<EarnObservationResultV1, { ok: true }> } | null;
  /** Last typed failure and when it entered the cache. */
  failure: { at: number; result: Extract<EarnObservationResultV1, { ok: false }> } | null;
}

export function earnObservationCacheKeyV1(sourceId: string, input: EarnDataSourceObserveInput): string {
  return `${sourceId}|${BASE_MAINNET_CHAIN_ID_V1}|${input.protocol}|${input.venue.target}`;
}

/**
 * Wraps a data source with the cache + single-flight coalescing described
 * above. Pure composition: it never inspects or rewrites an observation's
 * contents, so it cannot turn stale data into fresh data.
 */
export function createCachedEarnDataSourceV1(
  inner: EarnDataSourceV1,
  options: EarnObservationCacheOptionsV1 = {},
): EarnDataSourceV1 {
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_EARN_CACHE_TTL_MS);
  const errorTtlMs = Math.max(0, options.errorTtlMs ?? DEFAULT_EARN_CACHE_ERROR_TTL_MS);
  const staleServeMs = Math.max(0, options.staleServeMs ?? DEFAULT_EARN_CACHE_STALE_SERVE_MS);
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, CacheEntryV1>();
  const inflight = new Map<string, Promise<EarnObservationResultV1>>();

  return {
    id: inner.id,
    async observe(input: EarnDataSourceObserveInput): Promise<EarnObservationResultV1> {
      const key = earnObservationCacheKeyV1(inner.id, input);
      const entry = entries.get(key);
      const at = now();

      if (entry?.success && at - entry.success.at < ttlMs) return entry.success.result;
      if (entry?.failure && at - entry.failure.at < errorTtlMs) return entry.failure.result;

      const pending = inflight.get(key);
      if (pending) return pending;

      const request = (async (): Promise<EarnObservationResultV1> => {
        const result = await inner.observe(input);
        const completedAt = now();
        const current = entries.get(key) ?? { success: null, failure: null };
        if (result.ok) {
          entries.set(key, { success: { at: completedAt, result }, failure: null });
          return result;
        }
        entries.set(key, { success: current.success, failure: { at: completedAt, result } });
        // Last-known-good rescue: shown with its ORIGINAL observation time, so
        // it reads as stale everywhere downstream.
        const lastGood = current.success;
        if (lastGood && staleServeMs > 0 && completedAt - lastGood.at < staleServeMs) return lastGood.result;
        return result;
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, request);
      return request;
    },
  };
}

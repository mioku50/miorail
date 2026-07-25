import { PartnerHostNotAllowlistedError } from '@mioagent/security/httpAllowlist';
import { stableHashV1, type HashV1 } from '@mioagent/route-domain';
import type { EarnLiveFailureReasonV1 } from './live-types.js';

// ---------------------------------------------------------------------------
// T63A — pure normalization shared by the Moonwell and Morpho live sources.
// Two rules are absolute here:
//   1. APY is INTEGER BASIS POINTS or null. A provider float is rounded once,
//      at the edge; nothing downstream ever sees a fraction or a percent.
//   2. A datum that is absent, unparseable, or out of range becomes `null`
//      (→ "No data — no score") or a typed failure. It is NEVER defaulted to 0,
//      inferred from a USD figure, or carried over from another field.
// ---------------------------------------------------------------------------

/** Contract ceiling for `ApyBpsV1Schema` (10_000%). Anything beyond it is
 * garbage upstream data, not a yield opportunity. */
export const MAX_APY_BPS_V1 = 1_000_000;

export type EarnLiveParseResultV1<T> = { ok: true; value: T } | { ok: false; reason: EarnLiveFailureReasonV1 };

export function liveFailureV1(reason: EarnLiveFailureReasonV1): { ok: false; reason: EarnLiveFailureReasonV1 } {
  return { ok: false, reason };
}

/** Classifies a thrown fetch/abort error into the closed failure taxonomy.
 * Never echoes the provider's message (it can carry URLs or upstream detail). */
export function classifyLiveTransportErrorV1(error: unknown): EarnLiveFailureReasonV1 {
  if (error instanceof PartnerHostNotAllowlistedError) return 'provider_host_not_allowlisted';
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout|timed out/i.test(message)) {
    return 'provider_timeout';
  }
  return 'provider_unreachable';
}

/** Non-2xx HTTP → typed failure. 429 is called out so an operator can tell a
 * rate limit from a broken provider without reading response bodies. */
export function classifyLiveHttpStatusV1(status: number): EarnLiveFailureReasonV1 {
  if (status === 429) return 'provider_rate_limited';
  return 'provider_http_error';
}

function roundBps(raw: number): EarnLiveParseResultV1<number> {
  if (!Number.isFinite(raw)) return liveFailureV1('provider_invalid_response');
  const bps = Math.round(raw);
  if (bps < 0 || bps > MAX_APY_BPS_V1) return liveFailureV1('apy_out_of_range');
  return { ok: true, value: bps };
}

/** Moonwell reports APY as a percent number (`17.77` = 17.77%). */
export function percentToApyBpsV1(value: number | null | undefined): EarnLiveParseResultV1<number | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  return roundBps(value * 100);
}

/** Morpho reports APY as a fraction (`0.0392` = 3.92%). */
export function fractionToApyBpsV1(value: number | null | undefined): EarnLiveParseResultV1<number | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  return roundBps(value * 10_000);
}

/**
 * Net APY can only ever be rounded DOWN to base + reward: `EarnCandidateV1`
 * rejects a net above its own composition, and independent rounding of three
 * provider floats can drift a single basis point over that line. Clamping (not
 * inflating base/reward to fit) keeps the published net a lower bound of what
 * the provider reported — never an invented yield.
 */
export function clampNetApyBpsV1(
  netApyBps: number | null,
  baseApyBps: number | null,
  rewardApyBps: number | null,
): number | null {
  if (netApyBps === null || baseApyBps === null) return netApyBps;
  const ceiling = baseApyBps + (rewardApyBps ?? 0);
  return netApyBps > ceiling ? ceiling : netApyBps;
}

/** Provider integers arrive as JSON numbers or strings depending on the API.
 * Only exact unsigned integers are accepted — a float or an unsafe-precision
 * number is "no datum", because an approximate atomic amount is worse than
 * none. */
export function parseAtomicIntegerV1(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^(0|[1-9][0-9]*)$/.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value === 'bigint') {
    return value >= 0n ? value.toString() : null;
  }
  return null;
}

const ADDRESS_PATTERN_V1 = /^0x[0-9a-fA-F]{40}$/;

export function normalizeLiveAddressV1(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return ADDRESS_PATTERN_V1.test(trimmed) ? (trimmed.toLowerCase() as `0x${string}`) : null;
}

/**
 * The instant the provider says the data describes, never later than `now`:
 * a provider clock running ahead must not buy extra freshness. An absent or
 * unparseable provider timestamp falls back to `now` — the moment we observed
 * it — which is the most conservative claim we can make.
 */
export function resolveObservedAtV1(providerTimestamp: number | string | null | undefined, now: Date): string {
  const nowMs = now.getTime();
  let parsed = Number.NaN;
  if (typeof providerTimestamp === 'number' && Number.isFinite(providerTimestamp)) {
    // Unix seconds (every earn provider reports seconds, not milliseconds).
    parsed = providerTimestamp * 1000;
  } else if (typeof providerTimestamp === 'string' && providerTimestamp.trim() !== '') {
    parsed = Date.parse(providerTimestamp);
  }
  if (!Number.isFinite(parsed) || parsed > nowMs) return new Date(nowMs).toISOString();
  return new Date(parsed).toISOString();
}

export function liveRequestHashV1(payload: Record<string, unknown>): HashV1 {
  return stableHashV1('earn-observation-request/v1', payload);
}

export function liveResponseHashV1(payload: Record<string, unknown>): HashV1 {
  return stableHashV1('earn-observation-response/v1', payload);
}

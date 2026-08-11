import { resolveRouteAssetV1 } from '@mioagent/intent-engine';
import {
  AddressV1Schema,
  RouteIntentV1Schema,
  stableHashV1,
  type AssetRefV1,
  type HashV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import type { SwapAdapterFailure, SwapAdapterId } from './types.js';

export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const UNISWAP_NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const;
export const KYBERSWAP_NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
export const KYBERSWAP_BASE_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5' as const;

const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function canonicalDecimal(value: string): string | null {
  const match = UNSIGNED_DECIMAL.exec(value.trim());
  if (!match) return null;
  const [wholePart, fractionPart = ''] = value.trim().split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function humanDecimalToAtomic(value: string, decimals: number): string | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const normalized = canonicalDecimal(value);
  if (normalized === null) return null;
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) return null;
  return `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '') || '0';
}

export function atomicToHumanDecimal(value: string, decimals: number): string | null {
  if (!UNSIGNED_INTEGER.test(value) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return value;
  const padded = value.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function percentageToBasisPoints(value: string): number | null {
  const normalized = canonicalDecimal(value);
  if (normalized === null) return null;
  const atomic = humanDecimalToAtomic(normalized, 6);
  if (atomic === null) return null;
  const bps = BigInt(atomic) / 10_000n;
  return bps <= 1_000_000n ? Number(bps) : null;
}

export function basisPointsToPercentage(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new TypeError('Basis points must be unsigned');
  return atomicToHumanDecimal(String(bps), 2)!;
}

/**
 * The percentage the Uniswap trade API accepts in a request body: a JSON
 * NUMBER. Sent as the decimal string every other amount in this codebase uses,
 * every request is rejected before it is routed:
 *
 *   400 RequestValidationError: "slippageTolerance" must be a number
 *
 * That is not a rounding concern — a tolerance is a bound, not money, and the
 * exact bound is still enforced by `minimumOutputAtomic` on our side. This
 * exists so the knowledge lives in ONE place: it was fixed in the quote client
 * and left broken in the build adapter, which is why preparing a Uniswap
 * transaction failed for months while comparing worked.
 */
export function uniswapSlippageToleranceV1(bps: number): number {
  return Number(basisPointsToPercentage(bps));
}

export function minimumOutputAtomic(expectedOutput: string, slippageBps: number): string {
  if (!UNSIGNED_INTEGER.test(expectedOutput) || BigInt(expectedOutput) <= 0n) {
    throw new TypeError('Expected output must be a positive atomic amount');
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new TypeError('Slippage must be between 0 and 10000 basis points');
  }
  return ((BigInt(expectedOutput) * BigInt(10_000 - slippageBps)) / 10_000n).toString();
}

export function parsePositiveAtomic(value: unknown): string | null {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return UNSIGNED_INTEGER.test(normalized) && BigInt(normalized) > 0n ? normalized : null;
}

export function parseUnsignedAtomic(value: unknown): string | null {
  const normalized = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return UNSIGNED_INTEGER.test(normalized) ? normalized : null;
}

export function parseProviderDecimal(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return canonicalDecimal(String(value));
}

export function parseProviderTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/^[0-9]+$/.test(value)) return parseProviderTimestamp(Number(value));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function resolveQuoteTimes(input: {
  now: Date;
  observedAt?: unknown;
  expiresAt?: unknown;
  fallbackTtlMs: number;
}): { observedAt: string; expiresAt: string } | null {
  if (!Number.isInteger(input.fallbackTtlMs) || input.fallbackTtlMs <= 0) {
    throw new TypeError('Quote TTL must be a positive integer');
  }
  const now = input.now.toISOString();
  const observedAt = parseProviderTimestamp(input.observedAt) ?? now;
  const expiresAt =
    parseProviderTimestamp(input.expiresAt) ??
    new Date(Date.parse(observedAt) + input.fallbackTtlMs).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(observedAt) || Date.parse(expiresAt) <= input.now.getTime()) {
    return null;
  }
  return { observedAt, expiresAt };
}

export function providerTokenAddress(
  asset: AssetRefV1,
  provider: SwapAdapterId,
): `0x${string}` | null {
  if (!isTrustedRouteAsset(asset)) return null;
  if (asset.kind === 'native') {
    return provider === 'uniswap' ? UNISWAP_NATIVE_ETH : KYBERSWAP_NATIVE_ETH;
  }
  return asset.address;
}

export function isTrustedRouteAsset(asset: AssetRefV1): boolean {
  const canonical = resolveRouteAssetV1(asset.address ?? asset.symbol);
  return Boolean(
    canonical &&
      canonical.assetId === asset.assetId &&
      canonical.chainId === asset.chainId &&
      canonical.kind === asset.kind &&
      canonical.address === asset.address &&
      canonical.symbol === asset.symbol &&
      canonical.decimals === asset.decimals,
  );
}

export function supportsSwapIntent(intent: RouteIntentV1): boolean {
  const parsed = RouteIntentV1Schema.safeParse(intent);
  return Boolean(
    parsed.success &&
      intent.status === 'ready' &&
      intent.goal === 'swap' &&
      intent.chainId === BASE_MAINNET_CHAIN_ID &&
      intent.fromAsset &&
      intent.toAsset &&
      isTrustedRouteAsset(intent.fromAsset) &&
      isTrustedRouteAsset(intent.toAsset) &&
      BigInt(intent.amount.amountAtomic) > 0n,
  );
}

export function protocolAllowsAdapter(intent: RouteIntentV1, adapterId: SwapAdapterId): boolean {
  if (intent.protocolConstraint.mode === 'any') return true;
  const includes = intent.protocolConstraint.protocols.includes(adapterId);
  return intent.protocolConstraint.mode === 'include_only' ? includes : !includes;
}

export function canonicalRequestHash(provider: SwapAdapterId, request: unknown): HashV1 {
  return stableHashV1(`swap-adapter/${provider}/request/v1`, request);
}

export function canonicalResponseHash(provider: SwapAdapterId, response: unknown): HashV1 {
  return stableHashV1(
    `swap-adapter/${provider}/response/v1`,
    redactProviderSecretsForHash(response),
  );
}

const SECRET_FIELD =
  /^(access_?token|refresh_?token|id_?token|api_?key|api_?token|secret|authorization|x-api-key|cookie|password|private_?key|credential|signature)$/i;

export function redactProviderSecretsForHash(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new TypeError('Provider response exceeds canonical hashing depth');
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderSecretsForHash(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_FIELD.test(key)
      ? '[redacted]'
      : redactProviderSecretsForHash(inner, depth + 1);
  }
  return output;
}

export function normalizeAddress(value: unknown): `0x${string}` | null {
  const parsed = AddressV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function providerFailure(
  provider: SwapAdapterId,
  errorCode: string,
  status?: number,
): SwapAdapterFailure {
  if (errorCode === 'provider_not_configured') {
    return { outcome: 'not_configured', provider, errorCode, retryable: false };
  }
  if (errorCode === 'provider_timeout') {
    return { outcome: 'timeout', provider, errorCode, retryable: true };
  }
  if (errorCode === 'provider_rate_limited' || status === 429) {
    return { outcome: 'rate_limited', provider, errorCode: 'provider_rate_limited', retryable: true };
  }
  if (errorCode === 'provider_invalid_schema' || errorCode === 'provider_expired_quote') {
    return { outcome: 'invalid_response', provider, errorCode, retryable: false };
  }
  if (
    errorCode === 'provider_asset_mismatch' ||
    errorCode === 'provider_chain_mismatch' ||
    errorCode === 'provider_router_mismatch'
  ) {
    return { outcome: 'rejected', provider, errorCode, retryable: false };
  }
  if (errorCode === 'provider_unsupported_intent') {
    return { outcome: 'unsupported', provider, errorCode, retryable: false };
  }
  if (errorCode === 'provider_no_route') {
    return { outcome: 'unavailable', provider, errorCode, retryable: false };
  }
  return {
    outcome: 'unavailable',
    provider,
    errorCode,
    retryable: status === undefined || status >= 500,
  };
}

export function normalizeCaughtProviderError(provider: SwapAdapterId, error: unknown): SwapAdapterFailure {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/abort|timeout/i.test(message)) return providerFailure(provider, 'provider_timeout');
  if (/429|rate|quota/i.test(message)) return providerFailure(provider, 'provider_rate_limited', 429);
  if (/network|fetch|econn|enotfound|unreachable/i.test(message)) {
    return providerFailure(provider, 'provider_unreachable');
  }
  return providerFailure(provider, 'provider_http_error');
}

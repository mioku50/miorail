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
  if (!isRoutableRouteAssetV1(asset)) return null;
  if (asset.kind === 'native') {
    return provider === 'uniswap' ? UNISWAP_NATIVE_ETH : KYBERSWAP_NATIVE_ETH;
  }
  return asset.address;
}

const ROUTE_ADDRESS_V1 = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS_V1 = '0x0000000000000000000000000000000000000000';
/** Above this, base units stop being reconstructable. No routable ERC-20 is
 * near it; matches the bound the intent layer and the guards use. */
const MAX_ROUTE_ASSET_DECIMALS_V1 = 36;

/**
 * The key two sides of a swap are compared BY, or null when the asset cannot
 * be routed at all.
 *
 * Native ETH normalises to WETH on purpose: ETH↔WETH is a wrap, there is no
 * pool and no price to compare, and a wrap dressed as a route would carry a
 * provider's name on a trade nobody quoted.
 *
 * This is the ONE place that decides what a routable side is. The rule used to
 * be written out separately in the quote adapters, in both build adapters and
 * in the composer — four copies of "USDC in only", fixed one at a time over
 * three sessions.
 */
export function routeSideV1(asset: AssetRefV1 | null | undefined): string | null {
  if (!asset) return null;
  if (asset.chainId !== BASE_MAINNET_CHAIN_ID) return null;
  if (asset.kind === 'native') return BASE_WETH_ADDRESS_V1;
  const address = asset.address?.toLowerCase();
  if (!address || !ROUTE_ADDRESS_V1.test(address) || address === ZERO_ADDRESS_V1) return null;
  if (
    !Number.isInteger(asset.decimals) ||
    asset.decimals < 0 ||
    asset.decimals > MAX_ROUTE_ASSET_DECIMALS_V1
  ) {
    return null;
  }
  return address;
}

const BASE_WETH_ADDRESS_V1 = '0x4200000000000000000000000000000000000006';

/**
 * An asset a provider may be ASKED about — the canonical three, or any
 * well-formed Base ERC-20.
 *
 * This is not a claim that the token is safe. It says the asset is well enough
 * described to quote. Whether it may be traded is decided later and elsewhere:
 * by the token-security verdict on both sides, and by the Safety Kernel over
 * the calldata that comes back.
 */
export function isRoutableRouteAssetV1(asset: AssetRefV1): boolean {
  return isTrustedRouteAsset(asset) || routeSideV1(asset) !== null;
}

/** Both sides routable, and not the same side. */
export function routablePairV1(
  from: AssetRefV1 | null | undefined,
  to: AssetRefV1 | null | undefined,
): boolean {
  const fromSide = routeSideV1(from);
  const toSide = routeSideV1(to);
  return fromSide !== null && toSide !== null && fromSide !== toSide;
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

function wellFormedSwapIntentV1(intent: RouteIntentV1): boolean {
  const parsed = RouteIntentV1Schema.safeParse(intent);
  return Boolean(
    parsed.success &&
      intent.status === 'ready' &&
      intent.goal === 'swap' &&
      intent.chainId === BASE_MAINNET_CHAIN_ID &&
      intent.fromAsset &&
      intent.toAsset &&
      BigInt(intent.amount.amountAtomic) > 0n,
  );
}

/** The canonical three only. Aerodrome keeps this: its route search is pinned
 * to a known pool set, so asking it about an arbitrary token would produce a
 * "no route" that says nothing. */
export function supportsSwapIntent(intent: RouteIntentV1): boolean {
  return (
    wellFormedSwapIntentV1(intent) &&
    isTrustedRouteAsset(intent.fromAsset!) &&
    isTrustedRouteAsset(intent.toAsset!)
  );
}

/** Any well-formed Base pair. Uniswap and KyberSwap route arbitrary tokens;
 * the limit was never theirs. */
export function supportsRoutableSwapIntentV1(intent: RouteIntentV1): boolean {
  return wellFormedSwapIntentV1(intent) && routablePairV1(intent.fromAsset, intent.toAsset);
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

/** Codes that all mean "the answer came back, and we could not accept it". */
const INVALID_RESPONSE_CODES_V1 = new Set([
  'provider_invalid_schema',
  'provider_output_not_positive',
  'provider_gas_units_missing',
  'provider_minimum_above_output',
  'provider_price_impact_invalid',
  'provider_slippage_echo_mismatch',
]);

/**
 * The one error code that means "this venue will not quote this token".
 *
 * Exported as a constant so an adapter, the normaliser and the surface all
 * name the same string. A second spelling anywhere is a state that silently
 * falls through to `unavailable`.
 */
export const PROVIDER_POLICY_REFUSED_CODE_V1 = 'provider_policy_refused' as const;

/**
 * Provider reasons that mean "we can route this, and we will not".
 *
 * 0x answers `BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE` /
 * `SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE` at HTTP 200 for the Coinbase tokenized
 * equities — a complete, well-formed answer carrying a verdict, and not a
 * route finding. Each of the three obvious places to file it says something
 * untrue:
 *
 *   no_route                 hands a venue's house rules to the market
 *   unsupported_token        claims the router never heard of a token it named
 *   provider_failed / HTTP   puts a clean 200 on Miorail's account
 *
 * NOTE: nothing in this build calls 0x — the audit measured it out of process
 * and no adapter was integrated. This is the seam, typed and tested, so the
 * state exists BEFORE the adapter does. A provider that starts answering this
 * way lands in its own bucket instead of quietly joining one of the three.
 *
 * Matching is exact and case-insensitive on a trimmed string. No substring
 * search: a provider message that merely contains the phrase is prose, and
 * this taxonomy is built on typed codes rather than on parsing text.
 */
export const PROVIDER_POLICY_REFUSAL_REASONS_V1: readonly string[] = [
  'BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE',
  'SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE',
];

export function providerPolicyRefusalCodeV1(
  rawReason: unknown,
): typeof PROVIDER_POLICY_REFUSED_CODE_V1 | null {
  if (typeof rawReason !== 'string') return null;
  const normalized = rawReason.trim().toUpperCase();
  return PROVIDER_POLICY_REFUSAL_REASONS_V1.includes(normalized)
    ? PROVIDER_POLICY_REFUSED_CODE_V1
    : null;
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
  // Everything a response can be wrong ABOUT is one outcome — `invalid_response`
  // — while keeping its own code. The codes were split so an intermittent
  // refusal is diagnosable in the log; the OUTCOME must not move with them,
  // because it is what decides retryability and how the engine counts the
  // candidate. Splitting the label is a reporting change, not a policy one.
  if (INVALID_RESPONSE_CODES_V1.has(errorCode) || errorCode === 'provider_expired_quote') {
    return { outcome: 'invalid_response', provider, errorCode, retryable: false };
  }
  if (errorCode.startsWith('o1_')) {
    return { outcome: 'invalid_response', provider, errorCode, retryable: false };
  }
  if (errorCode.startsWith('hydrex_')) {
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
  // The provider has a market for this pair at a venue this adapter cannot
  // read. `unsupported`, deliberately, and never `unavailable`: the second is
  // the word for the market having no route, and this is the opposite — a route
  // exists and OUR coverage stops short of it. Not retryable, because asking
  // again reaches the same venue we still cannot read.
  if (errorCode === 'provider_venue_not_covered') {
    return { outcome: 'unsupported', provider, errorCode, retryable: false };
  }
  // A venue that CAN route this pair and declines to, on its own trading
  // policy. Deliberately not folded into any of its three neighbours: it is
  // not `unavailable` (the market having no route), not `unsupported` (our
  // coverage falling short), and not a transport code (our failure). See
  // `providerPolicyRefusalCodeV1` for what produces it.
  if (errorCode === PROVIDER_POLICY_REFUSED_CODE_V1) {
    return { outcome: 'policy_refused', provider, errorCode, retryable: false };
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

import {
  JsonObjectV1Schema,
  type GasEstimateV1,
} from '@mioagent/route-domain';
import {
  loadSkillExecutor,
  type BaseMcpSkillExecutor,
} from '@mioagent/runtime-skills';
import { z } from 'zod';
import { buildQuoteArtifacts, KYBERSWAP_PROVIDER_V1 } from './candidate.js';
import {
  KYBERSWAP_BASE_ROUTER,
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
  normalizeCaughtProviderError,
  parsePositiveAtomic,
  parseProviderDecimal,
  parseUnsignedAtomic,
  percentageToBasisPoints,
  protocolAllowsAdapter,
  providerFailure,
  providerTokenAddress,
  resolveQuoteTimes,
  supportsRoutableSwapIntentV1,
} from './normalization.js';
import { extractRouteProvenance } from './provenance.js';
import type {
  SwapAdapterQuoteInput,
  SwapAdapterResult,
  SwapRouteAdapter,
} from './types.js';

const KyberResponseSchema = z
  .object({
    data: z
      .object({
        routeSummary: JsonObjectV1Schema,
        routerAddress: z.string().min(1).max(100),
        routeId: z.string().min(1).max(300).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface KyberSwapRouteAdapterOptions {
  executorFactory?: () => BaseMcpSkillExecutor | null;
  fallbackTtlMs?: number;
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/**
 * Price impact, from the provider's own two USD figures.
 *
 * KyberSwap's `/base/api/v1/routes` response carries no price-impact field —
 * not `priceImpactBps`, not `priceImpact`, not `priceImpactPct`. The adapter
 * treated its absence as a malformed response, so every KyberSwap quote was
 * refused with `provider_invalid_schema`, always. In production that left
 * Aerodrome as the only answering provider, which the engine correctly reports
 * as `single_provider_available` — no comparison, no recommendation, no Route
 * Card, and a route card a user cannot act on. One missing field, four screens
 * away.
 *
 * `amountInUsd` and `amountOutUsd` are both stated BY KYBERSWAP, and the
 * difference between them over the input is what price impact means. This is
 * arithmetic on provider data, not a substituted guess: with no USD pair the
 * function returns null and the old refusal stands.
 *
 * One caveat worth stating: this spread includes whatever fee the aggregator
 * priced in, so it is the impact a user actually experiences rather than a
 * pure pool-depth figure. That is the more useful of the two here, and it is
 * the same quantity KyberSwap's own interface displays.
 *
 * Floating point is fine for exactly this: basis points are a bounded integer
 * ratio for ranking and display, never an amount anyone is paid.
 */
function priceImpactFromUsdV1(routeSummary: Record<string, unknown>): number | null {
  const inUsd = Number(parseProviderDecimal(field(routeSummary, 'amountInUsd')) ?? Number.NaN);
  const outUsd = Number(parseProviderDecimal(field(routeSummary, 'amountOutUsd')) ?? Number.NaN);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) return null;
  // A route that returns MORE value than it consumed has no adverse impact.
  // Reported as zero rather than negative: the field is unsigned by contract,
  // and "better than expected" is not a risk to warn anybody about.
  const bps = Math.round(((inUsd - outUsd) / inUsd) * 10_000);
  if (!Number.isFinite(bps) || bps > 1_000_000) return null;
  return Math.max(0, bps);
}

function reportsNoRoute(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const message = String(record.message ?? record.error ?? record.reason ?? '');
  return /no (?:swap )?route|route not found|insufficient liquidity/i.test(message);
}

export class KyberSwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'kyberswap' as const;
  private readonly executorFactory: () => BaseMcpSkillExecutor | null;
  private readonly fallbackTtlMs: number;

  constructor(options: KyberSwapRouteAdapterOptions = {}) {
    this.executorFactory = options.executorFactory ?? (() => loadSkillExecutor('kyberswap'));
    this.fallbackTtlMs = options.fallbackTtlMs ?? 20_000;
  }

  supports(intent: SwapAdapterQuoteInput['intent']): boolean {
    return supportsRoutableSwapIntentV1(intent) && protocolAllowsAdapter(intent, this.id);
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    if (!this.supports(input.intent)) {
      return providerFailure(this.id, 'provider_unsupported_intent');
    }
    if (input.walletAddress.toLowerCase() !== input.intent.walletAddress) {
      return providerFailure(this.id, 'provider_unsupported_intent');
    }
    const executor = this.executorFactory();
    if (!executor || executor.namespace !== this.id) {
      return providerFailure(this.id, 'provider_not_configured');
    }

    const fromAsset = input.intent.fromAsset!;
    const toAsset = input.intent.toAsset!;
    const tokenIn = providerTokenAddress(fromAsset, this.id);
    const tokenOut = providerTokenAddress(toAsset, this.id);
    if (!tokenIn || !tokenOut) return providerFailure(this.id, 'provider_unsupported_intent');

    const parameters = new URLSearchParams([
      ['tokenIn', tokenIn],
      ['tokenOut', tokenOut],
      ['amountIn', input.intent.amount.amountAtomic],
      ['to', input.walletAddress],
      ['slippageTolerance', String(input.intent.slippageConstraint.maxBps)],
      ['source', 'miorail'],
    ]);
    const path = `/base/api/v1/routes?${parameters.toString()}`;
    const safeRequest = {
      path: '/base/api/v1/routes',
      chainId: 8453,
      tokenIn,
      tokenOut,
      amountIn: input.intent.amount.amountAtomic,
      to: input.walletAddress,
      slippageToleranceBps: input.intent.slippageConstraint.maxBps,
      source: 'miorail',
    };

    let response: Awaited<ReturnType<BaseMcpSkillExecutor['request']>>;
    try {
      response = await executor.request({ path, method: 'GET', chainId: 8453 });
    } catch (error) {
      return normalizeCaughtProviderError(this.id, error);
    }
    if (response.status === 404) return providerFailure(this.id, 'provider_no_route', 404);
    if (response.status === 429) return providerFailure(this.id, 'provider_rate_limited', 429);
    if (response.status < 200 || response.status >= 300) {
      return providerFailure(this.id, 'provider_http_error', response.status);
    }
    if (reportsNoRoute(response.data)) return providerFailure(this.id, 'provider_no_route');

    const parsed = KyberResponseSchema.safeParse(response.data);
    if (!parsed.success) return providerFailure(this.id, 'provider_invalid_schema');
    const routeSummary = parsed.data.data.routeSummary;
    const routerAddress = normalizeAddress(parsed.data.data.routerAddress);
    if (routerAddress !== KYBERSWAP_BASE_ROUTER) {
      return providerFailure(this.id, 'provider_router_mismatch');
    }
    const amountIn = parsePositiveAtomic(field(routeSummary, 'amountIn'));
    const amountOut = parsePositiveAtomic(field(routeSummary, 'amountOut'));
    if (!amountIn || !amountOut) return providerFailure(this.id, 'provider_invalid_schema');
    if (amountIn !== input.intent.amount.amountAtomic) {
      return providerFailure(this.id, 'provider_asset_mismatch');
    }
    if (
      normalizeAddress(field(routeSummary, 'tokenIn', 'tokenInAddress')) !== tokenIn ||
      normalizeAddress(field(routeSummary, 'tokenOut', 'tokenOutAddress')) !== tokenOut
    ) {
      return providerFailure(this.id, 'provider_asset_mismatch');
    }
    const responseChain = field(routeSummary, 'chainId', 'chain');
    if (
      responseChain !== undefined &&
      String(responseChain).toLowerCase() !== 'base' &&
      String(responseChain) !== '8453'
    ) {
      return providerFailure(this.id, 'provider_chain_mismatch');
    }

    const gasUnits = parsePositiveAtomic(field(routeSummary, 'gas', 'gasUnits'));
    const gasUsd = parseProviderDecimal(field(routeSummary, 'gasUsd'));
    if (!gasUnits) return providerFailure(this.id, 'provider_invalid_schema');
    const providerMinimumOutput = parseUnsignedAtomic(
      field(routeSummary, 'amountOutMin', 'minimumAmountOut', 'minAmountOut'),
    );
    if (providerMinimumOutput !== null && BigInt(providerMinimumOutput) > BigInt(amountOut)) {
      return providerFailure(this.id, 'provider_invalid_schema');
    }
    const rawPriceImpactBps = field(routeSummary, 'priceImpactBps');
    const parsedImpactBps = parseUnsignedAtomic(rawPriceImpactBps);
    const priceImpactBps =
      rawPriceImpactBps === undefined
        ? (percentageToBasisPoints(String(field(routeSummary, 'priceImpact', 'priceImpactPct') ?? '')) ??
          priceImpactFromUsdV1(routeSummary))
        : parsedImpactBps === null
          ? null
          : Number(parsedImpactBps);
    if (
      priceImpactBps === null ||
      !Number.isInteger(priceImpactBps) ||
      priceImpactBps < 0 ||
      priceImpactBps > 1_000_000
    ) {
      return providerFailure(this.id, 'provider_invalid_schema');
    }

    const times = resolveQuoteTimes({
      now: input.now,
      observedAt: field(routeSummary, 'observedAt', 'timestamp', 'createdAt'),
      expiresAt: field(routeSummary, 'expiresAt', 'expiration', 'deadline'),
      fallbackTtlMs: this.fallbackTtlMs,
    });
    if (!times) return providerFailure(this.id, 'provider_expired_quote');

    const route = field(routeSummary, 'route', 'routeData', 'swaps') ?? [];
    const provenance = extractRouteProvenance(route, [fromAsset, toAsset], 'unknown-liquidity');
    const sourceIndependence = provenance.pools.length > 0 ? 'overlapping' : 'unknown';
    const riskFlags = [
      'aggregated-route',
      ...(provenance.pools.length === 0 ? ['liquidity-pools-unknown'] : []),
    ];
    const responseHash = canonicalResponseHash(this.id, {
      data: {
        routeSummary,
        routerAddress,
      },
    });
    const requestHash = canonicalRequestHash(this.id, safeRequest);
    const gas: GasEstimateV1 = {
      gasUnits,
      maxFeePerGasWei: null,
      estimatedCostNative: null,
      estimatedCostUsd: gasUsd,
    };
    const quoteIdValue = field(routeSummary, 'routeId', 'quoteId');
    const providerQuoteId =
      typeof quoteIdValue === 'string'
        ? quoteIdValue
        : parsed.data.data.routeId ?? null;
    const blockNumber = parseUnsignedAtomic(field(routeSummary, 'blockNumber'));
    const artifacts = buildQuoteArtifacts({
      adapterId: this.id,
      intent: input.intent,
      provider: KYBERSWAP_PROVIDER_V1,
      requestId: input.requestId,
      providerQuoteId,
      requestHash,
      responseHash,
      expectedOutputAtomic: amountOut,
      providerMinimumOutputAtomic: providerMinimumOutput,
      gas,
      priceImpactBps,
      observedAt: times.observedAt,
      expiresAt: times.expiresAt,
      blockNumber,
      provenance,
      riskFlags,
      usesExternalAggregators: true,
      sourceIndependence,
    });
    return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
  }
}

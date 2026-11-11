import {
  AtomicAmountV1Schema,
  JsonValueV1Schema,
  type GasEstimateV1,
} from '@mioagent/route-domain';
import { z } from 'zod';
import { buildQuoteArtifacts, UNISWAP_PROVIDER_V1 } from './candidate.js';
import {
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
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
import {
  UniswapQuoteClient,
  type UniswapQuoteClientOptions,
} from './uniswap-client.js';
import type {
  SwapAdapterQuoteInput,
  SwapAdapterResult,
  SwapRouteAdapter,
} from './types.js';

const DecimalLikeSchema = z.union([z.string(), z.number().finite()]);
const QuoteTokenSchema = z
  .object({
    amount: AtomicAmountV1Schema,
    token: z.string().min(1).max(100),
    minimumAmount: AtomicAmountV1Schema.optional(),
  })
  .passthrough();
const UniswapQuoteSchema = z
  .object({
    input: QuoteTokenSchema,
    output: QuoteTokenSchema,
    gasUseEstimate: AtomicAmountV1Schema.optional(),
    classicGasUseEstimate: AtomicAmountV1Schema.optional(),
    gasFee: AtomicAmountV1Schema.optional(),
    classicGasUseEstimateUSD: DecimalLikeSchema.optional(),
    /** What the trade API sends today. `classicGasUseEstimateUSD` above is not
     * in the response any more, so reading only that yielded a null USD gas
     * cost — see the note at the read below for what that cost. */
    gasFeeUSD: DecimalLikeSchema.optional(),
    priceImpact: DecimalLikeSchema.optional(),
    priceImpactPct: DecimalLikeSchema.optional(),
    priceImpactBps: z.union([z.string(), z.number().int()]).optional(),
    minimumOutput: AtomicAmountV1Schema.optional(),
    amountOutMinimum: AtomicAmountV1Schema.optional(),
    slippageTolerance: DecimalLikeSchema.optional(),
    quoteId: z.string().min(1).max(300).optional(),
    requestId: z.string().min(1).max(300).optional(),
    observedAt: z.union([z.string(), z.number().int()]).optional(),
    expiresAt: z.union([z.string(), z.number().int()]).optional(),
    quoteExpiry: z.union([z.string(), z.number().int()]).optional(),
    blockNumber: AtomicAmountV1Schema.optional(),
    route: JsonValueV1Schema.optional(),
  })
  .passthrough();
const UniswapResponseSchema = z
  .object({
    quote: UniswapQuoteSchema,
    routing: z.string().min(1).max(100).optional(),
    quoteId: z.string().min(1).max(300).optional(),
    requestId: z.string().min(1).max(300).optional(),
    route: JsonValueV1Schema.optional(),
  })
  .passthrough();

export interface UniswapSwapRouteAdapterOptions extends UniswapQuoteClientOptions {
  client?: UniswapQuoteClient;
  fallbackTtlMs?: number;
}

/** A stated price impact below zero: 0 when the route beats the reference by one percent or less, null
 * (none stated) when it is further below, undefined when the figure is not a negative number at all. */
export function favourablePriceImpactBpsV1(stated: unknown): 0 | null | undefined {
  const text = typeof stated === 'number' || typeof stated === 'string' ? String(stated).trim() : '';
  if (!/^-(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent >= 0) return percent === 0 ? 0 : undefined;
  return percent >= -1 ? 0 : null;
}

export class UniswapSwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'uniswap' as const;
  private readonly client: UniswapQuoteClient;
  private readonly fallbackTtlMs: number;

  constructor(options: UniswapSwapRouteAdapterOptions = {}) {
    this.client = options.client ?? new UniswapQuoteClient(options);
    this.fallbackTtlMs = options.fallbackTtlMs ?? 30_000;
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
    const fromAsset = input.intent.fromAsset!;
    const toAsset = input.intent.toAsset!;
    const tokenIn = providerTokenAddress(fromAsset, this.id);
    const tokenOut = providerTokenAddress(toAsset, this.id);
    if (!tokenIn || !tokenOut) return providerFailure(this.id, 'provider_unsupported_intent');

    const response = await this.client.quote({
      chainId: 8453,
      amountInAtomic: input.intent.amount.amountAtomic,
      tokenIn,
      tokenOut,
      swapper: input.walletAddress,
      slippageBps: input.intent.slippageConstraint.maxBps,
    });
    if (response.outcome !== 'response') {
      const { outcome, provider, errorCode, retryable } = response;
      return { outcome, provider, errorCode, retryable };
    }

    const parsed = UniswapResponseSchema.safeParse(response.payload);
    if (!parsed.success) return providerFailure(this.id, 'provider_invalid_schema');
    const quote = parsed.data.quote;
    // Each refusal below carries its OWN code. They all used to answer
    // `provider_invalid_schema`, so six unrelated causes — a shape we cannot
    // parse, a missing gas estimate, a slippage echo that disagrees with what
    // we asked for — arrived in the log under one word, and an intermittent
    // Uniswap refusal could not be attributed to them or to us. The sentence
    // shown to the user is unchanged; see REASON_BY_ERROR_CODE_V1.
    if (BigInt(quote.output.amount) <= 0n) {
      return providerFailure(this.id, 'provider_output_not_positive');
    }
    if (quote.input.amount !== input.intent.amount.amountAtomic) {
      return providerFailure(this.id, 'provider_asset_mismatch');
    }
    if (
      normalizeAddress(quote.input.token) !== tokenIn ||
      normalizeAddress(quote.output.token) !== tokenOut
    ) {
      return providerFailure(this.id, 'provider_asset_mismatch');
    }

    const gasUnits = parsePositiveAtomic(quote.gasUseEstimate ?? quote.classicGasUseEstimate);
    const gasFee = parseUnsignedAtomic(quote.gasFee);
    // `gasFeeUSD` first: it is the field the live response carries, and
    // `classicGasUseEstimateUSD` is not in it at all. Reading only the old name
    // left estimatedCostUsd null, which the scorer reports as
    // `gas_usd_valuation_unavailable` — an unscored route. With Aerodrome also
    // unscored that left one rankable candidate out of three, too few to
    // compare, so no route was ever recommended and no Route Card was built.
    // The fixtures still state the old name, which is why the suite never saw
    // it.
    const gasUsd = parseProviderDecimal(quote.gasFeeUSD ?? quote.classicGasUseEstimateUSD);
    if (!gasUnits) return providerFailure(this.id, 'provider_gas_units_missing');
    const providerMinimumOutput = parseUnsignedAtomic(
      quote.minimumOutput ?? quote.amountOutMinimum ?? quote.output.minimumAmount,
    );
    if (
      providerMinimumOutput !== null &&
      BigInt(providerMinimumOutput) > BigInt(quote.output.amount)
    ) {
      return providerFailure(this.id, 'provider_minimum_above_output');
    }
    const parsedImpactBps = parseUnsignedAtomic(quote.priceImpactBps);
    // The trade API states price impact against its own reference price, and for a buy of a tokenized
    // stock that figure is often BELOW zero: −0.02 and −0.04 for NVDAc and SPCXc, and −100 for TSLAc and
    // AMZNc, whose reference is simply wrong (live answers, 2026-11-11). Read as "malformed", each of
    // those refused Uniswap's whole quote, and with one other router answering, Swap AI was left with
    // "Use KyberSwap only" (six of 22 comparisons in five days). The amounts are what a quote is; this
    // figure is only shown beside them. So a route that beats the reference by up to one percent has no
    // adverse impact, as KyberSwap's does, and a figure further below zero says only that the reference
    // cannot be trusted: no impact is stated for it.
    const favourableImpactBps = quote.priceImpactBps === undefined
      ? favourablePriceImpactBpsV1(quote.priceImpact ?? quote.priceImpactPct)
      : undefined;
    const priceImpactBps =
      favourableImpactBps !== undefined
        ? favourableImpactBps
        : quote.priceImpactBps === undefined
          ? percentageToBasisPoints(String(quote.priceImpact ?? quote.priceImpactPct ?? ''))
          : parsedImpactBps === null
            ? null
            : Number(parsedImpactBps);
    if (
      favourableImpactBps === undefined && (
        priceImpactBps === null ||
        !Number.isInteger(priceImpactBps) ||
        priceImpactBps < 0 ||
        priceImpactBps > 1_000_000
      )
    ) {
      return providerFailure(this.id, 'provider_price_impact_invalid');
    }
    if (quote.slippageTolerance !== undefined) {
      const responseSlippage = percentageToBasisPoints(String(quote.slippageTolerance));
      if (responseSlippage !== input.intent.slippageConstraint.maxBps) {
        // Not a malformed response: the provider answered with a tolerance
        // other than the one the user approved. Refusing is right; calling it
        // a schema fault hid which of the six causes actually fired.
        return providerFailure(this.id, 'provider_slippage_echo_mismatch');
      }
    }
    const times = resolveQuoteTimes({
      now: input.now,
      observedAt: quote.observedAt,
      expiresAt: quote.expiresAt ?? quote.quoteExpiry,
      fallbackTtlMs: this.fallbackTtlMs,
    });
    if (!times) return providerFailure(this.id, 'provider_expired_quote');

    const route = quote.route ?? parsed.data.route ?? [];
    const provenance = extractRouteProvenance(route, [fromAsset, toAsset], 'uniswap');
    const riskFlags = provenance.pools.length === 0 ? ['liquidity-pools-unknown'] : [];
    const safeResponse = {
      quote: {
        input: { amount: quote.input.amount, token: tokenIn },
        output: { amount: quote.output.amount, token: tokenOut },
        providerMinimumOutput,
        gasUseEstimate: gasUnits,
        gasFee,
        gasUsd,
        priceImpactBps,
        slippageBps: input.intent.slippageConstraint.maxBps,
        observedAt: times.observedAt,
        expiresAt: times.expiresAt,
        blockNumber: quote.blockNumber ?? null,
        route,
      },
      routing: parsed.data.routing ?? 'UNISWAP',
      quoteId: quote.quoteId ?? parsed.data.quoteId ?? null,
      requestId: quote.requestId ?? parsed.data.requestId ?? null,
    };
    const requestHash = canonicalRequestHash(this.id, response.safeRequest);
    const responseHash = canonicalResponseHash(this.id, safeResponse);
    const gas: GasEstimateV1 = {
      gasUnits,
      maxFeePerGasWei: null,
      estimatedCostNative: gasFee === null ? null : atomicToHumanDecimal(gasFee, 18),
      estimatedCostUsd: gasUsd,
    };
    const artifacts = buildQuoteArtifacts({
      adapterId: this.id,
      intent: input.intent,
      provider: UNISWAP_PROVIDER_V1,
      requestId: input.requestId,
      providerQuoteId: quote.quoteId ?? parsed.data.quoteId ?? parsed.data.requestId ?? null,
      requestHash,
      responseHash,
      expectedOutputAtomic: quote.output.amount,
      providerMinimumOutputAtomic: providerMinimumOutput,
      gas,
      priceImpactBps,
      observedAt: times.observedAt,
      expiresAt: times.expiresAt,
      blockNumber: quote.blockNumber ?? null,
      provenance,
      riskFlags,
      usesExternalAggregators: false,
      sourceIndependence: provenance.pools.length > 0 ? 'independent' : 'unknown',
    });
    return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
  }
}

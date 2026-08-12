import type { GasEstimateV1, ProviderRefV1 } from '@mioagent/route-domain';
import { buildQuoteArtifacts } from './candidate.js';
import {
  atomicToHumanDecimal,
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
  protocolAllowsAdapter,
  providerFailure,
  routablePairV1,
  supportsRoutableSwapIntentV1,
} from './normalization.js';
import {
  O1OrderClientV1,
  type O1OrderClientV1Options,
  type O1OrderRequestV1,
} from './o1-client.js';
import { parseO1OrderV1 } from './o1-order.js';
import { createO1RouterPinReaderV1, type O1RouterPinReaderV1 } from './o1-pinned.js';
import type { SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from './types.js';

export const O1_PROVIDER_V1 = {
  id: 'o1-exchange',
  displayName: 'o1.exchange',
  kind: 'aggregator',
  operator: 'o1.exchange',
} as const satisfies ProviderRefV1;

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export function o1OrderRequestFromIntentV1(
  intent: SwapAdapterQuoteInput['intent'],
  walletAddress: `0x${string}`,
): O1OrderRequestV1 | null {
  const from = intent.fromAsset;
  const to = intent.toAsset;
  if (
    !supportsRoutableSwapIntentV1(intent) ||
    !from ||
    !to ||
    from.kind !== 'erc20' ||
    to.kind !== 'erc20' ||
    !from.address ||
    !to.address ||
    !routablePairV1(from, to)
  ) {
    return null;
  }
  const fromAddress = normalizeAddress(from.address);
  const toAddress = normalizeAddress(to.address);
  if (!fromAddress || !toAddress) return null;
  if (fromAddress === BASE_USDC) {
    return {
      networkId: 8453,
      signerAddress: walletAddress,
      tokenAddress: toAddress,
      quoteTokenAddress: fromAddress,
      uiAmount: intent.amount.amountDecimal,
      direction: 'buy',
      slippageBps: intent.slippageConstraint.maxBps,
      mevProtection: false,
    };
  }
  if (toAddress === BASE_USDC) {
    return {
      networkId: 8453,
      signerAddress: walletAddress,
      tokenAddress: fromAddress,
      quoteTokenAddress: toAddress,
      uiAmount: intent.amount.amountDecimal,
      direction: 'sell',
      slippageBps: intent.slippageConstraint.maxBps,
      mevProtection: false,
    };
  }
  return null;
}

export interface O1SwapRouteAdapterOptions extends O1OrderClientV1Options {
  client?: O1OrderClientV1;
  pinReader?: O1RouterPinReaderV1 | null;
  rpcUrl?: string;
  fallbackTtlMs?: number;
}

export class O1SwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'o1-exchange' as const;
  private readonly client: O1OrderClientV1;
  private readonly pinReader: O1RouterPinReaderV1 | null;
  private readonly fallbackTtlMs: number;

  constructor(options: O1SwapRouteAdapterOptions = {}) {
    this.client = options.client ?? new O1OrderClientV1(options);
    this.pinReader =
      options.pinReader ??
      (options.rpcUrl?.trim() ? createO1RouterPinReaderV1({ rpcUrl: options.rpcUrl }) : null);
    this.fallbackTtlMs = options.fallbackTtlMs ?? 20_000;
  }

  supports(intent: SwapAdapterQuoteInput['intent']): boolean {
    return (
      protocolAllowsAdapter(intent, this.id) &&
      o1OrderRequestFromIntentV1(intent, intent.walletAddress) !== null
    );
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    if (
      !this.supports(input.intent) ||
      input.walletAddress.toLowerCase() !== input.intent.walletAddress
    ) {
      return providerFailure(this.id, 'provider_unsupported_intent');
    }
    const request = o1OrderRequestFromIntentV1(input.intent, input.walletAddress);
    if (!request) return providerFailure(this.id, 'provider_unsupported_intent');
    if (!this.pinReader) return providerFailure(this.id, 'provider_not_configured');
    const pin = await this.pinReader.verify();
    if (!pin.ok) {
      return providerFailure(
        this.id,
        pin.reason === 'not_configured'
          ? 'provider_not_configured'
          : pin.reason === 'mismatch'
            ? 'provider_router_mismatch'
            : 'provider_unreachable',
      );
    }
    const transport = await this.client.order(request);
    if (transport.outcome !== 'response') {
      return providerFailure(
        this.id,
        transport.outcome === 'not_configured'
          ? 'provider_not_configured'
          : transport.outcome === 'timeout'
            ? 'provider_timeout'
            : transport.outcome === 'rate_limited'
              ? 'provider_rate_limited'
              : 'provider_unreachable',
        transport.status ?? undefined,
      );
    }
    const parsed = parseO1OrderV1({
      payload: transport.payload,
      request,
      inputAsset: input.intent.fromAsset!,
      outputAsset: input.intent.toAsset!,
      amountInAtomic: input.intent.amount.amountAtomic,
    });
    if (!parsed.ok) return providerFailure(this.id, parsed.errorCode);
    const observedAt = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + this.fallbackTtlMs).toISOString();
    const maxFee = parsed.value.maxFeePerGasWei;
    const estimatedCostWei =
      maxFee === null ? null : (BigInt(maxFee) * BigInt(parsed.value.gasUnits)).toString();
    const gas: GasEstimateV1 = {
      gasUnits: parsed.value.gasUnits,
      maxFeePerGasWei: maxFee,
      estimatedCostNative:
        estimatedCostWei === null ? null : atomicToHumanDecimal(estimatedCostWei, 18),
      estimatedCostUsd: null,
    };
    const artifacts = buildQuoteArtifacts({
      adapterId: this.id,
      intent: input.intent,
      provider: O1_PROVIDER_V1,
      requestId: input.requestId,
      providerQuoteId: parsed.value.orderId,
      requestHash: canonicalRequestHash(this.id, transport.safeRequest),
      responseHash: canonicalResponseHash(this.id, parsed.value.safeResponse),
      expectedOutputAtomic: parsed.value.expectedOutputAtomic,
      providerMinimumOutputAtomic: parsed.value.minimumOutputAtomic,
      gas,
      // The standard order response exposes a minimum output but no reference
      // market price. Null preserves No data — no score; zero would invent a
      // perfect price-impact observation.
      priceImpactBps: null,
      observedAt,
      expiresAt,
      blockNumber: pin.blockNumber,
      provenance: {
        pools: parsed.value.pools,
        liquiditySources: parsed.value.liquiditySources,
      },
      riskFlags: [
        'aggregated-route',
        'price_impact_unmeasured',
        'gas_limit_not_estimate',
        'expected_output_derived_from_slippage_floor',
        'public_mempool',
      ],
      usesExternalAggregators: true,
      sourceIndependence: 'overlapping',
    });
    return {
      outcome: 'quoted',
      candidate: artifacts.candidate,
      evidence: [artifacts.evidence],
    };
  }
}

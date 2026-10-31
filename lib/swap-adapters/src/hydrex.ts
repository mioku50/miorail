import type { GasEstimateV1, ProviderRefV1 } from '@mioagent/route-domain';
import { buildQuoteArtifacts } from './candidate.js';
import {
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
  protocolAllowsAdapter,
  providerFailure,
  QUOTE_PIN_REUSE_MS_V1,
  routablePairV1,
  supportsRoutableSwapIntentV1,
} from './normalization.js';
import { HydrexClientV1, type HydrexClientV1Options, type HydrexQuoteRequestV1 } from './hydrex-client.js';
import { parseHydrexQuoteV1 } from './hydrex-order.js';
import { HYDREX_BASE_ROUTER_PROXY_V1, createHydrexRouterPinReaderV1, type HydrexRouterPinReaderV1 } from './hydrex-pinned.js';
import type { SwapGasMeterV1 } from './swap-gas-meter.js';
import type { SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from './types.js';

export const HYDREX_PROVIDER_V1 = {
  id: 'hydrex', displayName: 'Hydrex', kind: 'aggregator', operator: 'Hydrex',
} as const satisfies ProviderRefV1;

const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export function hydrexQuoteRequestFromIntentV1(
  intent: SwapAdapterQuoteInput['intent'], walletAddress: `0x${string}`,
): HydrexQuoteRequestV1 | null {
  const from = intent.fromAsset;
  const to = intent.toAsset;
  if (
    !supportsRoutableSwapIntentV1(intent) || !from || !to ||
    from.kind !== 'erc20' || to.kind !== 'erc20' || !from.address || !to.address ||
    !routablePairV1(from, to)
  ) return null;
  const tokenIn = normalizeAddress(from.address);
  const tokenOut = normalizeAddress(to.address);
  if (!tokenIn || !tokenOut || (tokenIn !== BASE_USDC && tokenOut !== BASE_USDC)) return null;
  return {
    tokenIn, tokenOut, amount: intent.amount.amountAtomic, recipient: walletAddress,
    slippage: intent.slippageConstraint.maxBps,
  };
}

export interface HydrexSwapRouteAdapterOptions extends HydrexClientV1Options {
  client?: HydrexClientV1;
  pinReader?: HydrexRouterPinReaderV1 | null;
  rpcUrl?: string;
  /** Asked when `rpcUrl` does not answer a pin read. */
  fallbackRpcUrl?: string;
  freshnessTtlMs?: number;
  /** Measures the swap's gas, which Hydrex's quote does not state. Without
   * it the candidate carries the missing-gas sentinel and is not scored. */
  gasMeter?: SwapGasMeterV1 | null;
}

export class HydrexSwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'hydrex' as const;
  private readonly client: HydrexClientV1;
  private readonly pinReader: HydrexRouterPinReaderV1 | null;
  private readonly freshnessTtlMs: number;
  private readonly gasMeter: SwapGasMeterV1 | null;

  constructor(options: HydrexSwapRouteAdapterOptions = {}) {
    this.gasMeter = options.gasMeter ?? null;
    this.client = options.client ?? new HydrexClientV1(options);
    this.pinReader = options.pinReader ??
      (options.rpcUrl?.trim()
        ? createHydrexRouterPinReaderV1({
            rpcUrl: options.rpcUrl,
            fallbackRpcUrl: options.fallbackRpcUrl,
            cacheTtlMs: QUOTE_PIN_REUSE_MS_V1,
          })
        : null);
    this.freshnessTtlMs = options.freshnessTtlMs ?? 30_000;
  }

  supports(intent: SwapAdapterQuoteInput['intent']): boolean {
    return protocolAllowsAdapter(intent, this.id) && hydrexQuoteRequestFromIntentV1(intent, intent.walletAddress) !== null;
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    if (!this.supports(input.intent) || input.walletAddress.toLowerCase() !== input.intent.walletAddress) {
      return providerFailure(this.id, 'provider_unsupported_intent');
    }
    const request = hydrexQuoteRequestFromIntentV1(input.intent, input.walletAddress);
    if (!request) return providerFailure(this.id, 'provider_unsupported_intent');
    if (!this.pinReader) return providerFailure(this.id, 'provider_not_configured');
    // Asked together: the quote is a read and builds nothing, and in sequence
    // the router check and the API added their waits.
    const [outerPin, transport] = await Promise.all([this.pinReader.verify(), this.client.quote(request)]);
    if (!outerPin.ok) {
      return providerFailure(this.id, outerPin.reason === 'not_configured' ? 'provider_not_configured' :
        outerPin.reason === 'mismatch' ? 'provider_router_mismatch' : 'provider_unreachable');
    }
    if (transport.outcome !== 'response') {
      return providerFailure(this.id, transport.outcome === 'timeout' ? 'provider_timeout' :
        transport.outcome === 'rate_limited' ? 'provider_rate_limited' : 'provider_unreachable', transport.status ?? undefined);
    }
    const parsed = parseHydrexQuoteV1({
      payload: transport.payload, request, inputAsset: input.intent.fromAsset!,
      outputAsset: input.intent.toAsset!, now: input.now,
    });
    if (!parsed.ok) return providerFailure(this.id, parsed.errorCode);
    // The upstream check and the gas measurement are independent reads.
    const [routePin, measuredGas] = await Promise.all([
      this.pinReader.verifyUpstream(parsed.value.upstreamRouter),
      this.gasMeter
        ? this.gasMeter
            .measure({
              walletAddress: input.walletAddress,
              approval: { token: request.tokenIn, spender: HYDREX_BASE_ROUTER_PROXY_V1, amountAtomic: request.amount },
              call: parsed.value.swapCall,
            })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!routePin.ok) {
      return providerFailure(this.id, routePin.reason === 'mismatch' ? 'provider_router_mismatch' : 'provider_unreachable');
    }
    const observedAt = input.now.toISOString();
    const providerDeadlineMs = Number(BigInt(parsed.value.deadline) * 1000n);
    const expiresAt = new Date(Math.min(providerDeadlineMs, input.now.getTime() + this.freshnessTtlMs)).toISOString();
    // The provider supplies no estimate, so it is measured by simulating this
    // wallet's approval and swap. When that is not possible, zero is V1's
    // missing-evidence sentinel: Route Engine does not score it and the
    // clients render "Not provided".
    const gas: GasEstimateV1 = measuredGas ?? {
      gasUnits: '0', maxFeePerGasWei: null, estimatedCostNative: null, estimatedCostUsd: null,
    };
    const artifacts = buildQuoteArtifacts({
      adapterId: this.id,
      intent: input.intent,
      provider: HYDREX_PROVIDER_V1,
      requestId: input.requestId,
      providerQuoteId: null,
      requestHash: canonicalRequestHash(this.id, transport.safeRequest),
      responseHash: canonicalResponseHash(this.id, parsed.value.safeResponse),
      expectedOutputAtomic: parsed.value.expectedOutputAtomic,
      providerMinimumOutputAtomic: parsed.value.minimumOutputAtomic,
      gas,
      priceImpactBps: null,
      observedAt,
      expiresAt,
      blockNumber: routePin.blockNumber,
      provenance: { pools: [], liquiditySources: parsed.value.liquiditySources },
      riskFlags: [
        'aggregated-route', 'price_impact_unmeasured', measuredGas ? 'gas_simulated' : 'gas_unmeasured',
        'nested_upstream_calldata', `hydrex_fee_${routePin.feeBps}_bps`,
      ],
      usesExternalAggregators: true,
      sourceIndependence: 'overlapping',
    });
    return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
  }
}

import type {
  AssetRefV1,
  GasEstimateV1,
  LiquiditySourceRefV1,
  PoolRefV1,
  ProviderRefV1,
} from '@mioagent/route-domain';
import { buildQuoteArtifacts } from './candidate.js';
import {
  canonicalRequestHash,
  canonicalResponseHash,
  normalizeAddress,
  protocolAllowsAdapter,
  providerFailure,
  routablePairV1,
  supportsRoutableSwapIntentV1,
} from './normalization.js';
import {
  BALANCER_QUOTE_TTL_MS_V1,
  BalancerClientV1,
  balancerSourceKeysV1,
  type BalancerClientV1Options,
  type BalancerPathV1,
} from './balancer-client.js';
import type { SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from './types.js';

export const BALANCER_PROVIDER_V1 = {
  id: 'balancer',
  displayName: 'Balancer',
  kind: 'dex',
  operator: 'Balancer DAO',
} as const satisfies ProviderRefV1;

export const BALANCER_BASE_USDC_V1 =
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;

export function balancerQuotePairV1(intent: SwapAdapterQuoteInput['intent']): {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fromAsset: AssetRefV1;
  toAsset: AssetRefV1;
} | null {
  const fromAsset = intent.fromAsset;
  const toAsset = intent.toAsset;
  if (
    !supportsRoutableSwapIntentV1(intent) ||
    !fromAsset ||
    !toAsset ||
    fromAsset.kind !== 'erc20' ||
    toAsset.kind !== 'erc20' ||
    !fromAsset.address ||
    !toAsset.address ||
    !routablePairV1(fromAsset, toAsset)
  ) return null;
  const tokenIn = normalizeAddress(fromAsset.address);
  const tokenOut = normalizeAddress(toAsset.address);
  if (!tokenIn || !tokenOut || (tokenIn !== BALANCER_BASE_USDC_V1 && tokenOut !== BALANCER_BASE_USDC_V1)) {
    return null;
  }
  return { tokenIn, tokenOut, fromAsset, toAsset };
}

function provenanceV1(
  paths: readonly BalancerPathV1[],
  assets: readonly [AssetRefV1, AssetRefV1],
): { pools: PoolRefV1[]; liquiditySources: LiquiditySourceRefV1[] } {
  const sourceKeys = balancerSourceKeysV1(paths);
  const pools = new Map<string, PoolRefV1>();
  const liquiditySources = new Map<string, LiquiditySourceRefV1>();
  let sourceIndex = 0;
  for (const path of paths) {
    for (const poolId of path.pools) {
      const address = `0x${poolId.slice(2, 42)}`.toLowerCase() as `0x${string}`;
      const sourceKey = sourceKeys[sourceIndex++]!;
      const protocol = `balancer-v${path.protocolVersion}`;
      if (!pools.has(address)) {
        pools.set(address, { chainId: 8453, address, protocol, feeBps: null, assets: [...assets] });
      }
      if (!liquiditySources.has(sourceKey)) {
        liquiditySources.set(sourceKey, {
          sourceKey,
          chainId: 8453,
          protocol,
          poolAddress: address,
          assets: [...assets],
          upstreamProvider: null,
        });
      }
    }
  }
  return { pools: [...pools.values()], liquiditySources: [...liquiditySources.values()] };
}

export interface BalancerSwapRouteAdapterOptions extends BalancerClientV1Options {
  client?: BalancerClientV1;
  quoteTtlMs?: number;
}

export class BalancerSwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'balancer' as const;
  private readonly client: BalancerClientV1;
  private readonly quoteTtlMs: number;

  constructor(options: BalancerSwapRouteAdapterOptions = {}) {
    this.client = options.client ?? new BalancerClientV1(options);
    this.quoteTtlMs = options.quoteTtlMs ?? BALANCER_QUOTE_TTL_MS_V1;
  }

  supports(intent: SwapAdapterQuoteInput['intent']): boolean {
    return protocolAllowsAdapter(intent, this.id) && balancerQuotePairV1(intent) !== null;
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    if (!this.supports(input.intent) || input.walletAddress.toLowerCase() !== input.intent.walletAddress) {
      return providerFailure(this.id, 'provider_unsupported_intent');
    }
    const pair = balancerQuotePairV1(input.intent);
    if (!pair) return providerFailure(this.id, 'provider_unsupported_intent');
    const result = await this.client.quoteExactIn({
      tokenIn: pair.tokenIn,
      tokenOut: pair.tokenOut,
      amountHuman: input.intent.amount.amountDecimal,
      amountAtomic: input.intent.amount.amountAtomic,
    });
    if (!result.ok) {
      return providerFailure(
        this.id,
        result.reason === 'timeout' ? 'provider_timeout' :
          result.reason === 'rate_limited' ? 'provider_rate_limited' :
            result.reason === 'no_route' ? 'provider_no_route' :
              result.reason === 'invalid_response' ? 'provider_invalid_schema' : 'provider_unreachable',
      );
    }
    const observedAt = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + this.quoteTtlMs).toISOString();
    const gas: GasEstimateV1 = {
      gasUnits: '0',
      maxFeePerGasWei: null,
      estimatedCostNative: null,
      estimatedCostUsd: null,
    };
    const protocolVersion = result.quote.protocolVersion;
    const artifacts = buildQuoteArtifacts({
      adapterId: this.id,
      intent: input.intent,
      provider: BALANCER_PROVIDER_V1,
      requestId: input.requestId,
      providerQuoteId: null,
      requestHash: canonicalRequestHash(this.id, {
        chain: 'BASE', tokenIn: pair.tokenIn, tokenOut: pair.tokenOut,
        swapType: 'EXACT_IN', swapAmount: input.intent.amount.amountDecimal,
      }),
      responseHash: canonicalResponseHash(this.id, result.quote.safeResponse),
      expectedOutputAtomic: result.quote.expectedOutputAtomic,
      gas,
      priceImpactBps: null,
      observedAt,
      expiresAt,
      blockNumber: null,
      provenance: provenanceV1(result.quote.paths, [pair.fromAsset, pair.toAsset]),
      riskFlags: [
        'gas_unmeasured',
        ...(result.quote.rawPriceImpact === null ? ['price_impact_unmeasured'] : []),
        `balancer_v${protocolVersion}`,
      ],
      usesExternalAggregators: false,
      sourceIndependence: 'independent',
      callCount: protocolVersion === 3 ? 3 : 2,
      approvalCount: protocolVersion === 3 ? 2 : 1,
      integrationKind: 'onchain_read',
    });
    return { outcome: 'quoted', candidate: artifacts.candidate, evidence: [artifacts.evidence] };
  }
}

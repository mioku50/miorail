import type { AssetRefV1, LiquiditySourceRefV1, PoolRefV1, ProviderRefV1 } from '@mioagent/route-domain';
import { resolveRouteAssetV1 } from '@mioagent/intent-engine';
import { buildQuoteArtifacts } from './candidate.js';
import {
  AERODROME_MAX_HOPS_V1,
  AERODROME_QUOTE_TTL_MS_DEFAULT_V1,
  AERODROME_ROUTER_V1,
  AERODROME_WETH_V1,
  aerodromeSourceKeyV1,
  candidateRoutesV1,
  type AerodromeRouteLegV1,
} from './aerodrome-pinned.js';
import { createAerodromeReaderV1, type AerodromeReaderV1 } from './aerodrome-client.js';
import {
  canonicalRequestHash,
  canonicalResponseHash,
  protocolAllowsAdapter,
  providerFailure,
  normalizeCaughtProviderError,
  resolveQuoteTimes,
  supportsSwapIntent,
} from './normalization.js';
import type { SwapAdapterQuoteInput, SwapAdapterResult, SwapRouteAdapter } from './types.js';

// ---------------------------------------------------------------------------
// T67B — the Aerodrome adapter.
//
// The first swap adapter in this repository with no partner API behind it.
// Everything comes from the official Router over Base RPC, which changes what
// the trust story is: there is no aggregator whose numbers we have to believe,
// and no key to leak. What there is instead is an address that has to be
// right, and a quote that is only as good as the block it was read at.
//
// Three consequences shape this file.
//
//   1. THE ROUTER IS ASKED, NOT TOLD. Aerodrome exposes both stable and
//      volatile pools for the same pair, and neither is knowable in advance.
//      Every allowed route is quoted and the largest output wins. Nothing here
//      guesses which curve a pair belongs on.
//
//   2. A REVERT IS AN ANSWER. `getAmountsOut` reverts when a pool does not
//      exist. That is "no route", reported as an ordinary unavailable outcome
//      — not a transport error, not a retry.
//
//   3. PRICE IMPACT IS NOT AVAILABLE, AND IS NOT INVENTED. The Router returns
//      amounts, not a mid-price, so there is nothing to compare an execution
//      price against without reading reserves. It is reported as 0 bps with
//      the `price_impact_unmeasured` risk flag, so scoring and the Route Card
//      both see that this dimension was never measured. A fabricated figure
//      here would be indistinguishable from a real one.
// ---------------------------------------------------------------------------

export const AERODROME_PROVIDER_V1 = {
  id: 'aerodrome',
  displayName: 'Aerodrome',
  kind: 'dex',
  operator: 'Aerodrome Finance',
} as const satisfies ProviderRefV1;

export interface AerodromeSwapRouteAdapterOptions {
  /** Injected so unit tests never open a socket. */
  reader?: AerodromeReaderV1 | null;
  rpcUrl?: string;
  quoteTtlMs?: number;
  /** Gas units for the swap, by hop count. An ESTIMATE, and the candidate
   * carries no fee data because the Router cannot supply one. */
  gasUnitsPerHop?: number;
}

/** Aerodrome quotes WETH. A native-ETH leg is the same pool with a wrap in
 * front of it, so the quote is identical and the wrap is an execution concern. */
function poolTokenV1(asset: { kind: string; address: string | null }): `0x${string}` | null {
  if (asset.kind === 'native') return AERODROME_WETH_V1;
  return asset.address ? (asset.address.toLowerCase() as `0x${string}`) : null;
}

function legProtocolV1(leg: AerodromeRouteLegV1): string {
  return leg.stable ? 'aerodrome-stable' : 'aerodrome-volatile';
}

/**
 * Provenance for a quoted route.
 *
 * The POOL ADDRESSES ARE NOT CLAIMED. `getAmountsOut` returns amounts and
 * nothing else, so this adapter knows the token pair and the curve of each hop
 * but not the address of the pool that priced it. `pools` therefore stays
 * empty and the liquidity sources name the pair and curve instead. Putting a
 * computed CREATE2 address here would assert something never read from chain.
 */
function provenanceV1(
  route: readonly AerodromeRouteLegV1[],
  assets: readonly [AssetRefV1, AssetRefV1],
): { pools: PoolRefV1[]; liquiditySources: LiquiditySourceRefV1[] } {
  const chainId = assets[0].chainId;
  // Every token in a route is either one of the intent's own assets or one of
  // the two pinned intermediates, so each leg can be named with real
  // AssetRefV1s rather than bare addresses.
  const known = new Map<string, AssetRefV1>();
  for (const asset of assets) {
    if (asset.address) known.set(asset.address.toLowerCase(), asset);
    // A native-ETH leg is quoted as WETH, so the WETH ref stands in for it.
    if (asset.kind === 'native') {
      const weth = resolveRouteAssetV1(AERODROME_WETH_V1);
      if (weth) known.set(AERODROME_WETH_V1, weth);
    }
  }
  const assetFor = (address: string): AssetRefV1 | null =>
    known.get(address.toLowerCase()) ?? resolveRouteAssetV1(address);

  return {
    pools: [],
    liquiditySources: route.map((leg) => {
      const legAssets = [assetFor(leg.from), assetFor(leg.to)].filter(
        (asset): asset is AssetRefV1 => asset !== null,
      );
      return {
        // Carries the factory as well as the pair and curve: prepare re-derives
        // the exact legs from this key, and a Router that has since changed its
        // default factory must not be able to pass as the same route.
        sourceKey: aerodromeSourceKeyV1(leg),
        chainId,
        protocol: legProtocolV1(leg),
        poolAddress: null,
        // The contract requires at least one named asset. Every token this
        // adapter routes through is canonical, so an empty list would mean the
        // route contained something it is not allowed to contain.
        assets: legAssets.length > 0 ? legAssets : [assets[0]],
        upstreamProvider: null,
      };
    }),
  };
}

export class AerodromeSwapRouteAdapter implements SwapRouteAdapter {
  readonly id = 'aerodrome' as const;
  private readonly options: AerodromeSwapRouteAdapterOptions;

  constructor(options: AerodromeSwapRouteAdapterOptions = {}) {
    this.options = options;
  }

  supports(intent: Parameters<SwapRouteAdapter['supports']>[0]): boolean {
    return supportsSwapIntent(intent) && protocolAllowsAdapter(intent, this.id);
  }

  async quote(input: SwapAdapterQuoteInput): Promise<SwapAdapterResult> {
    const { intent } = input;
    if (!this.supports(intent)) return providerFailure(this.id, 'provider_unsupported_intent');

    const fromAsset = intent.fromAsset;
    const toAsset = intent.toAsset;
    if (!fromAsset || !toAsset) return providerFailure(this.id, 'provider_unsupported_intent');

    const from = poolTokenV1(fromAsset);
    const to = poolTokenV1(toAsset);
    if (!from || !to) return providerFailure(this.id, 'provider_unsupported_intent');
    // ETH → WETH is a wrap, not a swap. Aerodrome has no pool for it and
    // quoting one would produce a route that cannot exist.
    if (from === to) return providerFailure(this.id, 'provider_unsupported_intent');

    const reader =
      this.options.reader ??
      (this.options.rpcUrl
        ? createAerodromeReaderV1({ rpcUrl: this.options.rpcUrl })
        : null);
    if (!reader) return providerFailure(this.id, 'provider_not_configured');

    try {
      const factory = await reader.readDefaultFactory();
      if (!factory.ok) {
        return providerFailure(
          this.id,
          factory.reason === 'not_configured' ? 'provider_not_configured' : 'provider_unreachable',
        );
      }

      const amountIn = BigInt(intent.amount.amountAtomic);
      const routes = candidateRoutesV1({ from, to, factory: factory.value }).filter(
        (route) => route.length <= AERODROME_MAX_HOPS_V1,
      );

      let best: { route: AerodromeRouteLegV1[]; amounts: bigint[] } | null = null;
      let sawTransportFailure = false;
      for (const route of routes) {
        const quoted = await reader.readAmountsOut({ amountIn, route });
        if (!quoted.ok) {
          // `no_route` is expected for most combinations — most pairs do not
          // have all four stable/volatile permutations. Anything else means
          // the endpoint itself is in trouble, and is remembered so an
          // all-empty result is not reported as "no liquidity".
          if (quoted.reason !== 'no_route' && quoted.reason !== 'invalid_response') {
            sawTransportFailure = true;
          }
          continue;
        }
        const output = quoted.value[quoted.value.length - 1] ?? 0n;
        const bestOutput = best ? (best.amounts[best.amounts.length - 1] ?? 0n) : 0n;
        // Strictly greater, so the FIRST route wins a tie — and candidateRoutes
        // lists direct pools first. A one-hop route that ties a two-hop route
        // is the better trade at equal output: fewer pools, less gas, less to
        // go wrong.
        if (output > bestOutput) best = { route, amounts: quoted.value };
      }

      if (!best) {
        return providerFailure(
          this.id,
          sawTransportFailure ? 'provider_unreachable' : 'provider_no_route',
        );
      }

      const blockNumber = await reader.readBlockNumber();
      const expectedOutputAtomic = (best.amounts[best.amounts.length - 1] as bigint).toString();
      // The Router stamps no time on a quote, so both come from the local
      // clock plus the TTL. A window that has already closed is refused rather
      // than shipped as a fresh quote.
      const times = resolveQuoteTimes({
        now: input.now,
        fallbackTtlMs: this.options.quoteTtlMs ?? AERODROME_QUOTE_TTL_MS_DEFAULT_V1,
      });
      if (!times) return providerFailure(this.id, 'provider_expired_quote');

      const request = {
        router: AERODROME_ROUTER_V1,
        chainId: 8453,
        amountIn: intent.amount.amountAtomic,
        route: best.route.map((leg) => ({ from: leg.from, to: leg.to, stable: leg.stable })),
      };
      const response = {
        amounts: best.amounts.map((amount) => amount.toString()),
        blockNumber,
      };

      const gasUnits = String((this.options.gasUnitsPerHop ?? 180_000) * best.route.length);

      const { candidate, evidence } = buildQuoteArtifacts({
        adapterId: this.id,
        intent,
        provider: AERODROME_PROVIDER_V1,
        requestId: input.requestId,
        // The Router issues no quote id. The response hash is the identifier,
        // which is honest: this quote is exactly the numbers that came back.
        providerQuoteId: null,
        requestHash: canonicalRequestHash(this.id, request),
        responseHash: canonicalResponseHash(this.id, response),
        expectedOutputAtomic,
        // The Router applies no slippage of its own — the minimum comes from
        // the user's own constraint, derived in buildQuoteArtifacts.
        providerMinimumOutputAtomic: null,
        gas: {
          gasUnits,
          maxFeePerGasWei: null,
          estimatedCostNative: null,
          estimatedCostUsd: null,
        },
        // Not measured. See the header: the Router returns amounts, not a
        // reference price, and a fabricated figure would look identical to a
        // real one on the Route Card.
        priceImpactBps: 0,
        observedAt: times.observedAt,
        expiresAt: times.expiresAt,
        blockNumber,
        provenance: provenanceV1(best.route, [fromAsset, toAsset]),
        riskFlags: [
          'price_impact_unmeasured',
          ...(best.route.length > 1 ? ['multi_hop_route'] : []),
          ...(best.route.some((leg) => leg.stable) ? ['stable_pool_curve'] : []),
        ],
        // No aggregator is involved: this is a direct contract read.
        usesExternalAggregators: false,
        sourceIndependence: 'independent',
      });

      return { outcome: 'quoted', candidate, evidence: [evidence] };
    } catch (error) {
      return normalizeCaughtProviderError(this.id, error);
    }
  }
}

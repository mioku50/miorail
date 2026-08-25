import {
  AssetRefV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  assetIdV1,
  hashRouteIntentV1,
  type AssetRefV1,
  type EvidenceRecordV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import {
  CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1,
  CashExitMeasurementRunV1Schema,
  CashExitSourceObservationV1Schema,
  hashCashExitObservationV1,
  hashCashExitRunV1,
  type CashExitMeasurementRunV1,
  type CashExitQuoteLegV1,
  type CashExitSourceObservationV1,
  type OfficialCashExitRepositoryV1,
} from '@mioagent/route-storage';
import type { SwapAdapterResult, SwapRouteAdapter } from '@mioagent/swap-adapters';

const USDC = AssetRefV1Schema.parse({
  assetId: assetIdV1({
    chainId: 8453,
    kind: 'erc20',
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  }),
  chainId: 8453,
  kind: 'erc20',
  address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  symbol: 'USDC',
  decimals: 6,
});
const WETH = AssetRefV1Schema.parse({
  assetId: assetIdV1({
    chainId: 8453,
    kind: 'erc20',
    address: '0x4200000000000000000000000000000000000006',
  }),
  chainId: 8453,
  kind: 'erc20',
  address: '0x4200000000000000000000000000000000000006',
  symbol: 'WETH',
  decimals: 18,
});

function decimalV1(atomic: string, decimals: number): string {
  const padded = atomic.padStart(decimals + 1, '0');
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
  const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function intentV1(input: {
  id: string;
  tenantId: string;
  walletAddress: `0x${string}`;
  from: AssetRefV1;
  to: AssetRefV1;
  amountAtomic: string;
  now: Date;
  source: string;
}): RouteIntentV1 {
  const timestamp = input.now.toISOString();
  const draft: RouteIntentV1 = {
    schemaVersion: 'route-intent/v1',
    id: input.id,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    chainId: 8453,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'ready',
    intentHash: ZERO_HASH_V1,
    goal: 'swap',
    fromAsset: input.from,
    toAsset: input.to,
    amount: {
      asset: input.from,
      amountAtomic: input.amountAtomic,
      amountDecimal: decimalV1(input.amountAtomic, input.from.decimals),
    },
    optimizationMode: 'best_net_result',
    verificationDepth: 'maximum',
    protocolConstraint: { mode: 'include_only', protocols: [input.source] },
    slippageConstraint: { maxBps: 100, source: 'policy' },
    executionRequested: false,
  };
  return RouteIntentV1Schema.parse({ ...draft, intentHash: hashRouteIntentV1(draft) });
}

function quoteLegV1(
  direction: 'buy' | 'sell',
  candidate: RouteCandidateV1,
  evidence: EvidenceRecordV1,
): CashExitQuoteLegV1 {
  return {
    direction,
    inputAddress: candidate.inputAmount.asset.address!,
    outputAddress: candidate.expectedOutput.asset.address!,
    inputAtomic: candidate.inputAmount.amountAtomic,
    outputAtomic: candidate.expectedOutput.amountAtomic,
    routeKey: candidate.candidateHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: evidence.evidenceHash,
    observedAt: candidate.quoteObservedAt,
    expiresAt: candidate.quoteExpiresAt,
    blockNumber: evidence.blockNumber,
    liquiditySources: candidate.liquiditySources.map((source) => source.sourceKey).sort(),
  };
}

function explicitNoRouteV1(result: SwapAdapterResult): boolean {
  return result.outcome !== 'quoted' && result.errorCode === 'provider_no_route';
}

async function quoteV1(
  adapter: SwapRouteAdapter,
  input: {
    tenantId: string;
    walletAddress: `0x${string}`;
    from: AssetRefV1;
    to: AssetRefV1;
    amountAtomic: string;
    requestId: string;
    now: Date;
  },
): Promise<SwapAdapterResult> {
  const intent = intentV1({
    id: `cash-exit:${input.requestId}`,
    tenantId: input.tenantId,
    walletAddress: input.walletAddress,
    from: input.from,
    to: input.to,
    amountAtomic: input.amountAtomic,
    now: input.now,
    source: adapter.id,
  });
  return adapter.quote({
    intent,
    walletAddress: input.walletAddress,
    requestId: input.requestId,
    now: input.now,
  });
}

export async function measureOfficialCashExitV1(input: {
  repository: OfficialCashExitRepositoryV1;
  adapters: readonly SwapRouteAdapter[];
  token: { address: `0x${string}`; symbol: string; decimals: number };
  walletAddress: `0x${string}`;
  tenantId: string;
  scope: 'public_ladder' | 'tenant_position';
  cashSizesAtomic?: readonly string[];
  positionTokenAtomic?: string;
  destinations?: readonly ('USDC' | 'ETH')[];
  now?: () => Date;
  negativeEvidenceTtlMs?: number;
}): Promise<CashExitMeasurementRunV1> {
  if (input.adapters.length === 0)
    throw new TypeError('cash-exit measurement requires an explicit approved-router set');
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const destinations = [
    ...new Set<'USDC' | 'ETH'>(input.destinations ?? (['USDC', 'ETH'] as const)),
  ];
  const tenantId = input.scope === 'tenant_position' ? input.tenantId : null;
  const sizes =
    input.scope === 'public_ladder'
      ? [...(input.cashSizesAtomic ?? CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1)]
      : [input.positionTokenAtomic ?? '0'];
  if (sizes.some((size) => !/^[1-9][0-9]*$/.test(size)))
    throw new TypeError('cash-exit sizes must be exact positive atomic amounts');
  const approvedSources = input.adapters.map((adapter) => adapter.id).sort();
  if (new Set(approvedSources).size !== approvedSources.length)
    throw new TypeError('cash-exit approved-router ids must be unique');
  const runId = hashCashExitRunV1({
    schemaVersion: 'official-cash-exit-run/v1',
    chainId: 8453,
    tokenAddress: input.token.address.toLowerCase(),
    scope: input.scope,
    tenantId,
    approvedSources,
    destinations,
    startedAt,
    completedAt: startedAt,
    observations: [] as never,
  });
  const token = AssetRefV1Schema.parse({
    assetId: assetIdV1({ chainId: 8453, kind: 'erc20', address: input.token.address }),
    chainId: 8453,
    kind: 'erc20',
    address: input.token.address,
    symbol: input.token.symbol,
    decimals: input.token.decimals,
  });
  const observations: CashExitSourceObservationV1[] = [];
  const negativeTtl = input.negativeEvidenceTtlMs ?? 60_000;

  for (const size of sizes) {
    for (const adapter of input.adapters) {
      let buy: SwapAdapterResult | null = null;
      let testedTokenAtomic = input.scope === 'tenant_position' ? size : null;
      if (input.scope === 'public_ladder') {
        const quoteNow = now();
        buy = await quoteV1(adapter, {
          tenantId: input.tenantId,
          walletAddress: input.walletAddress,
          from: USDC,
          to: token,
          amountAtomic: size,
          requestId: `${runId}:buy:${size}:${adapter.id}`,
          now: quoteNow,
        });
        if (buy.outcome === 'quoted') testedTokenAtomic = buy.candidate.expectedOutput.amountAtomic;
      }
      for (const destination of destinations) {
        const destinationAsset = destination === 'USDC' ? USDC : WETH;
        const observedAt = now();
        let status: CashExitSourceObservationV1['status'];
        let errorCode: string | null = null;
        let sell: SwapAdapterResult | null = null;
        if (buy && buy.outcome !== 'quoted') {
          // A missing BUY route means the cash-denominated sizing instrument
          // could not establish an exact token amount. It proves nothing about
          // selling an already-held position, so it is never `unavailable`.
          status = 'measurement_failed';
          errorCode = explicitNoRouteV1(buy) ? 'cash_size_anchor_no_route' : buy.errorCode;
        } else {
          sell = await quoteV1(adapter, {
            tenantId: input.tenantId,
            walletAddress: input.walletAddress,
            from: token,
            to: destinationAsset,
            amountAtomic: testedTokenAtomic!,
            requestId: `${runId}:sell:${size}:${destination}:${adapter.id}`,
            now: observedAt,
          });
          if (sell.outcome === 'quoted') status = 'full';
          else if (explicitNoRouteV1(sell)) {
            status = input.scope === 'public_ladder' ? 'buy_only' : 'unavailable';
            errorCode = sell.errorCode;
          } else {
            status = 'measurement_failed';
            errorCode = sell.errorCode;
          }
        }
        const buyQuote =
          buy?.outcome === 'quoted' ? quoteLegV1('buy', buy.candidate, buy.evidence[0]!) : null;
        const sellQuote =
          sell?.outcome === 'quoted' ? quoteLegV1('sell', sell.candidate, sell.evidence[0]!) : null;
        const quoteExpiries = [buyQuote?.expiresAt, sellQuote?.expiresAt].filter(
          (value): value is string => Boolean(value),
        );
        const expiry =
          quoteExpiries.length > 0
            ? quoteExpiries.sort()[0]!
            : new Date(observedAt.getTime() + negativeTtl).toISOString();
        const draft: CashExitSourceObservationV1 = {
          schemaVersion: 'official-cash-exit-observation/v1',
          observationHash: ZERO_HASH_V1,
          runId,
          chainId: 8453,
          tokenAddress: token.address!,
          tokenSymbol: token.symbol,
          tokenDecimals: token.decimals,
          scope: input.scope,
          tenantId,
          sizeKind: input.scope === 'public_ladder' ? 'cash_equivalent' : 'actual_position',
          requestedCashAtomic: input.scope === 'public_ladder' ? size : null,
          requestedTokenAtomic: input.scope === 'tenant_position' ? size : null,
          testedTokenAtomic,
          destination,
          destinationAddress: destinationAsset.address!,
          destinationDecimals: destinationAsset.decimals,
          source: adapter.id,
          status,
          evidenceStrength: 'router_quote',
          executionProven: false,
          buyQuote,
          sellQuote,
          errorCode,
          observedAt: observedAt.toISOString(),
          expiresAt: expiry,
        };
        observations.push(
          CashExitSourceObservationV1Schema.parse({
            ...draft,
            observationHash: hashCashExitObservationV1(draft),
          }),
        );
      }
    }
  }
  const run = CashExitMeasurementRunV1Schema.parse({
    schemaVersion: 'official-cash-exit-run/v1',
    runId,
    chainId: 8453,
    tokenAddress: token.address!,
    scope: input.scope,
    tenantId,
    approvedSources,
    destinations,
    startedAt,
    completedAt: now().toISOString(),
    observations,
  });
  await input.repository.recordCompletedRun(run);
  return run;
}

import {
  AssetRefV1Schema,
  RouteIntentV1Schema,
  ZERO_HASH_V1,
  assetIdV1,
  hashRouteIntentV1,
  stableHashV1,
  type AssetRefV1,
  type EvidenceRecordV1,
  type RouteCandidateV1,
  type RouteIntentV1,
} from '@mioagent/route-domain';
import {
  CASH_EXIT_DEFAULT_USDC_SIZES_ATOMIC_V1,
  CashExitMeasurementRunV1Schema,
  CashExitSourceObservationV1Schema,
  MarketRealityEvidenceSnapshotV1Schema,
  hashMarketRealityEvidenceSnapshotV1,
  hashCashExitObservationV1,
  hashCashExitRunV1,
  type CashExitMeasurementRunV1,
  type CashExitQuoteLegV1,
  type CashExitSourceObservationV1,
  type OfficialCashExitRepositoryV1,
  type MarketRealityEvidenceSnapshotV1,
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

function defaultMarketRealitySnapshotsV1(input: {
  run: CashExitMeasurementRunV1;
  capturedAt: string;
}): MarketRealityEvidenceSnapshotV1[] {
  const routePolicyKey = stableHashV1('market-reality-route-policy/v1', {
    chainId: 8453,
    approvedSources: [...input.run.approvedSources].sort(),
    destinations: [...input.run.destinations].sort(),
  });
  return input.run.observations.flatMap((observation) =>
    (['buy', 'sell'] as const).map((direction) => {
      const quote = direction === 'buy' ? observation.buyQuote : observation.sellQuote;
      const marketStatus = quote
        ? ('quoted' as const)
        : observation.errorCode === 'cash_size_anchor_no_route'
          ? direction === 'buy'
            ? ('no_route' as const)
            : ('unsized' as const)
          : direction === 'sell' && ['buy_only', 'unavailable'].includes(observation.status)
            ? ('no_route' as const)
            : ('measurement_failed' as const);
      const reason =
        marketStatus === 'no_route'
          ? {
              reasonCode: 'no_route' as const,
              reason: 'No approved route returned a quote for this exact question.',
            }
          : marketStatus === 'unsized'
            ? {
                reasonCode: 'unsized_sell' as const,
                reason: 'SELL was not sized after the exact BUY sizing anchor failed.',
              }
            : marketStatus === 'measurement_failed'
              ? {
                  reasonCode: 'measurement_failed' as const,
                  reason: 'The market measurement failed; no asset-price claim was made.',
                }
              : {
                  reasonCode: 'unreviewed_issuer_reference' as const,
                  reason: 'No reviewed representation/reference capture adapter was supplied.',
                };
      const content: Omit<MarketRealityEvidenceSnapshotV1, 'snapshotHash'> = {
        schemaVersion: 'market-reality-evidence-snapshot/v1',
        runId: input.run.runId,
        observationHash: observation.observationHash,
        chainId: 8453,
        tokenAddress: observation.tokenAddress,
        issuerId: null,
        issuerInstrumentKey: null,
        representationKind: null,
        direction,
        requestedCashAtomic: observation.requestedCashAtomic,
        requestedTokenAtomic: observation.requestedTokenAtomic,
        testedTokenAtomic: observation.testedTokenAtomic,
        destination: observation.destination,
        destinationAddress: observation.destinationAddress,
        destinationDecimals: observation.destinationDecimals,
        source: observation.source,
        approvedSources: [...input.run.approvedSources].sort(),
        routePolicyKey,
        marketStatus,
        marketObservedAt: quote?.observedAt ?? observation.observedAt,
        marketExpiresAt: quote?.expiresAt ?? observation.expiresAt,
        normalizedExposureAtomic: null,
        normalizedExposureDecimals: null,
        normalization: 'not_established',
        ratio: null,
        supply: {
          state: 'supply_unknown',
          totalSupplyAtomic: null,
          decimals: null,
          blockNumber: null,
          blockHash: null,
          evidenceHash: null,
          observedAt: null,
          readOutcome: 'not_observed',
        },
        effectivePriceAtomic: null,
        effectivePriceDecimals: null,
        reference: {
          status: 'unknown',
          session: 'unknown',
          marketSession: 'unknown',
          publicationMode: 'unknown',
          valueAtomic: null,
          decimals: null,
          observedAt: input.capturedAt,
          referenceUpdatedAt: null,
          freshness: 'unknown',
          referenceSource: null,
          referenceAddress: null,
          calendar: null,
          evidence: null,
          comparable: false,
          reasonCode: 'reference_adapter_not_configured',
          reason: 'No reviewed reference capture adapter answered for this measurement.',
        },
        basis: {
          policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
          status: 'withheld',
          kind: 'withheld',
          premiumDiscountBps: null,
          ...reason,
        },
        capturedAt: input.capturedAt,
      };
      return MarketRealityEvidenceSnapshotV1Schema.parse({
        ...content,
        snapshotHash: hashMarketRealityEvidenceSnapshotV1(content),
      });
    }),
  );
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
  /** Optional enrichment boundary. Absence still records an explicit UNKNOWN
   * snapshot; production Market Reality call sites provide the reviewed
   * exact-address capture adapter. */
  captureMarketRealitySnapshots?: (
    run: CashExitMeasurementRunV1,
  ) => Promise<MarketRealityEvidenceSnapshotV1[]>;
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
  const draftRun = CashExitMeasurementRunV1Schema.parse({
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
  const capturedAt = now().toISOString();
  const marketRealitySnapshots = input.captureMarketRealitySnapshots
    ? await input.captureMarketRealitySnapshots(draftRun)
    : defaultMarketRealitySnapshotsV1({ run: draftRun, capturedAt });
  const run = CashExitMeasurementRunV1Schema.parse({
    ...draftRun,
    completedAt: capturedAt,
    marketRealitySnapshots,
  });
  await input.repository.recordCompletedRun(run);
  return run;
}

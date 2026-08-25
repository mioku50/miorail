import type { B20ReaderV1 } from '@mioagent/b20-control';
import { OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 } from '@mioagent/market-tail';
import type {
  CashExitMeasurementRunV1,
  CashExitSourceObservationV1,
} from '@mioagent/route-storage';
import type {
  LookalikeAliasKindV1,
  MarketTailRepositoryV1,
  OfficialAssetIdentityV1,
  OfficialAssetRepositoryV1,
  OfficialCashExitRepositoryV1,
  OfficialLookalikeRepositoryV1,
  OfficialSourceKindV1,
  RwaSignalRepositoryV1,
} from '@mioagent/route-storage';
import { isOfficialV1 } from '@mioagent/route-storage';

import type { ExecutableValueV1 } from './contracts.js';
import {
  LOOKALIKE_DISCLAIMER_V1,
  OfficialAssetsOverviewV1Schema,
  OfficialLookalikeFeedV1Schema,
  RWA_SIGNALS_NOT_REPORTED_V1,
  RwaSignalFeedV1Schema,
  type OfficialAssetMarketV1,
  type OfficialAssetSummaryV1,
  type OfficialCashExitRungPreviewV1,
  type OfficialAssetsOverviewV1,
  type OfficialLookalikeFeedV1,
  type OfficialRouteStatusV1,
  type RwaSignalFeedV1,
} from './discover.js';
import {
  compareReferenceAndExecutableV1,
  readTokenizedStockReferenceV1,
  unavailableTokenizedStockReferenceV1,
} from './reference.js';

// ---------------------------------------------------------------------------
// The three Discover reads, assembled from stored evidence.
//
// One live thing happens here and it is named: the reference feed is read at a
// block anchor, because a price from an hour ago shown without its age is the
// oldest lie in this category. Everything else -- membership, ladders, venue
// movements, resemblances, transitions -- is what a worker already wrote down.
//
// The reason that boundary matters for a LIST is arithmetic. The per-asset
// dossier spends roughly a dozen chain reads; thirteen of those on one page
// would be a hundred and sixty against an endpoint that serves about half a
// call a second. A surface that slow gets a cache in front of it, and a cached
// measurement with no age on it is the thing this whole vertical exists to
// stop shipping.
// ---------------------------------------------------------------------------

export interface OfficialDiscoverDepsV1 {
  official: OfficialAssetRepositoryV1;
  cashExit: OfficialCashExitRepositoryV1;
  marketTail: MarketTailRepositoryV1;
  lookalikes: OfficialLookalikeRepositoryV1;
  signals: RwaSignalRepositoryV1;
  reader: B20ReaderV1;
  now: () => Date;
}

const SOURCE_URLS_V1: Readonly<Record<OfficialSourceKindV1, string>> = {
  base_docs_technical:
    'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.md',
  base_product_list: 'https://brand.base.org/stocks',
};

function currentTickerV1(identity: OfficialAssetIdentityV1): {
  ticker: string;
  displayName: string | null;
  listedIn: OfficialSourceKindV1[];
} {
  const listed = identity.listings.filter((listing) => listing.currentlyListed);
  const rows = listed.length > 0 ? listed : identity.listings;
  return {
    ticker: rows[0]!.ticker,
    displayName: rows.find((row) => row.displayName !== null)?.displayName ?? null,
    listedIn: [...new Set(listed.map((row) => row.sourceKind))].sort(),
  };
}

// ---------------------------------------------------------------------------
// WHY THIS DOES NOT REUSE `assembleCashExitLadderV1`
//
// That projection is freshness-gated on purpose: a router quote expires about
// twenty seconds after it is taken, and a rung whose quote has lapsed
// correctly projects as `not_measured`, because you cannot execute on it.
//
// Applied to a LIST, that rule erases the page. A run measured forty minutes
// ago would render thirteen assets as "not measured" -- which is exactly the
// sentence this tab exists to distinguish from "no route at the measured
// sizes", and which is false: we did measure, and we know what we found.
//
// The two questions are different. "Can I execute on this quote right now" is
// what the dossier's measure endpoint answers, and it re-quotes. "What did a
// round trip cost when somebody last looked" is what a list answers, and the
// answer keeps for hours -- measured on the launch corpus, the median
// round-trip cost moves by zero out to six hours.
//
// So the preview below reads the run's own observations and every card carries
// the measurement's AGE. It is a reading, never an offer: nothing on this
// surface leads to a signature, and "Find route" hands the address to the flow
// that quotes fresh.
// ---------------------------------------------------------------------------

/** The exact round-trip cost of one completed observation, in basis points.
 * Cash sizes only: a position-sized rung has no cash denominator. */
function roundTripCostBpsV1(observation: CashExitSourceObservationV1): string | null {
  const returned = observation.sellQuote?.outputAtomic ?? null;
  if (
    observation.status !== 'full' ||
    observation.destination !== 'USDC' ||
    observation.requestedCashAtomic === null ||
    returned === null
  ) {
    return null;
  }
  const requested = BigInt(observation.requestedCashAtomic);
  if (requested === BigInt(0)) return null;
  return (((requested - BigInt(returned)) * BigInt(10000)) / requested).toString();
}

/** The best observation at one size: a completed round trip returning the most,
 * or the strongest thing any approved source managed. */
function bestObservationV1(
  rows: readonly CashExitSourceObservationV1[],
): CashExitSourceObservationV1 {
  const rank = { full: 0, buy_only: 1, unavailable: 2, measurement_failed: 3 } as const;
  return [...rows].sort((left, right) => {
    const order = rank[left.status] - rank[right.status];
    if (order !== 0) return order;
    const leftOut = BigInt(left.sellQuote?.outputAtomic ?? '0');
    const rightOut = BigInt(right.sellQuote?.outputAtomic ?? '0');
    return leftOut < rightOut ? 1 : leftOut > rightOut ? -1 : left.source.localeCompare(right.source);
  })[0]!;
}

/**
 * The stored measurement, as a ladder preview.
 *
 * USDC only, exact sizes only, one rung per measured size, ordered smallest
 * first. Nothing is interpolated and nothing is carried between sizes here --
 * the dossier does that and labels it; a list showing a smaller rung's cost
 * under a larger size's heading is the one thing the preview must not do
 * silently.
 */
export function previewLadderFromRunV1(
  run: CashExitMeasurementRunV1 | null,
): OfficialCashExitRungPreviewV1[] {
  if (run === null) return [];
  const groups = new Map<string, CashExitSourceObservationV1[]>();
  for (const observation of run.observations) {
    if (observation.sizeKind !== 'cash_equivalent') continue;
    if (observation.destination !== 'USDC') continue;
    if (observation.requestedCashAtomic === null) continue;
    const key = observation.requestedCashAtomic;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (BigInt(left) < BigInt(right) ? -1 : 1))
    .map(([size, rows]) => {
      const best = bestObservationV1(rows);
      return {
        requestedCashAtomic: size,
        destination: 'USDC' as const,
        status: best.status,
        roundTripCostBps: roundTripCostBpsV1(best),
        derivedFromExactRung: false,
        lowerBoundRequestedCashAtomic: null,
      };
    });
}

/**
 * What the stored ladder says about a cash route, in one word.
 *
 * `full` at any measured size is a route. Every rung `unavailable` is the
 * finding the product is built on -- nine of thirteen official assets, and it
 * is a fact about the asset, not about us. An empty ladder is neither: nobody
 * has looked.
 */
export function routeStatusFromPreviewV1(
  rungs: readonly OfficialCashExitRungPreviewV1[],
): OfficialRouteStatusV1 {
  if (rungs.length === 0) return 'not_measured';
  if (rungs.some((rung) => rung.status === 'full' || rung.status === 'partial')) {
    return 'cash_route_established';
  }
  if (rungs.every((rung) => rung.status === 'not_measured')) return 'not_measured';
  // Every source failing is our outage; the router answering "no route" is the
  // asset's. They are never merged into one word.
  if (rungs.some((rung) => rung.status === 'measurement_failed')) return 'measurement_failed';
  return 'no_route_at_measured_sizes';
}

/** The executable value a card shows: the largest completed round trip. */
function executableFromRunV1(
  run: CashExitMeasurementRunV1 | null,
  rungs: readonly OfficialCashExitRungPreviewV1[],
): ExecutableValueV1 {
  const largest = rungs
    .filter((rung) => rung.status === 'full')
    .sort((left, right) =>
      BigInt(left.requestedCashAtomic) < BigInt(right.requestedCashAtomic) ? 1 : -1,
    )[0];
  if (run === null || !largest) {
    return {
      status: rungs.length === 0 ? 'not_measured' : 'unavailable',
      valueAtomic: null,
      decimals: null,
      requestedSizeAtomic: null,
      executableSizeAtomic: null,
      destination: null,
      observedAt: null,
      evidence: null,
    };
  }
  const observation = bestObservationV1(
    run.observations.filter(
      (row) =>
        row.sizeKind === 'cash_equivalent' &&
        row.destination === 'USDC' &&
        row.requestedCashAtomic === largest.requestedCashAtomic,
    ),
  );
  return {
    status: 'full',
    valueAtomic: observation.sellQuote?.outputAtomic ?? null,
    decimals: observation.destinationDecimals,
    requestedSizeAtomic: largest.requestedCashAtomic,
    executableSizeAtomic: observation.testedTokenAtomic,
    destination: 'USDC',
    observedAt: observation.observedAt,
    evidence: null,
  };
}

export async function assembleOfficialAssetsOverviewV1(
  deps: OfficialDiscoverDepsV1,
  input?: { limit?: number },
): Promise<OfficialAssetsOverviewV1> {
  const now = deps.now();
  const limit = Math.max(1, Math.min(64, input?.limit ?? 64));
  const [universe, discrepancies, lookalikeCounts, cursor] = await Promise.all([
    deps.official.officialAssets({ chainId: 8453, limit }),
    deps.official.sourceDiscrepancies({ chainId: 8453 }),
    deps.lookalikes.lookalikeCountsByOfficial({ chainId: 8453 }),
    deps.marketTail.readCursor({ tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 }),
  ]);
  const assets = universe.filter((identity) => isOfficialV1(identity));

  const sources = await Promise.all(
    (Object.keys(SOURCE_URLS_V1) as OfficialSourceKindV1[]).map(async (sourceKind) => {
      const [latest, ok] = await Promise.all([
        deps.official.latestSnapshot({ sourceKind }),
        deps.official.latestSnapshot({ sourceKind, successfulOnly: true }),
      ]);
      return {
        sourceKind,
        sourceUrl: latest?.sourceUrl ?? ok?.sourceUrl ?? SOURCE_URLS_V1[sourceKind],
        checkedAt: latest?.observedAt ?? null,
        status: latest?.status ?? null,
        assetCount: ok?.assetCount ?? null,
        lastSuccessfulAt: ok?.observedAt ?? null,
      };
    }),
  );

  // The tail's cursor is the bound on every "no movements observed". Without
  // it the sentence would be a claim about the market rather than about how
  // far we have read.
  const activity =
    cursor === null
      ? []
      : await deps.marketTail.venueActivity({
          chainId: 8453,
          tokenAddresses: assets.map((asset) => asset.tokenAddress),
          // Everything the tail has stored. The card shows a count, not a rate.
          sinceBlock: 0,
        });
  const activityByToken = new Map(activity.map((row) => [row.tokenAddress.toLowerCase(), row]));
  // Paired pools only. A singleton holds every v4 pool on Base, so counting it
  // per asset would credit this token with venues belonging to other tokens.
  const pools = cursor === null ? [] : await deps.marketTail.venues({ chainId: 8453, kinds: ['paired_pool'], limit: 1_000 });
  const poolsByToken = new Map<string, number>();
  for (const pool of pools) {
    for (const side of [pool.token0, pool.token1]) {
      if (side === null) continue;
      poolsByToken.set(side, (poolsByToken.get(side) ?? 0) + 1);
    }
  }

  const anchorRead = await deps.reader.readBlockAnchor();
  const anchor = anchorRead.ok ? anchorRead.value : null;

  const summaries: OfficialAssetSummaryV1[] = [];
  for (const identity of assets) {
    const { ticker, displayName, listedIn } = currentTickerV1(identity);
    const feedAddress =
      identity.listings.find((listing) => listing.referenceFeedAddress !== null)
        ?.referenceFeedAddress ?? null;
    const referenceValue =
      anchor === null
        ? unavailableTokenizedStockReferenceV1({ feedAddress, reason: 'reference_unavailable' })
        : await readTokenizedStockReferenceV1(deps.reader, {
            feedAddress,
            anchor,
            now,
            // Base Docs names the registry's pause state but publishes no
            // callable ABI for it. Unknown, never inferred from a fresh answer.
            registryPause: null,
          });

    const run = await deps.cashExit.latestCompletedRun({
      chainId: 8453,
      tokenAddress: identity.tokenAddress,
      scope: 'public_ladder',
    });
    const preview = previewLadderFromRunV1(run);
    const routeStatus = routeStatusFromPreviewV1(preview);
    const executableValue = executableFromRunV1(run, preview);
    const observed = activityByToken.get(identity.tokenAddress);
    const market: OfficialAssetMarketV1 = {
      routeStatus,
      measuredAt: run?.completedAt ?? null,
      // When the underlying quote lapsed. Carried so a surface can say that
      // executing on this exact quote is no longer possible, without turning
      // the reading itself into "not measured".
      expiresAt:
        run?.observations.map((observation) => observation.expiresAt).find((value) => value) ?? null,
      approvedSources: run?.approvedSources ?? [],
      ladder: preview,
      observation: {
        // Three states, and the third is about us. `not_observed` means the
        // tail has not read this token's ledger at all; it is never rendered
        // as a quiet market.
        status:
          cursor === null
            ? 'not_observed'
            : (observed?.transfers ?? 0) > 0
              ? 'movements_observed'
              : 'no_movements_observed',
        semantics: 'venue_transfers_not_confirmed_swaps',
        pairedPoolCount: cursor === null ? null : (poolsByToken.get(identity.tokenAddress) ?? 0),
        movementCount: cursor === null ? null : (observed?.transfers ?? 0),
      },
    };

    summaries.push({
      chainId: 8453,
      tokenAddress: identity.tokenAddress,
      ticker,
      displayName,
      issuer: identity.issuer,
      listedIn: listedIn.length > 0 ? listedIn : [identity.listings[0]!.sourceKind],
      sourceDiscrepancy: discrepancies.some(
        (item) => 'tokenAddress' in item && item.tokenAddress === identity.tokenAddress,
      ),
      referenceValue,
      executableValue,
      comparison: compareReferenceAndExecutableV1(referenceValue, executableValue),
      market,
      lookalikeCount: lookalikeCounts[identity.tokenAddress] ?? 0,
    });
  }

  // Assets with a route first, then by ticker. The four that can be exited are
  // the working part of this corpus and a reader should meet them first --
  // without the other nine being hidden, which is the whole point of the page.
  const rank: Readonly<Record<OfficialRouteStatusV1, number>> = {
    cash_route_established: 0,
    no_route_at_measured_sizes: 1,
    measurement_failed: 2,
    not_measured: 3,
  };
  summaries.sort(
    (left, right) =>
      rank[left.market.routeStatus] - rank[right.market.routeStatus] ||
      left.ticker.localeCompare(right.ticker) ||
      left.tokenAddress.localeCompare(right.tokenAddress),
  );

  const counts = {
    officialIssuance: summaries.length,
    cashRouteEstablished: summaries.filter(
      (asset) => asset.market.routeStatus === 'cash_route_established',
    ).length,
    noRouteAtMeasuredSizes: summaries.filter(
      (asset) => asset.market.routeStatus === 'no_route_at_measured_sizes',
    ).length,
    measurementFailed: summaries.filter(
      (asset) => asset.market.routeStatus === 'measurement_failed',
    ).length,
    notMeasured: summaries.filter((asset) => asset.market.routeStatus === 'not_measured').length,
  };

  const gaps = new Set<string>();
  if (anchor === null) gaps.add('base_block_anchor_unavailable');
  if (cursor === null) gaps.add('market_tail_never_run');
  if (counts.notMeasured > 0) gaps.add('cash_exit_not_measured_for_every_asset');
  if (sources.some((source) => source.status !== 'ok')) gaps.add('official_source_check_incomplete');
  if (discrepancies.length > 0) gaps.add('official_sources_disagree');
  gaps.add('confirmed_swap_semantics_not_implemented');

  return OfficialAssetsOverviewV1Schema.parse({
    schemaVersion: 'official-assets-overview/v1',
    chainId: 8453,
    observedAt: now.toISOString(),
    counts,
    sources,
    marketObservation: {
      status: cursor === null ? 'never_run' : 'observed',
      checkedThroughBlock: cursor?.lastBlock ?? null,
      checkedAt: cursor?.lastRunAt ?? null,
    },
    assets: summaries,
    gaps: [...gaps].sort(),
  });
}

export async function assembleOfficialLookalikeFeedV1(
  deps: OfficialDiscoverDepsV1,
  input?: { matchedAlias?: LookalikeAliasKindV1 | null; limit?: number },
): Promise<OfficialLookalikeFeedV1> {
  const now = deps.now();
  const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
  const matchedAlias = input?.matchedAlias ?? null;
  const [counts, rows, universe] = await Promise.all([
    deps.lookalikes.lookalikeCounts({ chainId: 8453 }),
    deps.lookalikes.recentLookalikes({
      chainId: 8453,
      ...(matchedAlias === null ? {} : { matchedAlias }),
      limit,
    }),
    deps.official.officialAssets({ chainId: 8453, limit: 64 }),
  ]);
  // The official side of every card comes from the corpus, not from the stored
  // row: a row carries the resembling contract's own words on purpose, and
  // reusing them for the official asset would let an impostor's metadata
  // supply the name it is being compared against.
  const official = new Map(
    universe.map((identity) => [identity.tokenAddress, currentTickerV1(identity)]),
  );

  return OfficialLookalikeFeedV1Schema.parse({
    schemaVersion: 'official-lookalike-feed/v1',
    chainId: 8453,
    observedAt: now.toISOString(),
    disclaimer: LOOKALIKE_DISCLAIMER_V1,
    counts: {
      total: counts.total,
      publishedTicker: counts.byAlias.published_ticker,
      underlying: counts.byAlias.underlying,
      displayName: counts.byAlias.display_name,
    },
    filteredBy: matchedAlias,
    lastScanAt: counts.lastSeenAt,
    cards: rows.flatMap((row) => {
      const named = official.get(row.officialAddress);
      // A row naming an address the corpus no longer holds is dropped rather
      // than rendered against a blank: a comparison with one side missing is
      // the shape that gets misread as an accusation.
      if (!named) return [];
      return [
        {
          chainId: 8453,
          tokenAddress: row.tokenAddress,
          officialAddress: row.officialAddress,
          officialTicker: named.ticker,
          officialDisplayName: named.displayName,
          matchKind: row.matchKind,
          matchedAlias: row.matchedAlias,
          matchedValue: row.matchedValue,
          declaredSymbol: row.launchSymbol,
          declaredName: row.launchName,
          launchedAt: row.launchedAt,
          firstFlaggedAt: row.firstFlaggedAt,
          lastSeenAt: row.lastSeenAt,
        },
      ];
    }),
  });
}

export async function assembleRwaSignalFeedV1(
  deps: OfficialDiscoverDepsV1,
  input?: { limit?: number },
): Promise<RwaSignalFeedV1> {
  const now = deps.now();
  const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
  const [cards, watching, universe] = await Promise.all([
    deps.signals.recentSignals({ chainId: 8453, limit }),
    deps.signals.signalWatch({ chainId: 8453 }),
    deps.official.officialAssets({ chainId: 8453, limit: 64, currentlyListedOnly: false }),
  ]);
  const named = new Map(universe.map((identity) => [identity.tokenAddress, currentTickerV1(identity)]));

  return RwaSignalFeedV1Schema.parse({
    schemaVersion: 'rwa-signal-feed/v1',
    chainId: 8453,
    observedAt: now.toISOString(),
    watching: watching.map((row) => ({ kind: row.kind, watchingSince: row.watchingSince })),
    notReported: [...RWA_SIGNALS_NOT_REPORTED_V1],
    cards: cards.map((row) => ({
      signalId: row.signalId,
      kind: row.kind,
      chainId: 8453,
      subjectAddress: row.subjectAddress,
      subjectTicker: named.get(row.subjectAddress)?.ticker ?? null,
      officialAddress: row.officialAddress,
      officialTicker:
        row.officialAddress === null ? null : (named.get(row.officialAddress)?.ticker ?? null),
      occurredAt: row.occurredAt,
      recordedAt: row.recordedAt,
      facts: row.facts,
    })),
  });
}

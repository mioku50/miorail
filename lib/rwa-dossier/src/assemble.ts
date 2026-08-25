import {
  inspectB20TokenV1,
  type B20BlockAnchorV1,
  type B20ControlEvidenceV1,
  type B20ControlFieldKeyV1,
  type B20ControlSnapshotV1,
  type B20ReaderV1,
} from '@mioagent/b20-control';
import { OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 } from '@mioagent/market-tail';
import { stableHashV1 } from '@mioagent/route-domain';
import { assembleCashExitLadderV1, type CashExitLadderRungV1 } from '@mioagent/rwa-cash-exit';
import {
  isOfficialV1,
  type MarketTailRepositoryV1,
  type OfficialCashExitRepositoryV1,
  type OfficialAssetIdentityV1,
  type OfficialAssetRepositoryV1,
  type OfficialSourceDiscrepancyV1,
} from '@mioagent/route-storage';

import {
  DossierControlsV1Schema,
  MarketTopologyV1Schema,
  OfficialAssetDossierResponseV1Schema,
  OfficialAssetDossierV1Schema,
  RecentMarketActivityV1Schema,
  type DossierEvidenceRefV1,
  type ExecutableValueV1,
  type OfficialAssetDossierResponseV1,
  hashOfficialAssetDossierV1,
} from './contracts.js';
import {
  compareReferenceAndExecutableV1,
  readTokenizedStockReferenceV1,
  unavailableTokenizedStockReferenceV1,
} from './reference.js';

const USDC_BASE_V1 = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE_V1 = '0x4200000000000000000000000000000000000006';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const ACTIVITY_WINDOW_BLOCKS_V1 = 2_000;
const LATEST_MOVEMENTS_V1 = 20;

const CONTROL_KEYS_V1: readonly B20ControlFieldKeyV1[] = [
  'token_name',
  'token_symbol',
  'token_decimals',
  'supply_cap',
  'paused_features',
  'transfer_sender_policy',
  'transfer_receiver_policy',
  'transfer_executor_policy',
  'rebase_multiplier',
];

export interface OfficialAssetDossierDepsV1 {
  official: OfficialAssetRepositoryV1;
  marketTail: MarketTailRepositoryV1;
  reader: B20ReaderV1;
  now: () => Date;
  cashExit?: OfficialCashExitRepositoryV1;
  tenantId?: string;
}

function executableFromLadderV1(rungs: readonly CashExitLadderRungV1[]): ExecutableValueV1 {
  const usdc = rungs.filter((rung) => rung.destination === 'USDC');
  const preferred =
    usdc.find(
      (rung) => rung.sizeKind === 'actual_position' && ['full', 'partial'].includes(rung.status),
    ) ??
    usdc.find((rung) => ['full', 'partial'].includes(rung.status)) ??
    usdc.find((rung) => rung.sizeKind === 'actual_position') ??
    usdc[0];
  if (!preferred) {
    return {
      status: 'not_measured',
      valueAtomic: null,
      decimals: null,
      requestedSizeAtomic: null,
      executableSizeAtomic: null,
      destination: null,
      observedAt: null,
      evidence: null,
    };
  }
  const exactToken = preferred.exactExecutableTokenAtomic;
  const sellEvidence =
    [...preferred.quoteEvidence].reverse().find((item) => item.direction === 'sell') ?? null;
  const valueAtomic =
    ['full', 'partial'].includes(preferred.status) &&
    exactToken !== null &&
    BigInt(exactToken) > 0n &&
    preferred.returnedAtomic !== null
      ? (
          (BigInt(preferred.returnedAtomic) * 10n ** BigInt(preferred.tokenDecimals + 2)) /
          BigInt(exactToken)
        ).toString()
      : null;
  return {
    status: preferred.status,
    valueAtomic,
    decimals: valueAtomic === null ? null : 8,
    requestedSizeAtomic:
      preferred.requestedTokenAtomic ??
      preferred.exactTestedTokenAtomic ??
      preferred.exactExecutableTokenAtomic,
    executableSizeAtomic: preferred.exactExecutableTokenAtomic,
    destination: 'USDC',
    observedAt: preferred.observedAt,
    evidence: sellEvidence
      ? {
          kind: 'router_quote',
          source: sellEvidence.source,
          observedAt: sellEvidence.observedAt,
          blockNumber: sellEvidence.blockNumber,
          blockHash: null,
          targetAddress: null,
          method: `route:${sellEvidence.routeKey}`,
          evidenceHash: sellEvidence.evidenceHash,
        }
      : null,
  };
}

function discrepancyTouchesV1(
  discrepancy: OfficialSourceDiscrepancyV1,
  tokenAddress: string,
): boolean {
  if (discrepancy.kind === 'ticker_maps_to_multiple_addresses') {
    return discrepancy.tokenAddresses.includes(tokenAddress);
  }
  return discrepancy.tokenAddress === tokenAddress;
}

function identityProjectionV1(
  identity: OfficialAssetIdentityV1,
  discrepancies: readonly OfficialSourceDiscrepancyV1[],
) {
  const current = identity.listings.filter((listing) => listing.currentlyListed);
  const primary =
    current.find((listing) => listing.sourceKind === 'base_docs_technical') ??
    current[0] ??
    identity.listings[0]!;
  return {
    status: 'official_exact_address_match' as const,
    chainId: 8453 as const,
    tokenAddress: identity.tokenAddress,
    issuer: identity.issuer,
    ticker: primary.ticker,
    displayName: primary.displayName,
    // The stored source snapshot carries a token ticker and feed address, not
    // a separately reviewed underlying identity. Stripping a suffix would be
    // a guess, so the bundle names the gap instead.
    underlying: {
      status: 'not_established' as const,
      symbol: null,
      name: null,
      reason: 'The stored reviewed snapshot does not carry a separate underlying identity.',
    },
    listings: identity.listings.map((listing) => ({
      ...listing,
      evidence: {
        kind: 'reviewed_source_snapshot' as const,
        source: listing.sourceUrl,
        observedAt: listing.sourceCheckedAt ?? listing.lastSeenAt,
        blockNumber: null,
        blockHash: null,
        targetAddress: identity.tokenAddress,
        method: null,
        evidenceHash: null,
      },
    })),
    sourceDiscrepancy: discrepancies.some((item) =>
      discrepancyTouchesV1(item, identity.tokenAddress),
    ),
  };
}

function controlEvidenceRefV1(evidence: B20ControlEvidenceV1): DossierEvidenceRefV1 {
  return {
    kind: 'base_chain_call',
    source: evidence.sourceVersion,
    observedAt: evidence.observedAt,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    targetAddress: evidence.target,
    method: evidence.methodSignature,
    evidenceHash: evidence.evidenceHash,
  };
}

function controlsFromSnapshotV1(snapshot: B20ControlSnapshotV1 | null, now: Date) {
  if (snapshot === null) {
    return DossierControlsV1Schema.parse({
      status: 'unavailable',
      blockNumber: null,
      blockHash: null,
      observedAt: now.toISOString(),
      multiplier: { status: 'unavailable', atomic: null, decimals: 18, evidence: null },
      fields: CONTROL_KEYS_V1.map((key) => ({
        key,
        status: 'unavailable',
        value: null,
        reason: 'The Base block anchor was unavailable, so no token state was read.',
        evidence: null,
      })),
    });
  }
  const evidenceByHash = new Map(snapshot.evidence.map((item) => [item.evidenceHash, item]));
  const fields = snapshot.fields
    .filter((field) => CONTROL_KEYS_V1.includes(field.key))
    .map((field) => {
      const evidence = field.evidenceHash ? evidenceByHash.get(field.evidenceHash) : null;
      return {
        key: field.key as (typeof CONTROL_KEYS_V1)[number],
        status:
          field.status === 'exact_chain_read'
            ? ('exact_chain_read' as const)
            : field.status === 'unsupported_by_variant'
              ? ('unsupported_by_variant' as const)
              : ('unavailable' as const),
        value: field.status === 'exact_chain_read' ? field.value : null,
        reason:
          field.status === 'exact_chain_read' ? null : (field.reason ?? 'No exact value was read.'),
        evidence: evidence ? controlEvidenceRefV1(evidence) : null,
      };
    });
  const multiplierField = fields.find((field) => field.key === 'rebase_multiplier');
  const multiplierAtomic = multiplierField?.value?.match(/^\d+/)?.[0] ?? null;
  return DossierControlsV1Schema.parse({
    status:
      snapshot.status === 'complete'
        ? 'complete'
        : snapshot.status === 'partial'
          ? 'partial'
          : 'unavailable',
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    observedAt: snapshot.observedAt,
    multiplier: {
      status: multiplierAtomic === null ? 'unavailable' : 'exact_chain_read',
      atomic: multiplierAtomic,
      decimals: 18,
      evidence: multiplierField?.evidence ?? null,
    },
    fields,
  });
}

async function marketProjectionV1(
  deps: OfficialAssetDossierDepsV1,
  tokenAddress: string,
  officialAddresses: ReadonlySet<string>,
) {
  const cursor = await deps.marketTail.readCursor({ tailKey: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1 });
  if (cursor === null) {
    return {
      topology: MarketTopologyV1Schema.parse({
        status: 'unavailable',
        checkedAt: null,
        checkedThroughBlock: null,
        venueCount: null,
        pairedPoolCount: null,
        singletonCount: null,
        directCashPoolCount: null,
        directUsdcPoolCount: null,
        directEthPoolCount: null,
        venues: [],
        evidence: null,
      }),
      activity: RecentMarketActivityV1Schema.parse({
        status: 'unavailable',
        semantics: 'venue_transfers_not_confirmed_swaps',
        checkedAt: null,
        windowFromBlock: null,
        windowToBlock: null,
        movementCount: null,
        outOfVenueCount: null,
        intoVenueCount: null,
        confirmedSwapCount: null,
        latest: [],
        evidence: null,
      }),
    };
  }

  const sinceBlock = Math.max(1, cursor.lastBlock - ACTIVITY_WINDOW_BLOCKS_V1 + 1);
  const [allVenues, activities, recent] = await Promise.all([
    deps.marketTail.venues({ chainId: 8453, kinds: ['paired_pool', 'singleton'], limit: 1_000 }),
    deps.marketTail.venueActivity({ chainId: 8453, tokenAddresses: [tokenAddress], sinceBlock }),
    deps.marketTail.recentTransfers({ chainId: 8453, tokenAddress, limit: 500 }),
  ]);
  // `recentTransfers` is bounded but intentionally all-time. Keep the dossier's
  // venue set and examples inside the same block window as its activity counts;
  // otherwise an old singleton could silently survive as "recent" evidence.
  const recentInWindow = recent.filter(
    (row) => row.blockNumber >= sinceBlock && row.blockNumber <= cursor.lastBlock,
  );
  const recentVenueAddresses = new Set(recentInWindow.map((row) => row.venueAddress));
  const relevant = allVenues.filter(
    (venue) =>
      (venue.kind === 'paired_pool' &&
        (venue.token0 === tokenAddress || venue.token1 === tokenAddress)) ||
      (venue.kind === 'singleton' && recentVenueAddresses.has(venue.address)),
  );
  const venues = relevant.map((venue) => {
    const quoteAddress =
      venue.kind !== 'paired_pool'
        ? null
        : venue.token0 === tokenAddress
          ? venue.token1
          : venue.token1 === tokenAddress
            ? venue.token0
            : null;
    const quoteCategory =
      quoteAddress === null
        ? null
        : quoteAddress === USDC_BASE_V1
          ? ('USDC' as const)
          : quoteAddress === WETH_BASE_V1
            ? ('ETH_WETH' as const)
            : officialAddresses.has(quoteAddress)
              ? ('other_official_asset' as const)
              : ('unknown' as const);
    return {
      address: venue.address,
      kind: venue.kind as 'paired_pool' | 'singleton',
      token0: venue.token0,
      token1: venue.token1,
      quoteAddress,
      quoteCategory,
      directCashReachable:
        quoteCategory === null ? null : quoteCategory === 'USDC' || quoteCategory === 'ETH_WETH',
      firstSeenAt: venue.firstSeenAt,
      identifiedAt: venue.identifiedAt,
    };
  });
  const paired = venues.filter((venue) => venue.kind === 'paired_pool');
  const evidence: DossierEvidenceRefV1 = {
    kind: 'stored_market_tail',
    source: OFFICIAL_ASSET_LEDGER_TAIL_KEY_V1,
    observedAt: cursor.lastRunAt,
    blockNumber: String(cursor.lastBlock),
    blockHash: null,
    targetAddress: tokenAddress,
    method: 'ERC20 Transfer ledger projection',
    evidenceHash: stableHashV1('official-asset-market-projection/v1', {
      tokenAddress,
      cursor,
      venues,
      activity: activities[0] ?? null,
    }),
  };
  const topology = MarketTopologyV1Schema.parse({
    status: 'observed',
    checkedAt: cursor.lastRunAt,
    checkedThroughBlock: cursor.lastBlock,
    venueCount: venues.length,
    pairedPoolCount: paired.length,
    singletonCount: venues.filter((venue) => venue.kind === 'singleton').length,
    directCashPoolCount: paired.filter((venue) => venue.directCashReachable === true).length,
    directUsdcPoolCount: paired.filter((venue) => venue.quoteCategory === 'USDC').length,
    directEthPoolCount: paired.filter((venue) => venue.quoteCategory === 'ETH_WETH').length,
    venues,
    evidence,
  });

  const activityRow = activities[0] ?? null;
  const activity = RecentMarketActivityV1Schema.parse({
    status: activityRow && activityRow.transfers > 0 ? 'observed' : 'no_movements_observed',
    semantics: 'venue_transfers_not_confirmed_swaps',
    checkedAt: cursor.lastRunAt,
    windowFromBlock: sinceBlock,
    windowToBlock: cursor.lastBlock,
    movementCount: activityRow?.transfers ?? 0,
    outOfVenueCount: activityRow?.acquired ?? 0,
    intoVenueCount: activityRow?.disposed ?? 0,
    confirmedSwapCount: null,
    latest: recentInWindow.slice(0, LATEST_MOVEMENTS_V1).map((row) => ({
      venueAddress: row.venueAddress,
      direction: row.direction,
      counterparty: row.counterparty,
      counterpartyRole: 'unattributed_counterparty',
      amountAtomic: row.amountAtomic,
      blockNumber: row.blockNumber,
      transactionHash: row.transactionHash,
      logIndex: row.logIndex,
      observedAt: row.observedAt,
    })),
    evidence,
  });
  return { topology, activity };
}

function feedAddressV1(identity: OfficialAssetIdentityV1): {
  address: string | null;
  conflict: boolean;
} {
  const addresses = new Set(
    identity.listings
      .filter((listing) => listing.currentlyListed && listing.referenceFeedAddress !== null)
      .map((listing) => listing.referenceFeedAddress!),
  );
  return {
    address: addresses.size === 1 ? [...addresses][0]! : null,
    conflict: addresses.size > 1,
  };
}

export async function assembleOfficialAssetDossierV1(
  deps: OfficialAssetDossierDepsV1,
  input: { chainId: 8453; tokenAddress: string },
): Promise<OfficialAssetDossierResponseV1> {
  const now = deps.now();
  const tokenAddress = input.tokenAddress.toLowerCase();
  const identity = await deps.official.officialIdentity({ chainId: input.chainId, tokenAddress });
  if (!isOfficialV1(identity)) {
    return OfficialAssetDossierResponseV1Schema.parse({
      outcome: 'not_in_reviewed_corpus',
      chainId: 8453,
      tokenAddress,
      detail:
        'No currently listed reviewed source snapshot establishes this exact address as official.',
    });
  }

  const [discrepancies, officialUniverse] = await Promise.all([
    deps.official.sourceDiscrepancies({ chainId: 8453 }),
    deps.official.officialAssets({ chainId: 8453, limit: 500 }),
  ]);
  const anchorRead = await deps.reader.readBlockAnchor();
  const anchor: B20BlockAnchorV1 | null = anchorRead.ok ? anchorRead.value : null;
  let controlSnapshot: B20ControlSnapshotV1 | null = null;
  if (anchor !== null) {
    const inspected = await inspectB20TokenV1(
      { reader: deps.reader },
      { tenantId: 'official-asset-dossier', chainId: 8453, tokenAddress, now, anchor },
    );
    controlSnapshot = inspected.snapshot;
  }
  const controls = controlsFromSnapshotV1(controlSnapshot, now);

  const feed = feedAddressV1(identity!);
  const referenceValue =
    anchor === null
      ? unavailableTokenizedStockReferenceV1({
          feedAddress: feed.address,
          reason: 'reference_unavailable',
        })
      : await readTokenizedStockReferenceV1(deps.reader, {
          feedAddress: feed.address,
          anchor,
          now,
          // Base Docs names this state but does not publish a callable registry
          // ABI. Unknown is safer than guessing a selector or treating fresh as
          // proof that no pause just began.
          registryPause: null,
        });
  const [publicExitRun, positionExitRun] = deps.cashExit
    ? await Promise.all([
        deps.cashExit.latestCompletedRun({ chainId: 8453, tokenAddress, scope: 'public_ladder' }),
        deps.tenantId
          ? deps.cashExit.latestCompletedRun({
              chainId: 8453,
              tokenAddress,
              scope: 'tenant_position',
              tenantId: deps.tenantId,
            })
          : Promise.resolve(null),
      ])
    : [null, null];
  const cashExitLadder = assembleCashExitLadderV1({
    publicRun: publicExitRun,
    positionRun: positionExitRun,
    now,
  });
  const executableValue = executableFromLadderV1(cashExitLadder.rungs);
  const comparison = compareReferenceAndExecutableV1(referenceValue, executableValue);
  const market = await marketProjectionV1(
    deps,
    tokenAddress,
    new Set(officialUniverse.map((asset) => asset.tokenAddress)),
  );

  const gaps = new Set<string>([
    'underlying_identity_not_established',
    'oracle_registry_pause_abi_not_established',
    'confirmed_swap_semantics_not_implemented',
  ]);
  if (executableValue.status === 'not_measured') gaps.add('executable_value_not_measured');
  if (executableValue.status === 'measurement_failed') gaps.add('cash_exit_measurement_failed');
  if (feed.conflict) gaps.add('reference_feed_source_conflict');
  if (anchor === null) gaps.add('base_block_anchor_unavailable');
  if (controls.status === 'unavailable') gaps.add('b20_controls_unavailable');
  if (referenceValue.status === 'stale') gaps.add('reference_value_stale');
  if (referenceValue.status === 'unavailable' || referenceValue.status === 'invalid') {
    gaps.add('reference_value_unavailable');
  }
  if (market.topology.status === 'unavailable') gaps.add('market_tail_not_observed');
  if (discrepancies.some((item) => discrepancyTouchesV1(item, tokenAddress))) {
    gaps.add('official_sources_disagree');
  }

  const draft = {
    schemaVersion: 'official-asset-dossier/v1' as const,
    dossierHash: ZERO_HASH,
    assembly: 'deterministic_no_llm_facts' as const,
    status: 'partial' as const,
    chainId: 8453 as const,
    tokenAddress,
    assembledAt: now.toISOString(),
    identity: identityProjectionV1(identity!, discrepancies),
    referenceValue,
    executableValue,
    cashExitLadder,
    comparison,
    controls,
    marketTopology: market.topology,
    recentMarketActivity: market.activity,
    gaps: [...gaps].sort(),
  };
  const dossier = OfficialAssetDossierV1Schema.parse({
    ...draft,
    dossierHash: hashOfficialAssetDossierV1(draft),
  });
  return OfficialAssetDossierResponseV1Schema.parse({ outcome: 'dossier', dossier });
}

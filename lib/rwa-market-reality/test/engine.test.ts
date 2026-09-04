import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CashExitMeasurementRunV1,
  OfficialCashExitRepositoryV1,
  RepresentationRatioRepositoryV1,
  RepresentationRatioRowV1,
  RepresentationSupplyRepositoryV1,
  RepresentationSupplyRowV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { assembleMarketRealityIndexV1, assembleMarketRealityV2 } from '../src/engine.js';

const H = `0x${'11'.repeat(32)}` as const;
const CANDIDATE = `0x${'22'.repeat(32)}` as const;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNDERLYING = 'security:isin:US67066G1040';

function binding(
  address: string,
  instrument: string,
  issuer: 'backed' | 'coinbase' = 'backed',
): RepresentationUnderlyingV1 {
  return {
    chainId: 8453,
    tokenAddress: address,
    underlyingKey: UNDERLYING,
    sourceKind: issuer === 'backed' ? 'backed_assets_api' : 'coinbase_b20_metadata',
    sourceRef: 'https://api.xstocks.fi/api/v1/token?type=btokens',
    sourceHash: 'ab'.repeat(32),
    issuerId: issuer,
    issuerInstrumentKey: instrument,
    caip10: `eip155:8453:${address}`,
    representationKind: issuer === 'backed' ? 'rebasing_erc20' : 'b20_asset',
    evidenceStrength:
      issuer === 'backed'
        ? 'reviewed_machine_address_mapping'
        : 'reviewed_machine_mapping_with_onchain_cross_check',
    observedBlockNumber: null,
    observedBlockHash: null,
    observedAt: '2026-08-26T12:00:00.000Z',
  };
}

function run(
  address: string,
  outputAtomic: string,
  errorCode: string | null = null,
): CashExitMeasurementRunV1 {
  const quoted = errorCode === null;
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: H,
    chainId: 8453,
    tokenAddress: address,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['router-a'],
    destinations: ['USDC'],
    startedAt: '2026-08-26T12:00:00.000Z',
    completedAt: '2026-08-26T12:00:01.000Z',
    observations: [
      {
        schemaVersion: 'official-cash-exit-observation/v1',
        observationHash: H,
        runId: H,
        chainId: 8453,
        tokenAddress: address,
        tokenSymbol: 'bNVDA',
        tokenDecimals: 18,
        scope: 'public_ladder',
        tenantId: null,
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: '100000000',
        requestedTokenAtomic: null,
        testedTokenAtomic: quoted ? outputAtomic : null,
        destination: 'USDC',
        destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destinationDecimals: 6,
        source: 'router-a',
        status: quoted ? 'full' : 'measurement_failed',
        evidenceStrength: 'router_quote',
        executionProven: false,
        buyQuote: quoted
          ? {
              direction: 'buy',
              inputAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              outputAddress: address,
              inputAtomic: '100000000',
              outputAtomic,
              routeKey: CANDIDATE,
              candidateHash: CANDIDATE,
              evidenceHash: H,
              observedAt: '2026-08-26T12:00:00.000Z',
              expiresAt: '2026-08-26T12:10:00.000Z',
              blockNumber: '50000000',
              liquiditySources: ['pool-a'],
            }
          : null,
        sellQuote: null,
        errorCode,
        observedAt: '2026-08-26T12:00:00.000Z',
        expiresAt: '2026-08-26T12:10:00.000Z',
      },
    ],
  };
}

function deps(
  runs: Record<string, CashExitMeasurementRunV1>,
  options: {
    bindings?: RepresentationUnderlyingV1[];
    ratios?: RepresentationRatioRowV1[];
    supplies?: RepresentationSupplyRowV1[];
  } = {},
) {
  const bindings = options.bindings ?? [
    binding(A, 'backed:instrument_id:a'),
    binding(B, 'backed:instrument_id:b'),
  ];
  return {
    underlyings: {
      representationsOf: async () => bindings,
    } as unknown as UnderlyingAssetRepositoryV1,
    cashExit: {
      latestCompletedRun: async ({ tokenAddress }: { tokenAddress: string }) =>
        runs[tokenAddress] ?? null,
    } as unknown as OfficialCashExitRepositoryV1,
    ratios: {
      readRatios: async () => options.ratios ?? [],
    } as unknown as RepresentationRatioRepositoryV1,
    supplies: {
      readSupplies: async () =>
        options.supplies ?? bindings.map((row) => supply(row.tokenAddress, 'positive_supply')),
    } as unknown as RepresentationSupplyRepositoryV1,
    now: () => new Date('2026-08-26T12:01:00.000Z'),
  };
}

function supply(
  address: string,
  state: 'positive_supply' | 'zero_supply' | 'supply_unknown',
): RepresentationSupplyRowV1 {
  const established = state !== 'supply_unknown';
  return {
    chainId: 8453,
    tokenAddress: address,
    state,
    totalSupplyAtomic: established ? (state === 'zero_supply' ? '0' : '1000000000000000000') : null,
    decimals: established ? 18 : null,
    normalization: 'raw_erc20_total_supply',
    blockNumber: '50000000',
    blockHash: H,
    source: 'erc20_total_supply',
    evidenceHash: H,
    readOutcome: established ? 'success' : 'rpc_failure',
    failureCode: established ? null : 'rpc_timeout',
    observedAt: '2026-08-26T12:00:00.000Z',
    lastCheckedAt: '2026-08-26T12:00:00.000Z',
    lastChangedAt: null,
    reads: 1,
    changes: 0,
    createdAt: '2026-08-26T12:00:00.000Z',
  };
}

test('complete numeric coverage remains ranking-withheld by Phase 10B.8 policy', async () => {
  const result = await assembleMarketRealityV2(
    deps({ [A]: run(A, '500000000000000000'), [B]: run(B, '400000000000000000') }),
    {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    },
  );
  assert.equal(result.marketOutcomeCoverage.status, 'complete');
  assert.equal(result.numericComparisonCoverage.status, 'complete');
  assert.equal(result.ranking.status, 'withheld');
  assert.deepEqual(result.ranking.orderedTokenAddresses, []);
  assert.ok(result.representations.every((row) => row.reference.session === 'unknown'));
  assert.ok(result.representations.every((row) => row.premiumDiscountBps === null));
  assert.ok(
    result.representations.every(
      (row) => row.sources[0]?.simulationEvidence.status === 'not_simulated',
    ),
  );
});

test('provider failure remains measurement_failed and withholds ranking', async () => {
  const result = await assembleMarketRealityV2(
    deps({ [A]: run(A, '500000000000000000'), [B]: run(B, '0', 'provider_timeout') }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(
    result.representations.find((row) => row.tokenAddress === B)?.status,
    'measurement_failed',
  );
  assert.equal(result.marketOutcomeCoverage.status, 'incomplete');
  assert.equal(result.ranking.status, 'withheld');
});

test('a previously quoted but closed question is typed expired, never a current price', async () => {
  const expired = run(A, '500000000000000000');
  expired.observations[0]!.expiresAt = '2026-08-26T12:00:30.000Z';
  expired.observations[0]!.buyQuote!.expiresAt = '2026-08-26T12:00:30.000Z';
  const result = await assembleMarketRealityV2(
    deps({ [A]: expired }, { bindings: [binding(A, 'coinbase:instrument_id:a', 'coinbase')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const representation = result.representations[0]!;
  assert.equal(representation.status, 'not_measured');
  assert.equal(representation.effectivePriceAtomic, null);
  assert.equal(representation.basis.status, 'withheld');
  assert.equal(representation.basis.reasonCode, 'expired_quote');
});

test('positive supply plus scoped no-route establishes a categorical outcome, not a price', async () => {
  const result = await assembleMarketRealityV2(
    deps({
      [A]: run(A, '500000000000000000'),
      [B]: run(B, '0', 'cash_size_anchor_no_route'),
    }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(result.universe.positiveSupplyRepresentationCount, 2);
  assert.equal(result.marketOutcomeCoverage.establishedOutcomeCount, 2);
  assert.equal(result.marketOutcomeCoverage.status, 'complete');
  assert.equal(result.numericComparisonCoverage.pricedRepresentationCount, 1);
  assert.equal(result.numericComparisonCoverage.status, 'incomplete');
  assert.equal(result.ranking.status, 'withheld');
});

test('zero supply stays reviewed and visible without blocking the current market denominator', async () => {
  const result = await assembleMarketRealityV2(
    deps(
      {
        [A]: run(A, '500000000000000000'),
        [B]: run(B, '0', 'provider_unsupported_token'),
      },
      { supplies: [supply(A, 'positive_supply'), supply(B, 'zero_supply')] },
    ),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(result.universe.reviewedRepresentationCount, 2);
  assert.equal(result.universe.positiveSupplyRepresentationCount, 1);
  assert.equal(result.universe.zeroSupplyRepresentationCount, 1);
  assert.equal(result.marketOutcomeCoverage.status, 'complete');
  assert.equal(
    result.representations.find((row) => row.tokenAddress === B)?.supply.state,
    'zero_supply',
  );
  assert.equal(
    result.representations.find((row) => row.tokenAddress === B)?.basis.reasonCode,
    'zero_supply',
  );
  assert.notEqual(
    result.representations.find((row) => row.tokenAddress === B)?.status,
    'unavailable',
    'router coverage is not promoted to a market verdict',
  );
});

test('a supply read failure remains unknown and keeps coverage incomplete', async () => {
  const result = await assembleMarketRealityV2(
    deps(
      { [A]: run(A, '500000000000000000'), [B]: run(B, '400000000000000000') },
      { supplies: [supply(A, 'positive_supply'), supply(B, 'supply_unknown')] },
    ),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(result.universe.unresolvedSupplyRepresentationCount, 1);
  assert.equal(result.marketOutcomeCoverage.status, 'incomplete');
  assert.match(result.marketOutcomeCoverage.reason ?? '', /silently removed/);
});

test('cash-size anchor no-route is BUY no-route but SELL unsized for the same exact row', async () => {
  const options = { bindings: [binding(B, 'backed:instrument_id:b')] };
  const buy = await assembleMarketRealityV2(
    deps({ [B]: run(B, '0', 'cash_size_anchor_no_route') }, options),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const sell = await assembleMarketRealityV2(
    deps({ [B]: run(B, '0', 'cash_size_anchor_no_route') }, options),
    { underlyingKey: UNDERLYING, direction: 'sell', requestedCashAtomic: '100000000' },
  );
  assert.equal(buy.representations[0]?.status, 'unavailable');
  assert.equal(buy.representations[0]?.lastObservation?.status, 'no_route');
  assert.equal(buy.marketOutcomeCoverage.status, 'complete');
  assert.equal(sell.representations[0]?.status, 'measurement_failed');
  assert.equal(sell.representations[0]?.lastObservation?.status, 'unsized');
  assert.equal(sell.representations[0]?.basis.reasonCode, 'unsized_sell');
  assert.equal(sell.marketOutcomeCoverage.status, 'incomplete');
});

test('an expired SELL sizing miss keeps unsized as the basis blocker', async () => {
  const closed = run(B, '0', 'cash_size_anchor_no_route');
  closed.observations[0]!.expiresAt = '2026-08-26T12:00:30.000Z';
  const result = await assembleMarketRealityV2(
    deps({ [B]: closed }, { bindings: [binding(B, 'backed:instrument_id:b')] }),
    { underlyingKey: UNDERLYING, direction: 'sell', requestedCashAtomic: '100000000' },
  );
  assert.equal(result.representations[0]?.lastObservation?.status, 'unsized');
  assert.equal(result.representations[0]?.basis.reasonCode, 'unsized_sell');
});

test('a stale B20 multiplier cannot normalize a fresh router quote', async () => {
  const ratio = (address: string): RepresentationRatioRowV1 => ({
    chainId: 8453,
    tokenAddress: address,
    ratioKind: 'b20_multiplier',
    application: 'apply_to_raw_balance',
    rawValue: '1000000000000000000',
    scale: '1000000000000000000',
    scaleSource: 'read_from_contract',
    blockNumber: '49900000',
    blockHash: H,
    evidenceHash: H,
    observedAt: '2026-08-25T00:00:00.000Z',
    lastCheckedAt: '2026-08-25T00:00:00.000Z',
    lastChangedAt: null,
    reads: 1,
    changes: 0,
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  const result = await assembleMarketRealityV2(
    deps(
      { [A]: run(A, '500000000000000000'), [B]: run(B, '400000000000000000') },
      {
        bindings: [
          binding(A, 'coinbase:asset:a', 'coinbase'),
          binding(B, 'coinbase:asset:b', 'coinbase'),
        ],
        ratios: [ratio(A), ratio(B)],
      },
    ),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.ok(result.representations.every((row) => row.normalization === 'not_established'));
  assert.equal(result.numericComparisonCoverage.status, 'incomplete');
  assert.equal(result.ranking.status, 'withheld');
});

test('a background sample is history, never a current quote', async () => {
  // The mismatch, in the read path. The sampler measured this token perfectly
  // forty minutes ago and the quote window closed twenty seconds later. The
  // engine must not offer that number as what it costs now — and must not
  // pretend it never happened either.
  const lapsed = run(A, '500000000000000000');
  lapsed.observations[0]!.expiresAt = '2026-08-26T12:00:20.000Z';
  lapsed.observations[0]!.buyQuote!.expiresAt = '2026-08-26T12:00:20.000Z';
  const result = await assembleMarketRealityV2(
    deps({ [A]: lapsed }, { bindings: [binding(A, 'backed:instrument_id:a')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  assert.equal(row.liveness, 'history_only');
  assert.equal(row.status, 'not_measured', 'nothing current');
  assert.equal(row.returnedCashAtomic, null, 'and no number presented as current');
  assert.ok(row.lastObservation, 'but the measurement is not thrown away');
  assert.equal(row.lastObservation?.status, 'quoted');
  assert.equal(row.lastObservation?.open, false);
  assert.equal(row.lastObservation?.observedAt, '2026-08-26T12:00:00.000Z');
});

test('open evidence is live, and its observation is marked open', async () => {
  const result = await assembleMarketRealityV2(
    deps(
      { [A]: run(A, '500000000000000000') },
      { bindings: [binding(A, 'backed:instrument_id:a')] },
    ),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  assert.equal(row.liveness, 'live');
  assert.equal(row.status, 'full');
  assert.equal(row.lastObservation?.open, true);
});

test('a representation nobody ever measured has no observation to show', async () => {
  const result = await assembleMarketRealityV2(
    deps({}, { bindings: [binding(A, 'backed:instrument_id:a')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  assert.equal(row.liveness, 'never_measured');
  assert.equal(row.lastObservation, null, 'absence, not a zeroed point');
});

// ---------------------------------------------------------------------------
// Migration 0059 added issuer typing to a table that already existed, so a row
// written before it holds NULLs. `market-reality/v2` asserted those non-null,
// which turned one legacy row into a Zod throw that took the whole canonical
// assembler down -- and with it a valid agent request for an underlying that
// was otherwise perfectly measurable. The contract does not move; the identity
// is recovered from the exact address instead.
// ---------------------------------------------------------------------------

function legacyRowV1(address: string): RepresentationUnderlyingV1 {
  return {
    ...binding(address, 'unused'),
    issuerId: null,
    issuerInstrumentKey: null,
    representationKind: null,
  };
}

const legacyRatioV1 = (address: string): RepresentationRatioRowV1 => ({
  chainId: 8453,
  tokenAddress: address,
  ratioKind: 'backed_evm_multiplier',
  application: 'already_applied_by_token',
  rawValue: '1000000000000000000',
  scale: '1000000000000000000',
  scaleSource: 'reviewed_constant',
  blockNumber: '49900000',
  blockHash: H,
  evidenceHash: H,
  observedAt: '2026-08-25T00:00:00.000Z',
  lastCheckedAt: '2026-08-25T00:00:00.000Z',
  lastChangedAt: null,
  reads: 1,
  changes: 0,
  createdAt: '2026-08-25T00:00:00.000Z',
});

test('a pre-0059 row is recovered from its exact address, and v2 stays strict', async () => {
  const result = await assembleMarketRealityV2(
    deps(
      { [A]: run(A, '500000000000000000') },
      { bindings: [legacyRowV1(A)], ratios: [legacyRatioV1(A)] },
    ),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  // `backed_assets_api` IS Backed's own reviewed source, so the issuer follows
  // from the row. Neither `null` nor "unknown" appears anywhere.
  assert.equal(row.issuerId, 'backed');
  assert.equal(row.representationKind, 'rebasing_erc20');
  assert.equal(row.issuerInstrumentKey, `backed:base_address:${A}`);
  assert.equal(result.universe.reviewedRepresentationCount, 1);
});

test('an unestablished structure leaves the comparison instead of being guessed', async () => {
  // A non-rebasing ERC-4626 wrapper has no ratio row. "No evidence" must not
  // become "rebasing", so the address is not placed in the strict array -- and
  // the count of reviewed rows still reports it, so nothing vanishes quietly.
  const result = await assembleMarketRealityV2(
    deps({ [A]: run(A, '500000000000000000') }, { bindings: [legacyRowV1(A)], ratios: [] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.deepEqual(result.representations, []);
  assert.equal(result.universe.reviewedRepresentationCount, 1);
  assert.equal(result.marketOutcomeCoverage.status, 'incomplete');
  assert.match(result.marketOutcomeCoverage.reason ?? '', /structure of the exact address/i);
  assert.match(result.marketOutcomeCoverage.reason ?? '', /did not guess/i);
  assert.equal(result.ranking.status, 'withheld');
});

test('a complete binding is never rewritten by the recovery', async () => {
  const result = await assembleMarketRealityV2(
    deps({ [A]: run(A, '500000000000000000') }, { bindings: [binding(A, 'backed:instrument_id:a')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(result.representations[0]?.issuerInstrumentKey, 'backed:instrument_id:a');
});

test('the Stocks index admits only reviewed equities and computes totals over that universe', async () => {
  const underlying = (
    underlyingKey: string,
    assetClass: 'equity' | 'fund_share' | 'other' | 'unknown',
    representationCount: number,
    issuerIds: string[],
    live = representationCount,
  ) => ({
    underlying: {
      underlyingKey,
      assetClass,
      canonicalName: underlyingKey,
      displaySymbol: null,
      identifierScheme: null,
      identifierValue: null,
      sourceKind: 'backed_assets_api' as const,
      sourceRef: 'https://api.xstocks.fi/api/v1/token?type=btokens',
      sourceHash: 'ab'.repeat(32),
      observedAt: '2026-09-01T12:00:00.000Z',
    },
    representationCount,
    liveRepresentationCount: live,
    issuerIds,
    // Every contract past the first belongs to the FIRST issuer named, so the
    // scoped Coinbase total is not simply the row count and the assertion below
    // is testing arithmetic rather than a coincidence.
    representationCountsByIssuer: Object.fromEntries(
      issuerIds.map((issuerId, index) => [
        issuerId,
        index === 0 ? representationCount - (issuerIds.length - 1) : 1,
      ]),
    ),
  });
  const rows = [
    underlying('backed:instrument:equity', 'equity', 3, ['backed', 'coinbase']),
    underlying('backed:instrument:bond', 'other', 1, ['backed']),
    underlying('backed:instrument:unreviewed', 'unknown', 1, ['backed']),
    underlying('backed:instrument:fund', 'fund_share', 1, ['backed']),
    underlying('backed:instrument:equity-2', 'equity', 1, ['coinbase']),
  ];
  const result = await assembleMarketRealityIndexV1(
    {
      underlyings: {
        listUnderlyings: async () => rows,
        underlyingCounts: async () => {
          throw new Error('generic security totals must not leak into Stocks');
        },
      } as unknown as UnderlyingAssetRepositoryV1,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    },
    { limit: 50 },
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.assetClass),
    ['equity', 'equity'],
  );
  // `boundRepresentations` is 2, not 4. The default scope is Coinbase, and the
  // four contracts across these two equities include two Backed ones. The band
  // above the grid read `Securities 13` beside `Representations 39` because
  // this number counted every contract bound to a Coinbase-covered company —
  // two units under two labels, and no way to tell which was which.
  assert.deepEqual(result.totals, {
    underlyings: 2,
    boundRepresentations: 2,
    multiIssuerUnderlyings: 1,
    coinbaseUnderlyings: 2,
    allUnderlyings: 2,
  });
  // The wider scope is unchanged: there, every contract counts, because every
  // contract is on the page.
  const wide = await assembleMarketRealityIndexV1(
    {
      underlyings: {
        listUnderlyings: async () => rows,
        underlyingCounts: async () => {
          throw new Error('generic security totals must not leak into Stocks');
        },
      } as unknown as UnderlyingAssetRepositoryV1,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    },
    { limit: 50, scope: 'all_representations' },
  );
  assert.equal(wide.totals.boundRepresentations, 4);
  // Carried through, so the surface can order and label on it.
  assert.deepEqual(
    result.entries.map((entry) => entry.liveRepresentationCount),
    [3, 1],
  );
});

test('a security with tokens outstanding is not ranked below an empty contract', async () => {
  // Nine of the thirteen Coinbase tokenized stocks hold exactly zero. Ranking
  // on `representationCount` alone counts CONTRACTS, so an empty security with
  // two deployments sorted above a live one with a single deployment and the
  // first card a visitor opened could do nothing. The repository does the
  // ordering; this pins that the engine preserves it and reports the fact the
  // surface needs to label the rest honestly.
  const row = (key: string, representationCount: number, live: number) => ({
    underlying: {
      underlyingKey: key,
      assetClass: 'equity' as const,
      canonicalName: key,
      displaySymbol: null,
      identifierScheme: null,
      identifierValue: null,
      sourceKind: 'coinbase_b20_metadata' as const,
      sourceRef: 'https://docs.base.org/specifications/b20/tokenized-stocks-on-base',
      sourceHash: 'cd'.repeat(32),
      observedAt: '2026-09-01T12:00:00.000Z',
    },
    representationCount,
    liveRepresentationCount: live,
    issuerIds: ['coinbase'],
    representationCountsByIssuer: { coinbase: representationCount },
  });
  const result = await assembleMarketRealityIndexV1(
    {
      underlyings: {
        listUnderlyings: async () => [row('security:isin:live', 1, 1), row('security:isin:empty', 2, 0)],
        underlyingCounts: async () => {
          throw new Error('generic security totals must not leak into Stocks');
        },
      } as unknown as UnderlyingAssetRepositoryV1,
      now: () => new Date('2026-09-01T12:00:00.000Z'),
    },
    { limit: 50 },
  );
  assert.deepEqual(
    result.entries.map((entry) => [entry.underlyingKey, entry.liveRepresentationCount]),
    [
      ['security:isin:live', 1],
      ['security:isin:empty', 0],
    ],
  );
});

test('the Stocks index opens on the standard Base documents, and can widen', async () => {
  // Three issuers represent the same securities on Base and they are not three
  // versions of one thing. Measured 2026-09-04 at $1,000 SELL: 10 of 13
  // Coinbase representations held a cash route, 2 of 21 Backed, 0 of 96 Dinari
  // — so 74% of the corpus was filling the first screen of a pricing product
  // with contracts that cannot be priced.
  //
  // Nothing is removed from the evidence store. The wide scope returns exactly
  // what this endpoint returned before.
  const row = (key: string, issuerIds: string[]) => ({
    underlying: {
      underlyingKey: key,
      assetClass: 'equity' as const,
      canonicalName: key,
      displaySymbol: null,
      identifierScheme: null,
      identifierValue: null,
      sourceKind: 'coinbase_b20_metadata' as const,
      sourceRef: 'https://docs.base.org/specifications/b20/tokenized-stocks-on-base',
      sourceHash: 'ef'.repeat(32),
      observedAt: '2026-09-01T12:00:00.000Z',
    },
    representationCount: issuerIds.length,
    liveRepresentationCount: issuerIds.length,
    issuerIds,
    // One contract per issuer here, so the scoped total is the count of rows
    // that name Coinbase. The fake carries the field because the repository
    // does: a scoped count summed from a shape production does not return is a
    // test that cannot fail.
    representationCountsByIssuer: Object.fromEntries(
      issuerIds.map((issuerId) => [issuerId, 1]),
    ),
  });
  const rows = [
    row('security:isin:both', ['coinbase', 'backed']),
    row('security:isin:coinbase', ['coinbase']),
    row('security:isin:dinari-only', ['dinari']),
    row('security:isin:backed-only', ['backed']),
  ];
  const deps = {
    underlyings: {
      listUnderlyings: async () => rows,
      underlyingCounts: async () => {
        throw new Error('generic security totals must not leak into Stocks');
      },
    } as unknown as UnderlyingAssetRepositoryV1,
    now: () => new Date('2026-09-01T12:00:00.000Z'),
  };

  const scoped = await assembleMarketRealityIndexV1(deps, { limit: 50 });
  assert.equal(scoped.scope, 'coinbase_b20', 'the default scope is the documented standard');
  assert.deepEqual(
    scoped.entries.map((entry) => entry.underlyingKey),
    ['security:isin:both', 'security:isin:coinbase'],
  );
  assert.deepEqual(
    scoped.entries.map((entry) => entry.coinbaseIssued),
    [true, true],
  );
  // The three counters above the grid describe the PAGE...
  assert.equal(scoped.totals.underlyings, 2);
  // ...and the corpus counts describe what the other scope holds, so the filter
  // can name what it is not showing instead of hiding it.
  assert.equal(scoped.totals.coinbaseUnderlyings, 2);
  assert.equal(scoped.totals.allUnderlyings, 4);

  const wide = await assembleMarketRealityIndexV1(deps, { limit: 50, scope: 'all_representations' });
  assert.equal(wide.scope, 'all_representations');
  assert.equal(wide.entries.length, 4, 'nothing was removed from the corpus');
  assert.deepEqual(
    wide.entries.map((entry) => entry.coinbaseIssued),
    [true, true, false, false],
  );
  assert.equal(wide.totals.underlyings, 4);
  assert.equal(wide.totals.coinbaseUnderlyings, 2);
});

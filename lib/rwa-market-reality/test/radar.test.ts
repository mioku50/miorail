import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type {
  CashExitMeasurementRunV1,
  CashExitSourceObservationV1,
  MarketRealityEvidenceSnapshotV1,
} from '@mioagent/route-storage';

import {
  InMemoryMarketRealityRadarRepositoryV1,
  MarketRealityRadarPointV1Schema,
  MarketRealityRadarWatchInputV1Schema,
  deriveMarketRealityRadarEventsV1,
  evaluateMarketRealityRadarRunV1,
  marketRealityRadarPointFromRunV1,
  type MarketRealityComparabilityKeyV1,
  type MarketRealityRadarPointV1,
  type MarketRealityRadarWatchV1,
} from '../src/index.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const POLICY = `0x${'11'.repeat(32)}`;
const WATCH_ID = `0x${'22'.repeat(32)}`;
const OBSERVATION_A = `0x${'33'.repeat(32)}`;
const OBSERVATION_B = `0x${'44'.repeat(32)}`;
const SNAPSHOT_A = `0x${'55'.repeat(32)}`;
const SNAPSHOT_B = `0x${'66'.repeat(32)}`;

function watch(over: Partial<MarketRealityRadarWatchV1> = {}): MarketRealityRadarWatchV1 {
  return {
    watchId: WATCH_ID,
    userId: 'eip155:8453:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    chainId: 8453,
    underlyingKey: 'security:isin:US67066G1040',
    tokenAddress: TOKEN,
    issuerId: 'coinbase',
    representationKind: 'b20_asset',
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    destination: 'USDC',
    routePolicyKey: POLICY,
    approvedSources: ['router-a'],
    createdAt: '2026-08-28T10:00:00.000Z',
    lastEvaluatedAt: null,
    lastComparableAt: null,
    lastEvaluationOutcome: null,
    ...over,
  };
}

function point(over: Partial<MarketRealityRadarPointV1> = {}): MarketRealityRadarPointV1 {
  return MarketRealityRadarPointV1Schema.parse({
    snapshotHash: SNAPSHOT_A,
    observationHash: OBSERVATION_A,
    tokenAddress: TOKEN,
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    destination: 'USDC',
    routePolicyKey: POLICY,
    approvedSources: ['router-a'],
    status: 'quoted',
    source: 'router-a',
    observedAt: '2026-08-28T11:00:00.000Z',
    returnedCashAtomic: '997300000',
    effectivePriceAtomic: '20000000000',
    effectivePriceDecimals: 8,
    reference: {
      status: 'fresh',
      marketSession: 'regular_hours',
      publicationMode: 'live_reference',
      freshness: 'fresh',
      reasonCode: 'reviewed_calendar_regular_hours',
    },
    ratio: {
      ratioKind: 'b20_multiplier',
      application: 'apply_to_raw_balance',
      rawValue: '1000000000000000000',
      scale: '1000000000000000000',
      evidenceHash: `0x${'77'.repeat(32)}`,
    },
    ...over,
  });
}

function observation(input: {
  source: string;
  observationHash: string;
  status: 'quoted' | 'no_route' | 'measurement_failed' | 'unsized';
  returnedCashAtomic?: string;
  observedAt?: string;
  destination?: 'USDC' | 'ETH';
}): CashExitSourceObservationV1 {
  const observedAt = input.observedAt ?? '2026-08-28T11:00:00.000Z';
  const quoted = input.status === 'quoted';
  return {
    schemaVersion: 'official-cash-exit-observation/v1',
    observationHash: input.observationHash,
    runId: `0x${'88'.repeat(32)}`,
    chainId: 8453,
    tokenAddress: TOKEN,
    tokenSymbol: 'NVDAc',
    tokenDecimals: 18,
    scope: 'public_ladder',
    tenantId: null,
    sizeKind: 'cash_equivalent',
    requestedCashAtomic: '1000000000',
    requestedTokenAtomic: null,
    testedTokenAtomic: quoted ? '5000000000000000000' : null,
    destination: input.destination ?? 'USDC',
    destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationDecimals: 6,
    source: input.source,
    status:
      input.status === 'quoted'
        ? 'full'
        : input.status === 'no_route'
          ? 'unavailable'
          : input.status === 'unsized'
            ? 'measurement_failed'
            : 'measurement_failed',
    evidenceStrength: 'router_quote',
    executionProven: false,
    buyQuote: null,
    sellQuote: quoted
      ? {
          direction: 'sell',
          inputAddress: TOKEN,
          outputAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          inputAtomic: '5000000000000000000',
          outputAtomic: input.returnedCashAtomic ?? '997300000',
          routeKey: `0x${'99'.repeat(32)}`,
          candidateHash: `0x${'aa'.repeat(32)}`,
          evidenceHash: `0x${'bb'.repeat(32)}`,
          observedAt,
          expiresAt: '2026-08-28T11:00:20.000Z',
          blockNumber: '50000000',
          liquiditySources: ['pool-a'],
        }
      : null,
    errorCode:
      input.status === 'no_route'
        ? 'provider_no_route'
        : input.status === 'unsized'
          ? 'cash_size_anchor_no_route'
          : input.status === 'measurement_failed'
            ? 'provider_timeout'
            : null,
    observedAt,
    expiresAt: '2026-08-28T11:00:20.000Z',
  };
}

function snapshot(input: {
  source: string;
  observationHash: string;
  snapshotHash: string;
  status: 'quoted' | 'no_route' | 'measurement_failed' | 'unsized';
  returnedCashAtomic?: string;
  observedAt?: string;
  destination?: 'USDC' | 'ETH';
}): MarketRealityEvidenceSnapshotV1 {
  const observedAt = input.observedAt ?? '2026-08-28T11:00:00.000Z';
  return {
    schemaVersion: 'market-reality-evidence-snapshot/v1',
    snapshotHash: input.snapshotHash,
    runId: `0x${'88'.repeat(32)}`,
    observationHash: input.observationHash,
    chainId: 8453,
    tokenAddress: TOKEN,
    issuerId: 'coinbase',
    issuerInstrumentKey: `coinbase:b20_address:${TOKEN}`,
    representationKind: 'b20_asset',
    direction: 'sell',
    requestedCashAtomic: '1000000000',
    requestedTokenAtomic: null,
    testedTokenAtomic: input.status === 'quoted' ? '5000000000000000000' : null,
    destination: input.destination ?? 'USDC',
    destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationDecimals: 6,
    source: input.source,
    approvedSources: [],
    routePolicyKey: POLICY,
    marketStatus: input.status,
    marketObservedAt: observedAt,
    marketExpiresAt: '2026-08-28T11:00:20.000Z',
    normalizedExposureAtomic: input.status === 'quoted' ? '5000000000000000000' : null,
    normalizedExposureDecimals: input.status === 'quoted' ? 18 : null,
    normalization: input.status === 'quoted' ? 'fresh_ratio_applied' : 'not_established',
    ratio: null,
    supply: {
      state: 'positive_supply',
      totalSupplyAtomic: '1000000000000000000',
      decimals: 18,
      blockNumber: '50000000',
      blockHash: `0x${'cc'.repeat(32)}`,
      evidenceHash: `0x${'dd'.repeat(32)}`,
      observedAt,
      readOutcome: 'success',
    },
    effectivePriceAtomic: input.status === 'quoted' ? '20000000000' : null,
    effectivePriceDecimals: input.status === 'quoted' ? 8 : null,
    reference: {
      status: 'unknown',
      session: 'unknown',
      marketSession: 'unknown',
      publicationMode: 'unknown',
      valueAtomic: null,
      decimals: null,
      observedAt: null,
      referenceUpdatedAt: null,
      freshness: 'unknown',
      referenceSource: null,
      referenceAddress: null,
      calendar: null,
      evidence: null,
      comparable: false,
      reasonCode: 'reference_adapter_not_configured',
      reason: 'No reviewed adapter.',
    },
    basis: {
      policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1',
      status: 'withheld',
      kind: 'withheld',
      premiumDiscountBps: null,
      reasonCode:
        input.status === 'no_route'
          ? 'no_route'
          : input.status === 'unsized'
            ? 'unsized_sell'
            : input.status === 'measurement_failed'
              ? 'measurement_failed'
              : 'reference_unknown',
      reason: 'Fixture basis is withheld.',
    },
    capturedAt: observedAt,
  };
}

function run(
  rows: Array<{
    source: string;
    status: 'quoted' | 'no_route' | 'measurement_failed' | 'unsized';
    returnedCashAtomic?: string;
  }>,
  observedAt = '2026-08-28T11:00:00.000Z',
  destination: 'USDC' | 'ETH' = 'USDC',
): CashExitMeasurementRunV1 {
  const sources = rows.map((row) => row.source);
  const laterSnapshot = observedAt !== '2026-08-28T11:00:00.000Z';
  const observations = rows.map((row, index) =>
    observation({
      ...row,
      observedAt,
      destination,
      observationHash: index === 0 ? OBSERVATION_A : OBSERVATION_B,
    }),
  );
  const snapshots = observations.map((row, index) => ({
    ...snapshot({
      source: row.source,
      observationHash: row.observationHash,
      snapshotHash: index === 0 ? (laterSnapshot ? SNAPSHOT_B : SNAPSHOT_A) : SNAPSHOT_B,
      status: rows[index]!.status,
      returnedCashAtomic: rows[index]!.returnedCashAtomic,
      observedAt,
      destination,
    }),
    approvedSources: sources,
  }));
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: `0x${'88'.repeat(32)}`,
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: sources,
    destinations: [destination],
    startedAt: observedAt,
    completedAt: observedAt,
    observations,
    marketRealitySnapshots: snapshots,
  };
}

describe('Radar accepts only asset-level successful market points', () => {
  test('an exact market watch requires a positive cash size', () => {
    assert.throws(() =>
      MarketRealityRadarWatchInputV1Schema.parse({
        underlyingKey: 'security:isin:US67066G1040',
        tokenAddress: TOKEN,
        direction: 'sell',
        requestedCashAtomic: '0',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['router-a'],
      }),
    );
  });

  test('one venue miss plus a provider failure remains our failed read', () => {
    const result = marketRealityRadarPointFromRunV1(
      run([
        { source: 'router-a', status: 'no_route' },
        { source: 'router-b', status: 'measurement_failed' },
      ]),
      watch({ approvedSources: ['router-a', 'router-b'] }),
    );
    assert.equal(result.outcome, 'measurement_failed');
    assert.equal(result.point, null);
  });

  test('only the complete approved router set may establish no route', () => {
    const result = marketRealityRadarPointFromRunV1(
      run([
        { source: 'router-a', status: 'no_route' },
        { source: 'router-b', status: 'no_route' },
      ]),
      watch({ approvedSources: ['router-a', 'router-b'] }),
    );
    assert.equal(result.outcome, 'comparable');
    if (result.outcome === 'comparable') assert.equal(result.point.status, 'no_route');
  });

  test('a route-policy change is a comparison break, not an asset event', () => {
    const result = marketRealityRadarPointFromRunV1(
      run([{ source: 'router-a', status: 'quoted' }]),
      watch({ routePolicyKey: `0x${'ee'.repeat(32)}` }),
    );
    assert.equal(result.outcome, 'policy_changed');
  });

  test('an ETH route is reachable but never treated as USD cash back', () => {
    const result = marketRealityRadarPointFromRunV1(
      run(
        [{ source: 'router-a', status: 'quoted', returnedCashAtomic: '500000000000000000' }],
        '2026-08-28T11:00:00.000Z',
        'ETH',
      ),
      watch({ destination: 'ETH' }),
    );
    assert.equal(result.outcome, 'comparable');
    if (result.outcome === 'comparable') assert.equal(result.point.returnedCashAtomic, null);
  });
});

describe('comparability does not depend on issuer typing', () => {
  test('a key without an issuer selects the same point a full watch does', () => {
    // Address, size, direction, destination and route policy decide whether
    // two observations may be compared. Issuer identifies the row a tenant
    // watch belongs to and takes no part in it, so a public caller holding an
    // exact question must not have to assert an issuer to ask it.
    const full = watch();
    const { issuerId: _issuerId, representationKind: _kind, ...key } = full;
    const comparabilityKey: MarketRealityComparabilityKeyV1 = key;

    const quoted = run([
      { source: 'router-a', status: 'quoted', returnedCashAtomic: '999000000' },
    ]);
    assert.deepEqual(
      marketRealityRadarPointFromRunV1(quoted, comparabilityKey),
      marketRealityRadarPointFromRunV1(quoted, full),
    );
    assert.equal(marketRealityRadarPointFromRunV1(quoted, comparabilityKey).outcome, 'comparable');
  });
});

describe('Radar events come from two comparable successful points', () => {
  test('derives the exact sell cash and +15 bps exit-cost change', () => {
    const events = deriveMarketRealityRadarEventsV1({
      watch: watch(),
      previous: point({ returnedCashAtomic: '997300000' }),
      next: point({
        snapshotHash: SNAPSHOT_B,
        observationHash: OBSERVATION_B,
        observedAt: '2026-08-28T12:00:00.000Z',
        returnedCashAtomic: '995800000',
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'sell_exit_cost_changed');
    if (events[0]?.kind === 'sell_exit_cost_changed') {
      assert.equal(events[0].facts.previousExitCostBps, '27');
      assert.equal(events[0].facts.exitCostBps, '42');
      assert.equal(events[0].facts.changeBps, '15');
      assert.equal(events[0].facts.cashBackChangeAtomic, '-1500000');
    }
  });

  test('withholds numeric change when the winning route source changes', () => {
    const events = deriveMarketRealityRadarEventsV1({
      watch: watch({ approvedSources: ['router-a', 'router-b'] }),
      previous: point({ approvedSources: ['router-a', 'router-b'] }),
      next: point({
        snapshotHash: SNAPSHOT_B,
        observationHash: OBSERVATION_B,
        observedAt: '2026-08-28T12:00:00.000Z',
        approvedSources: ['router-a', 'router-b'],
        source: 'router-b',
        returnedCashAtomic: '995800000',
      }),
    });
    assert.deepEqual(events, []);
  });

  test('records route loss only from a successful no-route point', () => {
    const events = deriveMarketRealityRadarEventsV1({
      watch: watch(),
      previous: point(),
      next: point({
        snapshotHash: SNAPSHOT_B,
        observationHash: OBSERVATION_B,
        observedAt: '2026-08-28T12:00:00.000Z',
        status: 'no_route',
        returnedCashAtomic: null,
        effectivePriceAtomic: null,
        effectivePriceDecimals: null,
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'route_became_unavailable');
  });

  test('a reviewed session transition is factual and provider failure is silent', () => {
    const sessionEvents = deriveMarketRealityRadarEventsV1({
      watch: watch(),
      previous: point(),
      next: point({
        snapshotHash: SNAPSHOT_B,
        observationHash: OBSERVATION_B,
        observedAt: '2026-08-28T12:00:00.000Z',
        reference: {
          status: 'fresh',
          marketSession: 'after_hours',
          publicationMode: 'holding_last_close',
          freshness: 'fresh',
          reasonCode: 'reviewed_calendar_after_hours',
        },
      }),
    });
    assert.deepEqual(sessionEvents.map((event) => event.kind), ['market_session_changed']);

    const failedReferenceEvents = deriveMarketRealityRadarEventsV1({
      watch: watch(),
      previous: point(),
      next: point({
        snapshotHash: SNAPSHOT_B,
        observationHash: OBSERVATION_B,
        observedAt: '2026-08-28T12:00:00.000Z',
        reference: {
          status: 'unavailable',
          marketSession: 'unknown',
          publicationMode: 'unknown',
          freshness: 'unknown',
          reasonCode: 'reference_read_failed',
        },
      }),
    });
    assert.deepEqual(failedReferenceEvents, []);
  });
});

test('first successful point is baseline; a failed pass neither alerts nor advances it', async () => {
  const repository = new InMemoryMarketRealityRadarRepositoryV1();
  const seed = watch();
  const storedWatch = await repository.addWatch({
    userId: seed.userId,
    question: {
      underlyingKey: seed.underlyingKey,
      tokenAddress: seed.tokenAddress,
      direction: seed.direction,
      requestedCashAtomic: seed.requestedCashAtomic,
      destination: seed.destination,
      routePolicyKey: seed.routePolicyKey,
      approvedSources: seed.approvedSources,
    },
    issuerId: 'coinbase',
    representationKind: 'b20_asset',
    now: seed.createdAt,
  });
  const first = await evaluateMarketRealityRadarRunV1({
    repository,
    run: run([{ source: 'router-a', status: 'quoted', returnedCashAtomic: '997300000' }]),
    evaluatedAt: '2026-08-28T11:00:01.000Z',
  });
  assert.deepEqual(first, { evaluated: 1, events: 0, gaps: 0 });
  assert.equal((await repository.pointForWatch({ watchId: storedWatch.watchId }))?.returnedCashAtomic, '997300000');

  const failed = await evaluateMarketRealityRadarRunV1({
    repository,
    run: run([{ source: 'router-a', status: 'measurement_failed' }], '2026-08-28T12:00:00.000Z'),
    evaluatedAt: '2026-08-28T12:00:01.000Z',
  });
  assert.deepEqual(failed, { evaluated: 1, events: 0, gaps: 1 });
  assert.equal((await repository.pointForWatch({ watchId: storedWatch.watchId }))?.returnedCashAtomic, '997300000');
  assert.deepEqual(await repository.eventsForUser({ userId: storedWatch.userId, limit: 20 }), []);

  const next = await evaluateMarketRealityRadarRunV1({
    repository,
    run: run(
      [{ source: 'router-a', status: 'quoted', returnedCashAtomic: '995800000' }],
      '2026-08-28T13:00:00.000Z',
    ),
    evaluatedAt: '2026-08-28T13:00:01.000Z',
  });
  assert.deepEqual(next, { evaluated: 1, events: 1, gaps: 0 });
  assert.equal((await repository.eventsForUser({ userId: storedWatch.userId, limit: 20 }))[0]?.kind, 'sell_exit_cost_changed');
});

test('an observation at the watch creation instant is history, not its baseline', async () => {
  const repository = new InMemoryMarketRealityRadarRepositoryV1();
  const seed = watch({ createdAt: '2026-08-28T11:00:00.000Z' });
  const storedWatch = await repository.addWatch({
    userId: seed.userId,
    question: {
      underlyingKey: seed.underlyingKey,
      tokenAddress: seed.tokenAddress,
      direction: seed.direction,
      requestedCashAtomic: seed.requestedCashAtomic,
      destination: seed.destination,
      routePolicyKey: seed.routePolicyKey,
      approvedSources: seed.approvedSources,
    },
    issuerId: seed.issuerId,
    representationKind: seed.representationKind,
    now: seed.createdAt,
  });
  const result = await evaluateMarketRealityRadarRunV1({
    repository,
    run: run([{ source: 'router-a', status: 'quoted' }], seed.createdAt),
    evaluatedAt: '2026-08-28T11:00:01.000Z',
  });
  assert.deepEqual(result, { evaluated: 1, events: 0, gaps: 0 });
  assert.equal(await repository.pointForWatch({ watchId: storedWatch.watchId }), null);
  assert.equal((await repository.watchesForUser({ userId: seed.userId }))[0]?.lastEvaluatedAt, null);
});

test('repository refuses a cursor for a different exact market question', async () => {
  const repository = new InMemoryMarketRealityRadarRepositoryV1();
  const seed = watch();
  const storedWatch = await repository.addWatch({
    userId: seed.userId,
    question: {
      underlyingKey: seed.underlyingKey,
      tokenAddress: seed.tokenAddress,
      direction: seed.direction,
      requestedCashAtomic: seed.requestedCashAtomic,
      destination: seed.destination,
      routePolicyKey: seed.routePolicyKey,
      approvedSources: seed.approvedSources,
    },
    issuerId: seed.issuerId,
    representationKind: seed.representationKind,
    now: seed.createdAt,
  });
  await assert.rejects(
    () =>
      repository.recordEvaluation({
        watch: storedWatch,
        at: '2026-08-28T11:00:01.000Z',
        outcome: 'baseline',
        point: point({ requestedCashAtomic: '10000000000' }),
        events: [],
      }),
    /point does not belong/,
  );
});

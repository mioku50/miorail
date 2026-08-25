import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import type { CashExitMeasurementRunV1 } from '@mioagent/route-storage';

import { cashExitSignalsV1, lookalikeSignalsV1, officialSourceSignalsV1 } from '../src/signals.js';

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const COIN = '0xb200000000000000000000c85a31389d71f3ecfb';
const IMPOSTOR = '0xb200000000000000000000dead0000000000ad01';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// ---------------------------------------------------------------------------
// Every case here is a way this feed could report something that did not
// happen. The recurring one has its own name in this codebase: our failure
// wearing the token's name.
// ---------------------------------------------------------------------------

function observationV1(input: {
  size: string;
  status: 'full' | 'unavailable' | 'measurement_failed';
  returned?: string;
}) {
  const buy =
    input.status === 'full'
      ? {
          routeKey: '0x' + '1'.repeat(64),
          direction: 'buy' as const,
          expiresAt: '2026-08-25T12:00:20.000Z',
          observedAt: '2026-08-25T12:00:00.000Z',
          blockNumber: null,
          inputAtomic: input.size,
          evidenceHash: '0x' + '2'.repeat(64),
          inputAddress: USDC,
          outputAtomic: '32220799',
          candidateHash: '0x' + '1'.repeat(64),
          outputAddress: AAPL,
          liquiditySources: ['aerodrome'],
        }
      : null;
  const sell =
    input.status === 'full'
      ? {
          routeKey: '0x' + '3'.repeat(64),
          direction: 'sell' as const,
          expiresAt: '2026-08-25T12:00:20.000Z',
          observedAt: '2026-08-25T12:00:00.000Z',
          blockNumber: null,
          inputAtomic: '32220799',
          evidenceHash: '0x' + '4'.repeat(64),
          inputAddress: AAPL,
          outputAtomic: input.returned ?? '99902125',
          candidateHash: '0x' + '3'.repeat(64),
          outputAddress: USDC,
          liquiditySources: ['aerodrome'],
        }
      : null;
  return {
    runId: '0x' + '9'.repeat(64),
    scope: 'public_ladder' as const,
    source: 'kyberswap',
    status: input.status,
    chainId: 8453 as const,
    buyQuote: buy,
    sizeKind: 'cash_equivalent' as const,
    tenantId: null,
    errorCode: input.status === 'full' ? null : 'provider_no_route',
    // Always set, including for a refusal: a negative reading has a TTL of its
    // own, and an observation with no expiry projects as `not_measured` — which
    // would quietly turn every "no route" fixture into "nobody looked".
    expiresAt: '2026-08-25T12:00:20.000Z',
    sellQuote: sell,
    observedAt: '2026-08-25T12:00:00.000Z',
    destination: 'USDC' as const,
    tokenSymbol: 'AAPLc',
    tokenAddress: AAPL,
    schemaVersion: 'official-cash-exit-observation/v1' as const,
    tokenDecimals: 8,
    executionProven: false as const,
    observationHash: '0x' + 'a'.repeat(64),
    evidenceStrength: 'router_quote' as const,
    testedTokenAtomic: input.status === 'full' ? '32220799' : null,
    destinationAddress: USDC,
    destinationDecimals: 6 as const,
    requestedCashAtomic: input.size,
    requestedTokenAtomic: null,
  };
}

function runV1(input: {
  runId: string;
  completedAt: string;
  observations: ReturnType<typeof observationV1>[];
}): CashExitMeasurementRunV1 {
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: input.runId,
    chainId: 8453,
    tokenAddress: AAPL,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['kyberswap'],
    destinations: ['USDC'],
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    observations: input.observations.map((observation) => ({
      ...observation,
      runId: input.runId,
    })),
  } as unknown as CashExitMeasurementRunV1;
}

describe('official source transitions', () => {
  const outcome = {
    snapshotId: '77',
    sourceKind: 'base_product_list' as const,
    status: 'ok' as const,
    observedAt: '2026-08-25T11:00:00.000Z',
    added: [AAPL],
    stillListed: [],
    delisted: [COIN],
  };
  const named = new Map([
    [AAPL, { ticker: 'AAPLc', displayName: 'Coinbase AAPL' }],
    [COIN, { ticker: 'COINc', displayName: 'Coinbase COIN' }],
  ]);

  test('an added and a removed asset are two rows tied to the check that saw them', () => {
    const signals = officialSourceSignalsV1({
      outcome,
      named,
      sourceUrl: 'https://brand.base.org/stocks',
    });
    assert.deepEqual(signals.map((signal) => signal.kind), [
      'official_source_added_asset',
      'official_source_removed_asset',
    ]);
    // The snapshot id is in the key, so a later re-add after a delisting is a
    // second row — it happened twice.
    assert.equal(signals[0]!.dedupeKey, `official_source_added_asset:base_product_list:${AAPL}:77`);
    assert.equal(signals[0]!.occurredAt, '2026-08-25T11:00:00.000Z');
  });

  test('a check that did not complete moves nothing', () => {
    // A source that timed out withdraws nothing. Reporting the assets it did
    // not name as delisted would be our outage announced as a delisting.
    for (const status of ['unreachable', 'unparsable'] as const) {
      assert.deepEqual(
        officialSourceSignalsV1({
          outcome: { ...outcome, status, added: [], delisted: [COIN] },
          named,
          sourceUrl: 'https://brand.base.org/stocks',
        }),
        [],
      );
    }
  });

  test('an asset the corpus cannot name is skipped rather than reported as an address', () => {
    const signals = officialSourceSignalsV1({
      outcome: { ...outcome, added: ['0xb200000000000000000000beef0000000000be02'], delisted: [] },
      named,
      sourceUrl: 'https://brand.base.org/stocks',
    });
    assert.deepEqual(signals, []);
  });
});

describe('lookalike transitions', () => {
  const rows = [
    {
      chainId: 8453 as const,
      tokenAddress: IMPOSTOR,
      officialAddress: AAPL,
      matchKind: 'symbol_exact' as const,
      matchedAlias: 'published_ticker' as const,
      matchedValue: 'AAPLc',
      launchSymbol: 'AAPLc',
      launchName: 'Apple',
      launchedAt: '2026-07-01T10:00:00.000Z',
      firstFlaggedAt: '2026-08-25T11:00:00.000Z',
      lastSeenAt: '2026-08-25T11:00:00.000Z',
    },
  ];
  const tickers = new Map([[AAPL, 'AAPLc']]);

  test('only a contract flagged for the first time is news', () => {
    const signals = lookalikeSignalsV1({
      flagged: [IMPOSTOR],
      rows,
      officialTickers: tickers,
      occurredAt: '2026-08-25T11:00:00.000Z',
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.dedupeKey, `official_asset_lookalike_created:${IMPOSTOR}`);
    // Dated to the flag, not to the launch: a token deployed in July at the
    // top of a feed of things that just happened would be a false "now".
    assert.equal(signals[0]!.occurredAt, '2026-08-25T11:00:00.000Z');

    const refreshed = lookalikeSignalsV1({
      flagged: [],
      rows,
      officialTickers: tickers,
      occurredAt: '2026-08-26T11:00:00.000Z',
    });
    assert.deepEqual(refreshed, []);
  });
});

describe('cash exit transitions', () => {
  const noRoute = runV1({
    runId: '0x' + '1'.repeat(64),
    completedAt: '2026-08-25T10:00:00.000Z',
    observations: [observationV1({ size: '100000000', status: 'unavailable' })],
  });
  const withRoute = runV1({
    runId: '0x' + '2'.repeat(64),
    completedAt: '2026-08-25T11:00:00.000Z',
    observations: [observationV1({ size: '100000000', status: 'full' })],
  });

  test('a route appearing where there was none is one signal, naming the size', () => {
    const signals = cashExitSignalsV1({
      previous: noRoute,
      next: withRoute,
      ticker: 'AAPLc',
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.kind, 'official_asset_market_became_active');
    assert.equal((signals[0]!.facts as Record<string, unknown>).requestedCashAtomic, '100000000');
    assert.equal(signals[0]!.occurredAt, '2026-08-25T11:00:00.000Z');
  });

  test('a first measurement is not a market becoming active', () => {
    // Nothing measured it before. "It became reachable" would be a claim about
    // the asset authored entirely by us starting to look.
    assert.deepEqual(
      cashExitSignalsV1({ previous: null, next: withRoute, ticker: 'AAPLc' }).map(
        (signal) => signal.kind,
      ),
      ['official_asset_market_became_active'],
    );
  });

  test('a route disappearing is reported, and a failed measurement is not', () => {
    const lost = cashExitSignalsV1({
      previous: withRoute,
      next: runV1({
        runId: '0x' + '3'.repeat(64),
        completedAt: '2026-08-25T12:00:00.000Z',
        observations: [observationV1({ size: '100000000', status: 'unavailable' })],
      }),
      ticker: 'AAPLc',
    });
    assert.deepEqual(lost.map((signal) => signal.kind), ['official_asset_market_became_unreachable']);

    // Our router call failing says nothing about the market. This is the bug
    // class that has shipped three times under other names.
    const failed = cashExitSignalsV1({
      previous: withRoute,
      next: runV1({
        runId: '0x' + '4'.repeat(64),
        completedAt: '2026-08-25T12:00:00.000Z',
        observations: [observationV1({ size: '100000000', status: 'measurement_failed' })],
      }),
      ticker: 'AAPLc',
    });
    assert.deepEqual(failed, []);
  });

  test('a lapsed quote is still a measurement, so nothing re-fires as it ages', () => {
    // The bug this pins: comparing two runs through the freshness-gated
    // ladder read the previous one as `not_measured` twenty seconds after it
    // was taken, so every hourly pass would announce that the market had just
    // become reachable. What changed between two measurements cannot depend on
    // how long ago they were taken.
    const stale = runV1({
      runId: '0x' + '7'.repeat(64),
      completedAt: '2026-08-20T10:00:00.000Z',
      observations: [observationV1({ size: '100000000', status: 'full' })],
    });
    const later = runV1({
      runId: '0x' + '8'.repeat(64),
      completedAt: '2026-08-25T11:00:00.000Z',
      observations: [observationV1({ size: '100000000', status: 'full' })],
    });
    assert.deepEqual(cashExitSignalsV1({ previous: stale, next: later, ticker: 'AAPLc' }), []);
  });

  test('a cost move under the threshold is our own quote noise, not a change', () => {
    // Measured over six hours on the launch corpus, the median round-trip cost
    // moved by zero. A few basis points is not a market event.
    const barelyMoved = runV1({
      runId: '0x' + '5'.repeat(64),
      completedAt: '2026-08-25T12:00:00.000Z',
      observations: [observationV1({ size: '100000000', status: 'full', returned: '99892125' })],
    });
    assert.deepEqual(
      cashExitSignalsV1({ previous: withRoute, next: barelyMoved, ticker: 'AAPLc' }),
      [],
    );
  });

  test('a cost move past the threshold is one row carrying both readings', () => {
    const moved = runV1({
      runId: '0x' + '6'.repeat(64),
      completedAt: '2026-08-25T12:00:00.000Z',
      observations: [observationV1({ size: '100000000', status: 'full', returned: '97000000' })],
    });
    const signals = cashExitSignalsV1({
      previous: withRoute,
      next: moved,
      ticker: 'AAPLc',
    });
    assert.equal(signals.length, 1);
    const facts = signals[0]!.facts as Record<string, string>;
    assert.equal(signals[0]!.kind, 'official_asset_cash_exit_changed');
    // Both readings and the signed move are STORED, so no surface has to
    // subtract two numbers and can never do it in the wrong order.
    assert.ok(Number(facts.changeBps) > 0);
    assert.equal(
      Number(facts.roundTripCostBps) - Number(facts.previousRoundTripCostBps),
      Number(facts.changeBps),
    );
    assert.equal(facts.thresholdBps as unknown as number, 50);
  });
});

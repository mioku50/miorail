import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type {
  CashExitMeasurementRunV1,
  OfficialCashExitRepositoryV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { assembleMarketRealityHistoryV1 } from '../src/history.js';

const H = `0x${'11'.repeat(32)}` as const;
const CANDIDATE = `0x${'22'.repeat(32)}` as const;
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNDERLYING = 'security:isin:US67066G1040';
const NOW = new Date('2026-08-26T12:00:00.000Z');

function binding(address: string): RepresentationUnderlyingV1 {
  return {
    chainId: 8453,
    tokenAddress: address,
    underlyingKey: UNDERLYING,
    sourceKind: 'backed_assets_api',
    sourceRef: 'https://api.xstocks.fi/api/v1/token?type=btokens',
    sourceHash: 'ab'.repeat(32),
    issuerId: 'backed',
    issuerInstrumentKey: `backed:instrument_id:${address.slice(2, 6)}`,
    caip10: `eip155:8453:${address}`,
    representationKind: 'rebasing_erc20',
    evidenceStrength: 'reviewed_machine_address_mapping',
    observedBlockNumber: null,
    observedBlockHash: null,
    observedAt: '2026-08-20T12:00:00.000Z',
  };
}

function run(input: {
  address: string;
  observedAt: string;
  outputAtomic?: string;
  errorCode?: string | null;
  requestedCashAtomic?: string;
  approvedSources?: string[];
}): CashExitMeasurementRunV1 {
  const quoted = input.errorCode === undefined || input.errorCode === null;
  const size = input.requestedCashAtomic ?? '100000000';
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: H,
    chainId: 8453,
    tokenAddress: input.address,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: input.approvedSources ?? ['router-a'],
    destinations: ['USDC'],
    startedAt: input.observedAt,
    completedAt: input.observedAt,
    observations: [
      {
        schemaVersion: 'official-cash-exit-observation/v1',
        observationHash: H,
        runId: H,
        chainId: 8453,
        tokenAddress: input.address,
        tokenSymbol: 'bNVDA',
        tokenDecimals: 18,
        scope: 'public_ladder',
        tenantId: null,
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: size,
        requestedTokenAtomic: null,
        testedTokenAtomic: quoted ? (input.outputAtomic ?? '500000000000000000') : null,
        destination: 'USDC',
        destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destinationDecimals: 6,
        source: 'router-a',
        status: quoted ? 'full' : 'unavailable',
        evidenceStrength: 'router_quote',
        executionProven: false,
        buyQuote: quoted
          ? {
              direction: 'buy',
              inputAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              outputAddress: input.address,
              inputAtomic: size,
              outputAtomic: input.outputAtomic ?? '500000000000000000',
              routeKey: CANDIDATE,
              candidateHash: CANDIDATE,
              evidenceHash: H,
              observedAt: input.observedAt,
              expiresAt: input.observedAt,
              blockNumber: '50000000',
              liquiditySources: ['pool-a'],
            }
          : null,
        sellQuote: null,
        errorCode: input.errorCode ?? null,
        observedAt: input.observedAt,
        expiresAt: input.observedAt,
      },
    ],
  };
}

function deps(
  runs: Record<string, CashExitMeasurementRunV1[]>,
  bindings = [binding(A), binding(B)],
) {
  return {
    underlyings: {
      representationsOf: async () => bindings,
    } as unknown as UnderlyingAssetRepositoryV1,
    cashExit: {
      completedRunsSince: async ({
        tokenAddress,
        since,
        limit,
      }: {
        tokenAddress: string;
        since: string;
        limit: number;
      }) =>
        (runs[tokenAddress] ?? [])
          .filter((row) => Date.parse(row.completedAt) >= Date.parse(since))
          .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
          .slice(0, limit),
    } as unknown as OfficialCashExitRepositoryV1,
    now: () => NOW,
  };
}

describe('the series is one exact question over time', () => {
  test('points arrive oldest first, whatever order storage returned', async () => {
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({ address: A, observedAt: '2026-08-26T11:00:00.000Z' }),
          run({ address: A, observedAt: '2026-08-26T11:30:00.000Z' }),
          run({ address: A, observedAt: '2026-08-26T10:30:00.000Z' }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.deepEqual(
      series?.points.map((point) => point.observedAt),
      ['2026-08-26T10:30:00.000Z', '2026-08-26T11:00:00.000Z', '2026-08-26T11:30:00.000Z'],
      'a series is read left to right',
    );
    assert.equal(series?.firstObservedAt, '2026-08-26T10:30:00.000Z');
    assert.equal(series?.lastObservedAt, '2026-08-26T11:30:00.000Z');
  });

  test('a run that never asked this size contributes no point', async () => {
    // The comparability rule, applied along time instead of across issuers. A
    // series that mixed $100 and $10,000 would be a chart of the size control.
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({
            address: A,
            observedAt: '2026-08-26T11:00:00.000Z',
            requestedCashAtomic: '10000000000',
          }),
          run({ address: A, observedAt: '2026-08-26T11:30:00.000Z' }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.equal(series?.pointCount, 1);
    assert.equal(series?.points[0]?.observedAt, '2026-08-26T11:30:00.000Z');
  });

  test('a window excludes what is outside it', async () => {
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({ address: A, observedAt: '2026-08-26T11:59:00.000Z' }),
          run({ address: A, observedAt: '2026-08-25T11:59:00.000Z' }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '1h',
      },
    );
    assert.equal(history.representations.find((row) => row.tokenAddress === A)?.pointCount, 1);
    assert.equal(history.since, '2026-08-26T11:00:00.000Z');
  });

  test('a failure is a point, not a gap', async () => {
    // An hour with no route is a fact about the market. Dropping it would turn
    // illiquidity into silence, and silence reads as "nobody looked".
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({ address: A, observedAt: '2026-08-26T11:00:00.000Z' }),
          run({
            address: A,
            observedAt: '2026-08-26T11:30:00.000Z',
            errorCode: 'provider_no_route',
          }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'sell',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.equal(series?.pointCount, 2);
    assert.equal(series?.points[1]?.status, 'no_route');
    assert.equal(series?.points[1]?.returnedCashAtomic, null);
  });

  test('a failed BUY sizing anchor is an unsized SELL, not a route refusal', async () => {
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({
            address: A,
            observedAt: '2026-08-26T11:30:00.000Z',
            errorCode: 'cash_size_anchor_no_route',
          }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'sell',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const point = history.representations.find((row) => row.tokenAddress === A)?.points[0];
    assert.equal(point?.status, 'unsized');
    assert.equal(point?.returnedCashAtomic, null);
    assert.equal(point?.errorCode, 'cash_size_anchor_no_route');
  });

  test('nothing is ever interpolated, and the payload says so', async () => {
    const history = await assembleMarketRealityHistoryV1(deps({ [A]: [], [B]: [] }), {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
      window: '24h',
    });
    assert.equal(history.interpolated, false);
    // An empty series is empty. It is not zero, and it is not a flat line.
    assert.deepEqual(
      history.representations.map((row) => row.pointCount),
      [0, 0],
    );
    assert.deepEqual(
      history.representations.map((row) => row.firstObservedAt),
      [null, null],
    );
  });

  test('each point carries the router set that produced it', async () => {
    // Two points measured through different sets are not comparable. A series
    // that hid the change would show a config change as a market change.
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({
            address: A,
            observedAt: '2026-08-26T11:00:00.000Z',
            approvedSources: ['router-a'],
          }),
          run({
            address: A,
            observedAt: '2026-08-26T11:30:00.000Z',
            approvedSources: ['router-b', 'router-a'],
          }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.deepEqual(series?.points[0]?.approvedSources, ['router-a']);
    assert.deepEqual(series?.points[1]?.approvedSources, ['router-a', 'router-b']);
  });

  test('every representation gets its own series, and they are not aligned', async () => {
    // A representation nobody measured at 11:00 has no value at 11:00. It is
    // not forward-filled from 10:30 and not zero.
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [run({ address: A, observedAt: '2026-08-26T11:00:00.000Z' })],
        [B]: [
          run({ address: B, observedAt: '2026-08-26T11:10:00.000Z' }),
          run({ address: B, observedAt: '2026-08-26T11:20:00.000Z' }),
        ],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    assert.deepEqual(
      history.representations.map((row) => [row.tokenAddress, row.pointCount]),
      [
        [A, 1],
        [B, 2],
      ],
    );
  });

  test('the quoted count never exceeds the point count', async () => {
    // Buy, because these fixtures carry a buy quote — the same fixture read as
    // a SELL question has no sell leg and correctly counts nothing, which is
    // the comparability rule doing its job rather than a bug.
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [
          run({ address: A, observedAt: '2026-08-26T11:00:00.000Z' }),
          run({
            address: A,
            observedAt: '2026-08-26T11:30:00.000Z',
            errorCode: 'provider_no_route',
          }),
        ],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'buy',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.equal(series?.pointCount, 2);
    assert.equal(series?.quotedCount, 1);
  });

  test('a direction the evidence never measured yields points with no quotes', async () => {
    // Not an error and not an empty series: the runs happened, they just did
    // not ask this direction. The points stay so a reader can see that the
    // sampler was running and still learn nothing about selling.
    const history = await assembleMarketRealityHistoryV1(
      deps({
        [A]: [run({ address: A, observedAt: '2026-08-26T11:00:00.000Z' })],
        [B]: [],
      }),
      {
        underlyingKey: UNDERLYING,
        direction: 'sell',
        requestedCashAtomic: '100000000',
        window: '6h',
      },
    );
    const series = history.representations.find((row) => row.tokenAddress === A);
    assert.equal(series?.pointCount, 1);
    assert.equal(series?.quotedCount, 0);
    assert.equal(series?.points[0]?.returnedCashAtomic, null);
  });
});

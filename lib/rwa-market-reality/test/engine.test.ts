import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CashExitMeasurementRunV1,
  OfficialCashExitRepositoryV1,
  RepresentationRatioRepositoryV1,
  RepresentationRatioRowV1,
  RepresentationUnderlyingV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { assembleMarketRealityV1 } from '../src/engine.js';

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
    now: () => new Date('2026-08-26T12:01:00.000Z'),
  };
}

test('ranks only after the same exact-size route policy covers every representation', async () => {
  const result = await assembleMarketRealityV1(
    deps({ [A]: run(A, '500000000000000000'), [B]: run(B, '400000000000000000') }),
    {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '100000000',
    },
  );
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.ranking.status, 'available');
  assert.deepEqual(result.ranking.orderedTokenAddresses, [A, B]);
  assert.ok(
    result.representations.every(
      (row) => row.sources[0]?.simulationEvidence.status === 'not_simulated',
    ),
  );
});

test('provider failure remains measurement_failed and withholds ranking', async () => {
  const result = await assembleMarketRealityV1(
    deps({ [A]: run(A, '500000000000000000'), [B]: run(B, '0', 'provider_timeout') }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  assert.equal(
    result.representations.find((row) => row.tokenAddress === B)?.status,
    'measurement_failed',
  );
  assert.equal(result.coverage.status, 'incomplete');
  assert.equal(result.ranking.status, 'withheld');
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
  const result = await assembleMarketRealityV1(
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
  assert.equal(result.coverage.status, 'incomplete');
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
  const result = await assembleMarketRealityV1(
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
  const result = await assembleMarketRealityV1(
    deps({ [A]: run(A, '500000000000000000') }, { bindings: [binding(A, 'backed:instrument_id:a')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  assert.equal(row.liveness, 'live');
  assert.equal(row.status, 'full');
  assert.equal(row.lastObservation?.open, true);
});

test('a representation nobody ever measured has no observation to show', async () => {
  const result = await assembleMarketRealityV1(
    deps({}, { bindings: [binding(A, 'backed:instrument_id:a')] }),
    { underlyingKey: UNDERLYING, direction: 'buy', requestedCashAtomic: '100000000' },
  );
  const row = result.representations[0]!;
  assert.equal(row.liveness, 'never_measured');
  assert.equal(row.lastObservation, null, 'absence, not a zeroed point');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CashExitMeasurementRunV1,
  MarketRealityReferenceStateV1,
  RepresentationRatioRepositoryV1,
  RepresentationSupplyRepositoryV1,
  UnderlyingAssetRepositoryV1,
} from '@mioagent/route-storage';

import { createMarketRealityEvidenceCaptureV1 } from '../src/capture.js';

const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
const FEED = '0x04689a41629776563e6822f76f2e57d148d28513';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HASH = `0x${'11'.repeat(32)}` as const;
const CANDIDATE = `0x${'22'.repeat(32)}` as const;
const OBSERVED_AT = '2026-08-27T14:00:00.000Z';
const CAPTURED_AT = '2026-08-27T14:00:06.000Z';

function reference(): MarketRealityReferenceStateV1 {
  return {
    status: 'fresh',
    session: 'regular_hours',
    marketSession: 'regular_hours',
    publicationMode: 'live_reference',
    valueAtomic: '10000000000',
    decimals: 8,
    observedAt: '2026-08-27T14:00:05.000Z',
    referenceUpdatedAt: '2026-08-27T13:59:30.000Z',
    freshness: 'fresh',
    referenceSource: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
    referenceAddress: FEED,
    calendar: {
      key: 'us_equities_core_2026_v1',
      sourceUrls: ['https://www.nyse.com/trade/hours-calendars'],
      timeZone: 'America/New_York',
      localDate: '2026-08-27',
      regularOpenMinute: 570,
      regularCloseMinute: 960,
      publicationSessionLocalDate: '2026-08-27',
      publicationSessionOpenMinute: 570,
      publicationSessionCloseMinute: 960,
    },
    evidence: {
      kind: 'chainlink_feed',
      source: 'chainlink_v3_proxy_total_return',
      blockNumber: '50500000',
      blockHash: HASH,
      targetAddress: FEED,
      evidenceHash: HASH,
    },
    comparable: false,
    reasonCode: 'reviewed_calendar_regular_hours',
    reason: 'Reviewed regular hours.',
  };
}

function run(): CashExitMeasurementRunV1 {
  return {
    schemaVersion: 'official-cash-exit-run/v1',
    runId: HASH,
    chainId: 8453,
    tokenAddress: TOKEN,
    scope: 'public_ladder',
    tenantId: null,
    approvedSources: ['router-a'],
    destinations: ['USDC'],
    startedAt: OBSERVED_AT,
    completedAt: CAPTURED_AT,
    observations: [
      {
        schemaVersion: 'official-cash-exit-observation/v1',
        observationHash: HASH,
        runId: HASH,
        chainId: 8453,
        tokenAddress: TOKEN,
        tokenSymbol: 'NVDAc',
        tokenDecimals: 18,
        scope: 'public_ladder',
        tenantId: null,
        sizeKind: 'cash_equivalent',
        requestedCashAtomic: '100000000',
        requestedTokenAtomic: null,
        testedTokenAtomic: '500000000000000000',
        destination: 'USDC',
        destinationAddress: USDC,
        destinationDecimals: 6,
        source: 'router-a',
        status: 'full',
        evidenceStrength: 'router_quote',
        executionProven: false,
        buyQuote: {
          direction: 'buy',
          inputAddress: USDC,
          outputAddress: TOKEN,
          inputAtomic: '100000000',
          outputAtomic: '500000000000000000',
          routeKey: CANDIDATE,
          candidateHash: CANDIDATE,
          evidenceHash: HASH,
          observedAt: OBSERVED_AT,
          expiresAt: '2026-08-27T14:00:20.000Z',
          blockNumber: '50500000',
          liquiditySources: ['pool-a'],
        },
        sellQuote: {
          direction: 'sell',
          inputAddress: TOKEN,
          outputAddress: USDC,
          inputAtomic: '500000000000000000',
          outputAtomic: '105000000',
          routeKey: CANDIDATE,
          candidateHash: CANDIDATE,
          evidenceHash: HASH,
          observedAt: OBSERVED_AT,
          expiresAt: '2026-08-27T14:00:20.000Z',
          blockNumber: '50500000',
          liquiditySources: ['pool-a'],
        },
        errorCode: null,
        observedAt: OBSERVED_AT,
        expiresAt: '2026-08-27T14:00:20.000Z',
      },
    ],
  };
}

test('write-time capture stores exact BUY and SELL basis with one multiplier application', async () => {
  let referenceReads = 0;
  const capture = createMarketRealityEvidenceCaptureV1({
    underlyings: {
      underlyingOf: async () => ({
        underlying: {
          underlyingKey: 'security:isin:US67066G1040',
          assetClass: 'equity',
          canonicalName: 'NVIDIA Corporation',
          displaySymbol: 'NVDA',
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          sourceKind: 'coinbase_b20_metadata',
          sourceRef: 'base-docs',
          sourceHash: 'ab'.repeat(32),
          observedAt: OBSERVED_AT,
        },
        binding: {
          chainId: 8453,
          tokenAddress: TOKEN,
          underlyingKey: 'security:isin:US67066G1040',
          sourceKind: 'coinbase_b20_metadata',
          sourceRef: 'base-docs',
          sourceHash: 'ab'.repeat(32),
          issuerId: 'coinbase',
          issuerInstrumentKey: 'coinbase:b20:nvda',
          caip10: `eip155:8453:${TOKEN}`,
          representationKind: 'b20_asset',
          evidenceStrength: 'reviewed_machine_mapping_with_onchain_cross_check',
          observedBlockNumber: '50500000',
          observedBlockHash: HASH,
          observedAt: OBSERVED_AT,
        },
      }),
    } as unknown as UnderlyingAssetRepositoryV1,
    ratios: {
      readRatios: async () => [
        {
          chainId: 8453,
          tokenAddress: TOKEN,
          ratioKind: 'b20_multiplier',
          application: 'apply_to_raw_balance',
          rawValue: '2000000000000000000',
          scale: '1000000000000000000',
          scaleSource: 'read_from_contract',
          blockNumber: '50500000',
          blockHash: HASH,
          evidenceHash: HASH,
          observedAt: OBSERVED_AT,
          lastCheckedAt: OBSERVED_AT,
          lastChangedAt: null,
          reads: 1,
          changes: 0,
          createdAt: OBSERVED_AT,
        },
      ],
    } as unknown as RepresentationRatioRepositoryV1,
    supplies: {
      readSupplies: async () => [
        {
          chainId: 8453,
          tokenAddress: TOKEN,
          state: 'positive_supply',
          totalSupplyAtomic: '1000000000000000000',
          decimals: 18,
          normalization: 'raw_erc20_total_supply',
          blockNumber: '50500000',
          blockHash: HASH,
          source: 'erc20_total_supply',
          evidenceHash: HASH,
          readOutcome: 'success',
          failureCode: null,
          observedAt: OBSERVED_AT,
          lastCheckedAt: OBSERVED_AT,
          lastChangedAt: null,
          reads: 1,
          changes: 0,
          createdAt: OBSERVED_AT,
        },
      ],
    } as unknown as RepresentationSupplyRepositoryV1,
    now: () => new Date(CAPTURED_AT),
    reference: async () => {
      referenceReads += 1;
      return reference();
    },
  });

  const snapshots = await capture(run());
  assert.equal(referenceReads, 1);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(
    snapshots.map((row) => [
      row.direction,
      row.normalizedExposureAtomic,
      row.effectivePriceAtomic,
      row.basis.kind,
      row.basis.premiumDiscountBps,
    ]),
    [
      ['buy', '1000000000000000000', '10000000000', 'current_reference', '0'],
      ['sell', '1000000000000000000', '10500000000', 'current_reference', '500'],
    ],
  );
  assert.ok(snapshots.every((row) => row.snapshotHash.startsWith('0x')));
});

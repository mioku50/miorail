import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryMarketRealityRadarRepositoryV1 } from '@mioagent/rwa-market-reality';

import {
  rwaMarketRealityRouter,
  rwaMarketRealityRuntime,
  stockSellTermsLimiterV1,
  STOCK_SELL_TERMS_PER_MINUTE_V1,
} from './rwaMarketReality.js';
import { issueStockActionDraftV1 } from '../lib/stockActionDraft.js';
import {
  STOCKS_BENCH_ADDRESSES_V1,
  STOCKS_BENCH_CORPUS_V1,
  STOCKS_BENCH_NOW_V1,
} from '../lib/stocksBenchCorpus.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const USER = { id: `eip155:8453:${WALLET}`, address: WALLET, chainId: 8453 as const };
const UNDERLYING = 'security:isin:US67066G1040';
const originalRuntime = { ...rwaMarketRealityRuntime };

function app(user: typeof USER | null = USER) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (user) Object.defineProperty(req, 'session', { configurable: true, value: { user } });
    next();
  });
  server.use('/api/route-intelligence', rwaMarketRealityRouter);
  return server;
}

afterEach(() => {
  Object.assign(rwaMarketRealityRuntime, originalRuntime);
});

beforeEach(() => {
  rwaMarketRealityRuntime.enabled = () => true;
});

describe('GET multi-issuer Market Reality', () => {
  test('requires a valid Base tenant session before storage', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=buy&requestedCashAtomic=100000000`,
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('requires one exact positive size and direction', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('input validation must stop first');
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=buy&requestedCashAtomic=100.5`,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_market_reality_question');
  });

  test('passes the exact question and keeps ranking withheld without comparable coverage', async () => {
    let supplied: unknown = null;
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.assemble = async (_deps, input) => {
      supplied = input;
      return {
        schemaVersion: 'market-reality/v2',
        question: {
          chainId: 8453,
          underlyingKey: input.underlyingKey,
          direction: input.direction,
          requestedCashAtomic: input.requestedCashAtomic,
          cashAsset: 'USDC',
          cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          cashDecimals: 6,
          destination: input.destination ?? 'USDC',
          exactSizeOnly: true,
          baseOnly: true,
        },
        universe: {
          reviewedRepresentationCount: 0,
          positiveSupplyRepresentationCount: 0,
          zeroSupplyRepresentationCount: 0,
          unresolvedSupplyRepresentationCount: 0,
        },
        marketOutcomeCoverage: {
          policy: 'same_reviewed_router_policy_exact_size_direction_and_destination',
          eligibleRepresentationCount: 0,
          establishedOutcomeCount: 0,
          status: 'incomplete',
          reason: 'No reviewed representation is bound to this exact underlying.',
        },
        numericComparisonCoverage: {
          policy: 'fresh_numeric_quotes_same_exact_question_and_normalization',
          eligibleRepresentationCount: 0,
          pricedRepresentationCount: 0,
          status: 'incomplete',
          reason: 'No reviewed representation is bound to this exact underlying.',
        },
        ranking: {
          status: 'withheld',
          policy: 'withheld_phase_10b8',
          orderedTokenAddresses: [],
          reason: 'Coverage comparability did not pass; no BEST representation is emitted.',
        },
        quoteEvidenceIsExecutionProof: false,
        representations: [],
        assembledAt: '2026-08-26T18:00:00.000Z',
      };
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}?direction=sell&requestedCashAtomic=100000000&destination=USDC`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.ranking.status, 'withheld');
    assert.deepEqual(supplied, {
      underlyingKey: UNDERLYING,
      direction: 'sell',
      requestedCashAtomic: '100000000',
      destination: 'USDC',
    });
  });
});

describe('GET the reviewed-securities chooser', () => {
  test('a static path is not read as an underlying key', async () => {
    // Express matches in declaration order, so `/rwa/underlyings` sitting
    // behind `/rwa/market-reality/:underlyingKey` would be unreachable. It is
    // a different route entirely, and this proves it resolves as one.
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.assembleIndex = async () => ({
      schemaVersion: 'market-reality-index/v1' as const,
      chainId: 8453 as const,
      scope: 'coinbase_b20' as const,
      entries: [
        {
          underlyingKey: UNDERLYING,
          canonicalName: 'NVIDIA Corporation',
          displaySymbol: null,
          assetClass: 'equity' as const,
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          representationCount: 3,
          liveRepresentationCount: 3,
          issuerIds: ['backed' as const, 'coinbase' as const],
          multiIssuer: true,
          coinbaseIssued: true,
        },
      ],
      totals: {
        underlyings: 19,
        boundRepresentations: 25,
        multiIssuerUnderlyings: 2,
        coinbaseUnderlyings: 13,
        allUnderlyings: 35,
      },
      observedAt: new Date().toISOString(),
    });
    const response = await request(app()).get('/api/route-intelligence/rwa/underlyings');
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 'market-reality-index/v1');
    assert.equal(response.body.entries[0].multiIssuer, true);
    // The headline is corpus-wide, never the page: one entry, two comparable.
    assert.equal(response.body.totals.multiIssuerUnderlyings, 2);
  });

  test('the chooser refuses a session the way every other read does', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get('/api/route-intelligence/rwa/underlyings');
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('absent storage is a 503, never an empty corpus', async () => {
    // An empty list would read as "no issuer has published anything on Base",
    // which is a claim about the world rather than about this deployment.
    rwaMarketRealityRuntime.migrationAvailable = async () => false;
    const response = await request(app()).get('/api/route-intelligence/rwa/underlyings');
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'market_reality_storage_unavailable');
  });
});

describe('POST the live measurement', () => {
  test('reports what it spent, not just what it found', async () => {
    // A surface must be able to say "everything was already current" rather
    // than implying it refreshed. The counts are the difference.
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.coordinator = () =>
      ({
        inFlightCount: () => 0,
        measure: async () => ({
          answer: {
            schemaVersion: 'market-reality/v2' as const,
            question: {
              chainId: 8453 as const,
              underlyingKey: UNDERLYING,
              direction: 'sell' as const,
              requestedCashAtomic: '100000000',
              cashAsset: 'USDC' as const,
              cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
              cashDecimals: 6 as const,
              destination: 'USDC' as const,
              exactSizeOnly: true as const,
              baseOnly: true as const,
            },
            universe: {
              reviewedRepresentationCount: 0,
              positiveSupplyRepresentationCount: 0,
              zeroSupplyRepresentationCount: 0,
              unresolvedSupplyRepresentationCount: 0,
            },
            marketOutcomeCoverage: {
              policy: 'same_reviewed_router_policy_exact_size_direction_and_destination' as const,
              eligibleRepresentationCount: 0,
              establishedOutcomeCount: 0,
              status: 'incomplete' as const,
              reason: 'nothing bound',
            },
            numericComparisonCoverage: {
              policy: 'fresh_numeric_quotes_same_exact_question_and_normalization' as const,
              eligibleRepresentationCount: 0,
              pricedRepresentationCount: 0,
              status: 'incomplete' as const,
              reason: 'nothing priced',
            },
            ranking: {
              status: 'withheld' as const,
              policy: 'withheld_phase_10b8' as const,
              orderedTokenAddresses: [],
              reason: 'no coverage',
            },
            quoteEvidenceIsExecutionProof: false as const,
            representations: [],
            assembledAt: new Date().toISOString(),
          },
          measured: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
          reusedOpen: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
          reusedCooldown: [],
          excludedZeroSupply: [],
          unresolved: [],
          joinedInFlight: false,
        }),
      }) as unknown as ReturnType<typeof rwaMarketRealityRuntime.coordinator>;

    process.env.BASE_MAINNET_RPC_URL = 'https://example.invalid/rpc';
    const response = await request(app()).post(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/measure?direction=sell&requestedCashAtomic=100000000`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.measurement.measured, [
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
    assert.deepEqual(response.body.measurement.reusedOpen, [
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    // A quote is never execution, on the write path exactly as on the read.
    assert.equal(response.body.quoteEvidenceIsExecutionProof, false);
  });

  test('measuring refuses a session the way reading does', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).post(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/measure?direction=sell&requestedCashAtomic=100000000`,
    );
    assert.equal(response.status, 401);
  });

  test('an inexact size is refused before a router is called', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('validation must stop first');
    };
    const response = await request(app()).post(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/measure?direction=sell&requestedCashAtomic=100.5`,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_market_reality_question');
  });
});

describe('GET the comparable series', () => {
  test('a window outside the reviewed set is refused', async () => {
    // An unbounded window is a table scan wearing a query string.
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('validation must stop first');
    };
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/history?direction=sell&requestedCashAtomic=100000000&window=all`,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_history_window');
  });

  test('a series says it was never interpolated', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.assembleHistory = async () => ({
      schemaVersion: 'market-reality-history/v1' as const,
      chainId: 8453 as const,
      underlyingKey: UNDERLYING,
      direction: 'sell' as const,
      requestedCashAtomic: '100000000',
      destination: 'USDC' as const,
      window: '24h' as const,
      since: new Date(Date.now() - 86_400_000).toISOString(),
      interpolated: false as const,
      representations: [],
      assembledAt: new Date().toISOString(),
    });
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/history?direction=sell&requestedCashAtomic=100000000&window=24h`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.interpolated, false);
    assert.equal(response.body.window, '24h');
  });
});

describe('Market Reality Radar', () => {
  const TOKEN = '0xb20000000000000000000078ee7ce2fe4908108c';
  const POLICY = `0x${'11'.repeat(32)}`;

  function radarAnswer() {
    return {
      schemaVersion: 'market-reality/v2' as const,
      question: {
        chainId: 8453 as const,
        underlyingKey: UNDERLYING,
        direction: 'sell' as const,
        requestedCashAtomic: '1000000000',
        cashAsset: 'USDC' as const,
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        cashDecimals: 6 as const,
        destination: 'USDC' as const,
        exactSizeOnly: true as const,
        baseOnly: true as const,
      },
      universe: {
        reviewedRepresentationCount: 1,
        positiveSupplyRepresentationCount: 1,
        zeroSupplyRepresentationCount: 0,
        unresolvedSupplyRepresentationCount: 0,
      },
      marketOutcomeCoverage: {
        policy: 'same_reviewed_router_policy_exact_size_direction_and_destination' as const,
        eligibleRepresentationCount: 1,
        establishedOutcomeCount: 0,
        status: 'incomplete' as const,
        reason: 'The current quote expired.',
      },
      numericComparisonCoverage: {
        policy: 'fresh_numeric_quotes_same_exact_question_and_normalization' as const,
        eligibleRepresentationCount: 1,
        pricedRepresentationCount: 0,
        status: 'incomplete' as const,
        reason: 'The current quote expired.',
      },
      ranking: {
        status: 'withheld' as const,
        policy: 'withheld_phase_10b8' as const,
        orderedTokenAddresses: [],
        reason: 'Ranking is withheld.',
      },
      quoteEvidenceIsExecutionProof: false as const,
      representations: [
        {
          tokenAddress: TOKEN,
          issuerId: 'coinbase' as const,
          issuerInstrumentKey: `coinbase:b20_address:${TOKEN}`,
          representationKind: 'b20_asset' as const,
          supply: {
            state: 'positive_supply' as const,
            totalSupplyAtomic: '1000000000000000000',
            decimals: 18,
            normalization: 'raw_erc20_total_supply' as const,
            blockNumber: '50000000',
            blockHash: `0x${'22'.repeat(32)}`,
            observedAt: '2026-08-28T10:00:00.000Z',
            evidenceHash: `0x${'33'.repeat(32)}`,
            source: 'erc20_total_supply' as const,
            readOutcome: 'success' as const,
            fresh: true,
            reason: null,
          },
          status: 'not_measured' as const,
          routePolicyKey: POLICY,
          exactTestedTokenAtomic: null,
          normalizedExposureAtomic: null,
          normalizedExposureDecimals: null,
          normalization: 'not_established' as const,
          normalizationCheckedAt: null,
          normalizationExpiresAt: null,
          returnedCashAtomic: null,
          effectivePriceAtomic: null,
          effectivePriceDecimals: null,
          premiumDiscountBps: null,
          reference: {
            status: 'unknown' as const,
            session: 'unknown' as const,
            marketSession: 'unknown' as const,
            publicationMode: 'unknown' as const,
            valueAtomic: null,
            decimals: null,
            observedAt: null,
            referenceUpdatedAt: null,
            freshness: 'unknown' as const,
            referenceSource: null,
            referenceAddress: null,
            calendar: null,
            evidence: null,
            comparable: false as const,
            reasonCode: 'reference_adapter_not_configured' as const,
            reason: 'No adapter needed to validate this watch.',
          },
          basis: {
            policy: 'exact_normalized_price_same_quote_window_reviewed_publication_v1' as const,
            status: 'withheld' as const,
            kind: 'withheld' as const,
            premiumDiscountBps: null,
            reasonCode: 'expired_quote' as const,
            reason: 'The last quote is history.',
          },
          sources: [
            {
              source: 'router-a',
              status: 'not_measured' as const,
              errorCode: null,
              quoteEvidence: null,
              simulationEvidence: {
                kind: 'route_simulation' as const,
                status: 'not_simulated' as const,
                evidenceHash: null,
              },
            },
          ],
          observedAt: null,
          expiresAt: null,
          liveness: 'history_only' as const,
          lastObservation: {
            source: 'router-a',
            status: 'quoted' as const,
            errorCode: null,
            observedAt: '2026-08-28T09:00:00.000Z',
            expiresAt: '2026-08-28T09:00:20.000Z',
            returnedCashAtomic: '999000000',
            open: false,
          },
        },
      ],
      assembledAt: '2026-08-28T10:00:00.000Z',
    };
  }

  function bindingRepository() {
    return {
      representationsOf: async () => [
        {
          chainId: 8453,
          tokenAddress: TOKEN,
          underlyingKey: UNDERLYING,
          sourceKind: 'coinbase_b20_metadata',
          sourceRef: 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base',
          sourceHash: 'aa'.repeat(32),
          issuerId: 'coinbase',
          issuerInstrumentKey: `coinbase:b20_address:${TOKEN}`,
          caip10: `eip155:8453:${TOKEN}`,
          representationKind: 'b20_asset',
          evidenceStrength: 'reviewed_machine_mapping_with_onchain_cross_check',
          observedBlockNumber: '50000000',
          observedBlockHash: `0x${'44'.repeat(32)}`,
          observedAt: '2026-08-28T09:00:00.000Z',
        },
      ],
    } as unknown as ReturnType<typeof rwaMarketRealityRuntime.underlyings>;
  }

  test('requires the Base tenant before reading Radar storage', async () => {
    rwaMarketRealityRuntime.radarAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).get('/api/route-intelligence/rwa/radar');
    assert.equal(response.status, 401);
    assert.equal(response.body.code, 'authentication_required');
  });

  test('adds only a server-verified exact representation and route policy', async () => {
    const radar = new InMemoryMarketRealityRadarRepositoryV1();
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.radarAvailable = async () => true;
    rwaMarketRealityRuntime.radar = () => radar;
    rwaMarketRealityRuntime.underlyings = bindingRepository;
    rwaMarketRealityRuntime.assemble = async () => radarAnswer();
    rwaMarketRealityRuntime.now = () => new Date('2026-08-28T10:05:00.000Z');

    const response = await request(app())
      .post('/api/route-intelligence/rwa/radar/watches')
      .send({
        underlyingKey: UNDERLYING,
        tokenAddress: TOKEN,
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['router-a'],
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.schemaVersion, 'market-reality-radar/v1');
    assert.equal(response.body.watches.length, 1);
    assert.equal(response.body.watches[0].tokenAddress, TOKEN);
    assert.equal('userId' in response.body.watches[0], false);
  });

  test('a stale client policy is refused rather than silently rewritten', async () => {
    const radar = new InMemoryMarketRealityRadarRepositoryV1();
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.radarAvailable = async () => true;
    rwaMarketRealityRuntime.radar = () => radar;
    rwaMarketRealityRuntime.underlyings = bindingRepository;
    rwaMarketRealityRuntime.assemble = async () => radarAnswer();
    const response = await request(app())
      .post('/api/route-intelligence/rwa/radar/watches')
      .send({
        underlyingKey: UNDERLYING,
        tokenAddress: TOKEN,
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
        routePolicyKey: `0x${'ff'.repeat(32)}`,
        approvedSources: ['router-a'],
      });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'radar_question_not_watchable');
    assert.deepEqual(await radar.watchesForUser({ userId: USER.id }), []);
  });

  test('one tenant cannot remove another tenant’s watch', async () => {
    const radar = new InMemoryMarketRealityRadarRepositoryV1();
    const other = 'eip155:8453:0x2222222222222222222222222222222222222222';
    const stored = await radar.addWatch({
      userId: other,
      question: {
        underlyingKey: UNDERLYING,
        tokenAddress: TOKEN,
        direction: 'sell',
        requestedCashAtomic: '1000000000',
        destination: 'USDC',
        routePolicyKey: POLICY,
        approvedSources: ['router-a'],
      },
      issuerId: 'coinbase',
      representationKind: 'b20_asset',
      now: '2026-08-28T10:00:00.000Z',
    });
    rwaMarketRealityRuntime.radarAvailable = async () => true;
    rwaMarketRealityRuntime.radar = () => radar;
    const response = await request(app()).delete(
      `/api/route-intelligence/rwa/radar/watches/${stored.watchId}`,
    );
    assert.equal(response.status, 200);
    assert.equal((await radar.watchesForUser({ userId: other })).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Phase 13.2 — Ask Miorail.
//
// The property under test is not "does the model answer well" — 13.2A measured
// that. It is that the surface cannot be made to establish anything: the
// evidence is the page's own, the verifier decides what ships, and every
// failure lands on the deterministic answer.
// ---------------------------------------------------------------------------

describe('POST Ask Miorail about the exact question on screen', () => {
  const ASK = `/api/route-intelligence/rwa/market-reality/${UNDERLYING}/ask?direction=buy&requestedCashAtomic=1000000000`;

  /** The smallest answer the assembler can return that still has a subject. */
  function assembled() {
    const address = '0xb20000000000000000000078ee7ce2fe4908108c';
    return {
      schemaVersion: 'market-reality/v2' as const,
      question: {
        chainId: 8453 as const,
        underlyingKey: UNDERLYING,
        direction: 'buy' as const,
        requestedCashAtomic: '1000000000',
        cashAsset: 'USDC' as const,
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        cashDecimals: 6 as const,
        destination: 'USDC' as const,
        exactSizeOnly: true as const,
        baseOnly: true as const,
      },
      universe: {
        reviewedRepresentationCount: 1,
        positiveSupplyRepresentationCount: 1,
        zeroSupplyRepresentationCount: 0,
        unresolvedSupplyRepresentationCount: 0,
      },
      marketOutcomeCoverage: {
        policy: 'same_reviewed_router_policy_exact_size_direction_and_destination' as const,
        eligibleRepresentationCount: 1,
        establishedOutcomeCount: 0,
        status: 'incomplete' as const,
        reason: 'No representation produced an established outcome.',
      },
      numericComparisonCoverage: {
        policy: 'fresh_numeric_quotes_same_exact_question_and_normalization' as const,
        eligibleRepresentationCount: 1,
        pricedRepresentationCount: 0,
        status: 'incomplete' as const,
        reason: 'No representation carries a fresh numeric quote.',
      },
      ranking: {
        status: 'withheld' as const,
        policy: 'withheld_phase_10b8' as const,
        orderedTokenAddresses: [],
        reason: 'Ranking is withheld.',
      },
      quoteEvidenceIsExecutionProof: false as const,
      representations: [
        {
          tokenAddress: address,
          issuerId: 'coinbase' as const,
          issuerInstrumentKey: `coinbase:b20_address:${address}`,
          representationKind: 'b20_asset' as const,
          supply: {
            state: 'positive_supply' as const,
            totalSupplyAtomic: '4820000000000000000000',
            decimals: 18,
            normalization: 'raw_erc20_total_supply' as const,
            blockNumber: '50612000',
            blockHash: `0x${'11'.repeat(32)}`,
            observedAt: '2026-08-29T17:58:00.000Z',
            evidenceHash: `0x${'11'.repeat(32)}`,
            source: 'erc20_total_supply' as const,
            readOutcome: 'success' as const,
            fresh: true,
            reason: null,
          },
          status: 'unavailable' as const,
          routePolicyKey: `0x${'b5'.repeat(32)}`,
          exactTestedTokenAtomic: null,
          normalizedExposureAtomic: null,
          normalizedExposureDecimals: null,
          normalization: 'not_established' as const,
          normalizationCheckedAt: null,
          normalizationExpiresAt: null,
          returnedCashAtomic: null,
          effectivePriceAtomic: null,
          effectivePriceDecimals: null,
          premiumDiscountBps: null,
          reference: {
            status: 'unknown' as const,
            session: 'unknown' as const,
            marketSession: 'unknown' as const,
            publicationMode: 'unknown' as const,
            valueAtomic: null,
            decimals: null,
            observedAt: null,
            referenceUpdatedAt: null,
            freshness: 'unknown' as const,
            referenceSource: null,
            referenceAddress: null,
            calendar: null,
            evidence: null,
            comparable: false as const,
            reasonCode: 'issuer_reference_not_reviewed' as const,
            reason: 'No reviewed reference source.',
          },
          basis: {
            policy:
              'exact_normalized_price_same_quote_window_reviewed_publication_v1' as const,
            status: 'withheld' as const,
            kind: 'withheld' as const,
            premiumDiscountBps: null,
            reasonCode: 'no_route' as const,
            reason: 'No reviewed router returned a route at this exact size.',
          },
          sources: [
            {
              source: 'kyberswap',
              status: 'no_route' as const,
              errorCode: 'no_route_at_exact_size',
              quoteEvidence: null,
              simulationEvidence: {
                kind: 'route_simulation' as const,
                status: 'not_simulated' as const,
                evidenceHash: null,
              },
            },
          ],
          observedAt: '2026-08-29T17:59:40.000Z',
          expiresAt: '2026-08-29T18:00:20.000Z',
          liveness: 'live' as const,
          lastObservation: {
            source: 'kyberswap',
            status: 'no_route' as const,
            errorCode: 'no_route_at_exact_size',
            observedAt: '2026-08-29T17:59:40.000Z',
            expiresAt: '2026-08-29T18:00:20.000Z',
            returnedCashAtomic: null,
            open: true,
          },
        },
      ],
      assembledAt: '2026-08-29T18:00:00.000Z',
    };
  }

  function ready() {
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.assemble = async () => assembled() as never;
    rwaMarketRealityRuntime.narrator = () => null;
  }

  test('requires a session before it reads anything', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('authentication must stop first');
    };
    const response = await request(app(null)).post(ASK).send({ question: 'what does it cost?' });
    assert.equal(response.status, 401);
  });

  test('requires a question, and bounds it', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('input validation must stop first');
    };
    for (const body of [{}, { question: '   ' }, { question: 'x'.repeat(1_001) }]) {
      const response = await request(app()).post(ASK).send(body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(response.body.code, 'invalid_question');
    }
  });

  test('answers from the deterministic evidence when no provider is configured', async () => {
    ready();
    const response = await request(app())
      .post(ASK)
      .send({ question: 'Почему нет цены на выходе?' });
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 'stocks-ask/v1');
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    assert.equal(response.body.refused, false);
    assert.ok(response.body.answer.established.length > 0);
    assert.ok(response.body.evidence.length > 0, 'the provenance rows travel with the answer');
  });

  test('the answer is about the question on screen, and echoes it', async () => {
    // A reader must never be shown an answer to a different size than the one
    // they are looking at.
    ready();
    const response = await request(app()).post(ASK).send({ question: 'what does it cost?' });
    assert.deepEqual(response.body.question, {
      underlyingKey: UNDERLYING,
      direction: 'buy',
      requestedCashAtomic: '1000000000',
      destination: 'USDC',
      asked: 'what does it cost?',
    });
  });

  test('every citation the answer makes resolves to a row that travelled with it', async () => {
    ready();
    const response = await request(app()).post(ASK).send({ question: 'what is established?' });
    const ids = new Set((response.body.evidence as { id: string }[]).map((row) => row.id));
    for (const claim of response.body.answer.established as { sourceIds: string[] }[]) {
      for (const id of claim.sourceIds) {
        assert.ok(ids.has(id), `${id} is cited and not supplied`);
      }
    }
  });

  test('a question this product does not measure is refused before any read', async () => {
    rwaMarketRealityRuntime.migrationAvailable = async () => {
      throw new Error('a refusal must not reach storage');
    };
    rwaMarketRealityRuntime.assemble = async () => {
      throw new Error('a refusal must not assemble evidence');
    };
    for (const asked of ['should i buy this?', 'какой прогноз по цене?', 'стоит ли покупать?']) {
      const response = await request(app()).post(ASK).send({ question: asked });
      assert.equal(response.status, 200, asked);
      assert.equal(response.body.refused, true, asked);
      assert.equal(response.body.answerSource, 'deterministic_evidence');
      assert.deepEqual(response.body.evidence, [], 'a refusal reads nothing');
    }
  });

  test('a narration that fabricates is discarded, and the reader gets the evidence', async () => {
    ready();
    rwaMarketRealityRuntime.narrator = () => ({
      async generate() {
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({
              subjects: ['0xb20000000000000000000078ee7ce2fe4908108c'],
              established: [
                { claim: 'It returned 4321.99 USDC at this size.', sourceIds: ['e1'] },
              ],
              notEstablished: [],
              explanation: 'This token is safe and liquid.',
              sources: ['e1'],
            }),
          },
        };
      },
    });
    const response = await request(app()).post(ASK).send({ question: 'what does it cost?' });
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    const text = JSON.stringify(response.body.answer);
    assert.equal(text.includes('4321.99'), false, 'an invented figure never reaches the reader');
    assert.equal(text.includes('liquid'), false, 'a judgement never reaches the reader');
  });

  test('a provider that fails costs the reader nothing', async () => {
    ready();
    rwaMarketRealityRuntime.narrator = () => ({
      async generate() {
        throw new Error('OpenAI API error (429): https://provider.example/v1 key=secret');
      },
    });
    const response = await request(app()).post(ASK).send({ question: 'what does it cost?' });
    assert.equal(response.status, 200);
    assert.equal(response.body.answerSource, 'deterministic_evidence');
    // The failure is operator-facing. Nothing about the provider — and above
    // all no URL, which carries a key — reaches the payload.
    const body = JSON.stringify(response.body);
    assert.equal(body.includes('provider.example'), false);
    assert.equal(body.includes('secret'), false);
    assert.equal(body.includes('429'), false);
  });

  test('the payload states it is read-only, and carries no execution field', async () => {
    ready();
    const response = await request(app()).post(ASK).send({ question: 'what does it cost?' });
    assert.equal(response.body.quoteOnly, true);
    assert.equal(response.body.executionEvidenceIncluded, false);
    const body = JSON.stringify(response.body);
    for (const forbidden of [
      'calldata',
      'wallet_sendCalls',
      'blueprintId',
      'signer',
      'privateKey',
      'approval',
      'transaction',
    ]) {
      assert.equal(body.includes(forbidden), false, `the payload carries ${forbidden}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Connected Intelligence 1 — the review is the authority for live terms.
// ---------------------------------------------------------------------------

describe('GET the review a stock action draft points at', () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const CASE = (id: string) => STOCKS_BENCH_CORPUS_V1.find((row) => row.id === id)!.reality;
  const MIXED = CASE('J');
  const COINBASE = STOCKS_BENCH_ADDRESSES_V1.COINBASE_NVDA;
  const NOW = new Date(STOCKS_BENCH_NOW_V1);

  const draftFor = (
    over: { tenantId?: string; wallet?: string; ttlMs?: number; policy?: string } = {},
  ) => {
    const representation = MIXED.representations.find((row) => row.tokenAddress === COINBASE)!;
    const wallet = over.wallet ?? WALLET;
    return issueStockActionDraftV1({
      tenantId: over.tenantId ?? `eip155:8453:${wallet}`,
      walletAddress: wallet,
      secret: 'review-test-secret',
      now: NOW,
      ttlMs: over.ttlMs,
      handoff: {
        schemaVersion: 'stock-execution-handoff/v1',
        intent: 'inspect_route',
        chainId: 8453,
        tokenAddress: COINBASE,
        caip10: `eip155:8453:${COINBASE}`,
        underlyingKey: MIXED.question.underlyingKey,
        issuerId: representation.issuerId,
        issuerInstrumentKey: representation.issuerInstrumentKey,
        representationKind: representation.representationKind,
        direction: MIXED.question.direction,
        requestedCashAtomic: MIXED.question.requestedCashAtomic,
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destination: 'USDC',
        routePolicyKey: over.policy ?? representation.routePolicyKey!,
        approvedSources: ['kyberswap'],
        evidenceState: 'fresh_quote',
        quoteExpiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
        sizeBasis: 'cash_equivalent_requires_replan',
        createsApproval: false,
        createsCalldata: false,
        createsTransaction: false,
        quoteIsExecutionEvidence: false,
      } as never,
    }).draft;
  };

  beforeEach(() => {
    process.env.SESSION_SECRET = 'review-test-secret';
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.now = () => NOW;
    rwaMarketRealityRuntime.assemble = (async () => MIXED) as never;
  });

  test('a signed-out reader is refused before anything is read', async () => {
    let assembled = 0;
    rwaMarketRealityRuntime.assemble = (async () => {
      assembled += 1;
      return MIXED;
    }) as never;
    const response = await request(app(null)).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 401);
    assert.equal(assembled, 0);
  });

  test('another wallet cannot open one account’s review', async () => {
    const response = await request(app({ id: `eip155:8453:${OTHER}`, address: OTHER, chainId: 8453 }))
      .get(`/api/route-intelligence/rwa/stock-action/${draftFor()}`);
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'stock_action_draft_wrong_wallet');
  });

  test('an expired draft is refused, and its question is never assembled', async () => {
    const draft = draftFor({ ttlMs: 60_000 });
    rwaMarketRealityRuntime.now = () => new Date(NOW.getTime() + 61_000);
    let assembled = 0;
    rwaMarketRealityRuntime.assemble = (async () => {
      assembled += 1;
      return MIXED;
    }) as never;
    const response = await request(app()).get(`/api/route-intelligence/rwa/stock-action/${draft}`);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'stock_action_draft_expired');
    assert.equal(assembled, 0);
  });

  test('the review re-assembles the exact question rather than remembering it', async () => {
    const seen: unknown[] = [];
    rwaMarketRealityRuntime.assemble = (async (_deps: unknown, question: unknown) => {
      seen.push(question);
      return MIXED;
    }) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [
      {
        underlyingKey: MIXED.question.underlyingKey,
        direction: MIXED.question.direction,
        requestedCashAtomic: MIXED.question.requestedCashAtomic,
        destination: 'USDC',
      },
    ]);
    assert.equal(response.body.outcome, 'review');
    // Nothing here is executable, and the literals say so.
    assert.equal(response.body.confirmed, false);
    assert.equal(response.body.executableActionAvailable, false);
    assert.equal(response.body.createsApproval, false);
    assert.equal(response.body.createsCalldata, false);
    assert.equal(response.body.createsTransaction, false);
  });

  test('expired market evidence is reported as expired, never promoted', async () => {
    // The same draft, opened long after the quote it was prepared beside.
    const later = new Date(NOW.getTime() + 45 * 60 * 1000);
    const draft = draftFor({ ttlMs: 60 * 60 * 1000 });
    rwaMarketRealityRuntime.now = () => later;
    const response = await request(app()).get(`/api/route-intelligence/rwa/stock-action/${draft}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'review');
    assert.equal(response.body.evidenceState, 'expired_quote');
    assert.notEqual(response.body.evidenceState, 'fresh_quote');
  });

  test('the review states whether this wallet may move this token', async () => {
    // The third axis. Everything else on this response is about the market; a
    // B20 transfer policy can deny one address while the market is healthy, and
    // every reviewed Coinbase representation points its scopes at a live
    // blocklist.
    rwaMarketRealityRuntime.eligibility = (async () => ({
      tokenAddress: '0xb20000000000000000000078ee7ce2fe4908108c',
      wallet: '0x1111111111111111111111111111111111111111',
      executor: null,
      blockTag: '0x1',
      blockNumber: '1',
      transferPause: { state: 'not_paused', reason: null },
      scopes: [
        { scope: 'transfer_sender', subject: 'wallet', account: '0x1111111111111111111111111111111111111111', verdict: 'denied', policyId: '5', policyType: 'blocklist', reason: null },
        { scope: 'transfer_receiver', subject: 'wallet', account: '0x1111111111111111111111111111111111111111', verdict: 'authorized', policyId: '5', policyType: 'blocklist', reason: null },
        { scope: 'transfer_executor', subject: 'executor', account: null, verdict: 'not_established', policyId: '5', policyType: 'blocklist', reason: 'The contract that would move this token is not known at this step, so its permission was not checked.' },
      ],
    })) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'review');
    // The two scopes stay apart. A collapsed "can trade" bit would hide which
    // side of the transfer the policy actually applies to.
    assert.deepEqual(
      response.body.transferEligibility.scopes.map((scope: { scope: string; verdict: string }) => [
        scope.scope,
        scope.verdict,
      ]),
      [
        ['transfer_sender', 'denied'],
        ['transfer_receiver', 'authorized'],
        ['transfer_executor', 'not_established'],
      ],
    );
    // A policy verdict never becomes an execution gate on this response.
    assert.equal(response.body.executableActionAvailable, false);
    // Phase 17.5 — and the same read, asked as the question `confirm` asks. The
    // draft is a SELL, so the sender scope governs and this wallet is denied.
    // The reader learns that here, while reading, rather than at the button.
    assert.equal(response.body.transferGate.state, 'denied');
    assert.equal(response.body.transferGate.governingScope, 'transfer_sender');
    assert.equal(response.body.transferGate.cause, 'wallet_not_authorized');
    // Still a review, still not executable: publishing the verdict is not
    // acting on it.
    assert.equal(response.body.outcome, 'review');
  });

  test('a chain that could not be read leaves the policy question unanswered, not open', async () => {
    // Null, and never an empty-but-present shape: a surface with no verdict has
    // to render nothing, because "no restriction found" and "we did not look"
    // are the two states this product exists to keep apart.
    rwaMarketRealityRuntime.eligibility = (async () => null) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.transferEligibility, null);
  });

  test('the review asks about no executor, and says so rather than assuming the wallet', async () => {
    // A sell moves the token through a router under `transferFrom`, and this
    // build chooses that router AFTER the review. Passing the wallet in the
    // executor's place would answer a different question and label it as this
    // one; passing nothing and reporting `not_established` is the honest state.
    const asked: unknown[] = [];
    rwaMarketRealityRuntime.eligibility = (async (input: unknown) => {
      asked.push(input);
      return null;
    }) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.equal(asked.length, 1);
    const input = asked[0] as { wallet: string; executor: unknown };
    assert.equal(input.executor, null);
    assert.notEqual(input.executor, input.wallet);
  });

  test('a chain read that throws never costs the reader the review', async () => {
    // The whole handler runs inside one try/catch, so an unguarded socket error
    // in this addition would return a 500 and lose the market answer, the
    // evidence state and the board — over a question the reader could have gone
    // without.
    rwaMarketRealityRuntime.eligibility = (async () => {
      throw new Error('socket hang up');
    }) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'review');
    assert.equal(response.body.transferEligibility, null);
    // The rest of the review is untouched by the failure.
    assert.equal(response.body.evidenceState, 'fresh_quote');
  });

  test('a reviewed policy that changed under the draft stops the review', async () => {
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor({ policy: `0x${'ab'.repeat(32)}` })}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refused');
    assert.equal(response.body.reason, 'route_policy_changed');
    assert.equal(response.body.executableActionAvailable, false);
  });

  test('a representation that has since gone to zero supply refuses at review', async () => {
    rwaMarketRealityRuntime.assemble = (async () => CASE('E')) as never;
    const response = await request(app()).get(
      `/api/route-intelligence/rwa/stock-action/${draftFor()}`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'refused');
    // The wrapper's own address is not in this answer either way — what matters
    // is that the review stops instead of resolving to whatever it can find.
    assert.ok(['representation_not_reviewed', 'zero_supply_representation'].includes(response.body.reason));
    assert.equal(response.body.executableActionAvailable, false);
  });
});

// ---------------------------------------------------------------------------
// Phase 17.5 — the issuer's own rule, at the step that hands over authority.
//
// Confirm is where a clearance is minted: the authority to ask this server for
// an unsigned request. Everything it checked before this was about the MARKET.
// The token's own answer about whether this wallet may move it at all was read
// one step earlier, rendered, and then not consulted by anything.
//
// Two properties, and the second is the one that is easy to get wrong: a
// measured denial refuses, and NOTHING ELSE DOES. A throttled RPC telling a
// holder they are blocked would be our failure wearing the issuer's name.
// ---------------------------------------------------------------------------
describe('POST confirming a stock action asks the issuer’s policy first', () => {
  const CASE = (id: string) => STOCKS_BENCH_CORPUS_V1.find((row) => row.id === id)!.reality;
  const MIXED = CASE('J');
  const COINBASE = STOCKS_BENCH_ADDRESSES_V1.COINBASE_NVDA;
  const NOW = new Date(STOCKS_BENCH_NOW_V1);

  const scope = (name: string, verdict: string) => ({
    scope: name,
    subject: name === 'transfer_executor' ? 'executor' : 'wallet',
    account: name === 'transfer_executor' ? null : WALLET,
    verdict,
    policyId: '5',
    policyType: 'blocklist',
    reason: null,
  });
  const eligibility = (over: {
    paused?: string;
    sender?: string;
    receiver?: string;
  } = {}) => ({
    tokenAddress: COINBASE,
    wallet: WALLET,
    executor: null,
    blockTag: '0x1',
    blockNumber: '1',
    transferPause: { state: over.paused ?? 'not_paused', reason: null },
    scopes: [
      scope('transfer_sender', over.sender ?? 'authorized'),
      scope('transfer_receiver', over.receiver ?? 'authorized'),
      scope('transfer_executor', 'not_established'),
    ],
  });

  const draftFor = (overrides: Record<string, unknown> = {}) => {
    const representation = MIXED.representations.find((row) => row.tokenAddress === COINBASE)!;
    return issueStockActionDraftV1({
      tenantId: USER.id,
      walletAddress: WALLET,
      secret: 'confirm-test-secret',
      now: NOW,
      handoff: {
        schemaVersion: 'stock-execution-handoff/v1',
        intent: 'inspect_route',
        chainId: 8453,
        tokenAddress: COINBASE,
        caip10: `eip155:8453:${COINBASE}`,
        underlyingKey: MIXED.question.underlyingKey,
        issuerId: representation.issuerId,
        issuerInstrumentKey: representation.issuerInstrumentKey,
        representationKind: representation.representationKind,
        direction: MIXED.question.direction,
        requestedCashAtomic: MIXED.question.requestedCashAtomic,
        cashAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        destination: 'USDC',
        routePolicyKey: representation.routePolicyKey!,
        approvedSources: ['kyberswap'],
        evidenceState: 'fresh_quote',
        quoteExpiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
        sizeBasis: 'cash_equivalent_requires_replan',
        createsApproval: false,
        createsCalldata: false,
        createsTransaction: false,
        quoteIsExecutionEvidence: false,
        ...(overrides.direction === 'buy' ? { sizeBasis: 'exact_cash_in', exactTokenAtomic: null } : {}),
        ...overrides,
      } as never,
    }).draft;
  };

  // The draft under test is a SELL, and a SELL is confirmed in TOKEN atoms —
  // so every call here carries the exact amount a holder would have confirmed
  // on the screen, and the balance read below is what bounds it.
  const SELL_TOKENS_V1 = '4000000000000000000';
  const HELD_TOKENS_V1 = '9000000000000000000';
  const confirm = (body: Record<string, unknown> = { tokenAmountAtomic: SELL_TOKENS_V1 }) =>
    request(app()).post(`/api/route-intelligence/rwa/stock-action/${draftFor()}/confirm`).send(body);

  const WORD_18_V1 = `0x${(18).toString(16).padStart(64, '0')}`;
  const holdingReader = (balanceAtomic = HELD_TOKENS_V1) => ({
    async readBlockAnchor() {
      return { ok: true as const, value: { blockTag: '0x1' } };
    },
    async call({ data }: { to: string; data: string; blockTag: string }) {
      // `decimals()` is 0x313ce567; `balanceOf(address)` is 0x70a08231.
      if (data.startsWith('0x313ce567')) return { ok: true as const, value: WORD_18_V1 };
      if (data.startsWith('0x70a08231')) {
        return {
          ok: true as const,
          value: `0x${BigInt(balanceAtomic).toString(16).padStart(64, '0')}`,
        };
      }
      return { ok: false as const, reason: 'execution_reverted' };
    },
  });

  // ------------------------------------------------------------------
  // Phase 17.9 — the routers, asked about the exact amount being confirmed.
  //
  // Stubbed as a seam so a test can make them refuse this size, or fail to
  // answer at all, and assert which of those two sentences the reader gets.
  // They are opposite claims: one is about the market, one is about us.
  // ------------------------------------------------------------------
  const rungFor = (tokenAmountAtomic: string, status = 'full') => ({
    sizeKind: 'actual_position' as const,
    requestedCashAtomic: null,
    requestedTokenAtomic: tokenAmountAtomic,
    tokenDecimals: 18,
    destination: 'USDC' as const,
    destinationAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    destinationDecimals: 6 as const,
    status,
    exactTestedTokenAtomic: tokenAmountAtomic,
    exactExecutableTokenAtomic: tokenAmountAtomic,
    returnedAtomic: status === 'full' ? '412500' : null,
    roundTripCostBps: null,
    lowerBoundRequestedCashAtomic: null,
    derivedFromExactRung: false,
    interpolated: false as const,
    evidenceStrength: 'router_quote' as const,
    executionProven: false as const,
    approvedSources: ['kyberswap'],
    sources: [
      {
        source: 'kyberswap',
        status: status === 'full' ? 'full' : 'unavailable',
        errorCode: null,
        observedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
        buyEvidenceHash: null,
        sellEvidenceHash: null,
      },
    ],
    quoteEvidence: [],
    simulationEvidence: {
      status: 'not_simulated',
      kind: 'route_simulation',
      candidateHash: null,
      evidenceHash: null,
      observedAt: null,
      blockNumber: null,
    },
    observedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
    lastMeasured: null,
  });
  let askedAmounts: string[] = [];

  beforeEach(() => {
    process.env.SESSION_SECRET = 'confirm-test-secret';
    process.env.BASE_MAINNET_RPC_URL = 'https://mainnet.base.org';
    rwaMarketRealityRuntime.migrationAvailable = async () => true;
    rwaMarketRealityRuntime.now = () => NOW;
    rwaMarketRealityRuntime.assemble = (async () => MIXED) as never;
    rwaMarketRealityRuntime.eligibility = (async () => eligibility()) as never;
    rwaMarketRealityRuntime.useAccessReader = (() => holdingReader()) as never;
    askedAmounts = [];
    stockSellTermsLimiterV1.reset();
    rwaMarketRealityRuntime.sellTerms = (async (input: { tokenAmountAtomic: string }) => {
      askedAmounts.push(input.tokenAmountAtomic);
      return { status: 'established', rung: rungFor(input.tokenAmountAtomic) };
    }) as never;
    rwaMarketRealityRuntime.cashExit = (() => ({})) as never;
    rwaMarketRealityRuntime.quoteAdapters = (() => []) as never;
    rwaMarketRealityRuntime.capture = (() => undefined) as never;
  });

  test('the routers are asked about the amount being confirmed, not the draft’s cash size', async () => {
    // The defect this closes. The board is assembled at the draft's CASH size
    // and cannot answer a token question; confirming against it approved a
    // picture of a different trade. `Use available balance` made that the
    // easiest path on the screen.
    const response = await confirm({ tokenAmountAtomic: HELD_TOKENS_V1 });
    assert.equal(response.status, 200);
    assert.deepEqual(askedAmounts, [HELD_TOKENS_V1]);
    // And the answer travels with the confirmation, so a reader can check that
    // the size they approved is the size that was priced.
    assert.equal(response.body.confirmedTerms.tokenAmountAtomic, HELD_TOKENS_V1);
    assert.equal(response.body.confirmedTerms.status, 'established');
    assert.equal(response.body.confirmedTerms.createsTransaction, false);
  });

  test('a size the routers will not take mints nothing, and says it is about the size', async () => {
    rwaMarketRealityRuntime.sellTerms = (async (input: { tokenAmountAtomic: string }) => ({
      status: 'no_route',
      rung: rungFor(input.tokenAmountAtomic, 'unavailable'),
    })) as never;
    const response = await confirm();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'stock_action_sell_size_unroutable');
    assert.equal(response.body.clearance, undefined);
    // A market fact about THIS size. Never about the token or the holder.
    assert.match(response.body.detail, /this size/i);
    assert.doesNotMatch(response.body.detail, /cannot be sold|no market for/i);
  });

  test('terms Miorail could not establish are ours, and never a verdict on the market', async () => {
    rwaMarketRealityRuntime.sellTerms = (async () => ({
      status: 'not_established',
      code: 'stock_sell_terms_measurement_failed',
    })) as never;
    const response = await confirm();
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'stock_sell_terms_measurement_failed');
    assert.equal(response.body.clearance, undefined);
    assert.match(response.body.detail, /about Miorail/i);
    assert.doesNotMatch(response.body.detail, /no route|unavailable market/i);
  });

  test('a buy carries no second size, so it establishes no terms', async () => {
    const response = await request(app())
      .post(`/api/route-intelligence/rwa/stock-action/${draftFor({ direction: 'buy' })}/sell-terms`)
      .send({ tokenAmountAtomic: SELL_TOKENS_V1 });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'stock_action_terms_sell_only');
  });

  test('the sell-terms call answers for one exact amount and authorises nothing', async () => {
    const response = await request(app())
      .post(`/api/route-intelligence/rwa/stock-action/${draftFor()}/sell-terms`)
      .send({ tokenAmountAtomic: SELL_TOKENS_V1 });
    assert.equal(response.status, 200);
    assert.equal(response.body.terms.tokenAmountAtomic, SELL_TOKENS_V1);
    assert.equal(response.body.terms.status, 'established');
    assert.equal(response.body.holding.balanceAtomic, HELD_TOKENS_V1);
    // Measuring is not confirming.
    assert.equal(response.body.confirmed, false);
    assert.equal(response.body.executableActionAvailable, false);
    assert.equal(response.body.createsCalldata, false);
  });

  test('establishing terms is bounded, because every one spends router calls', async () => {
    const ask = () =>
      request(app())
        .post(`/api/route-intelligence/rwa/stock-action/${draftFor()}/sell-terms`)
        .send({ tokenAmountAtomic: SELL_TOKENS_V1 });
    for (let i = 0; i < STOCK_SELL_TERMS_PER_MINUTE_V1; i += 1) {
      assert.equal((await ask()).status, 200);
    }
    const refused = await ask();
    assert.equal(refused.status, 429);
    assert.equal(refused.body.code, 'stock_sell_terms_rate_limited');
    // The point: the refusal happens before it spends, so the budget bounds
    // router calls rather than merely reporting on them.
    assert.equal(askedAmounts.length, STOCK_SELL_TERMS_PER_MINUTE_V1);
  });

  test('an amount above the holding is refused before any router is asked', async () => {
    const response = await request(app())
      .post(`/api/route-intelligence/rwa/stock-action/${draftFor()}/sell-terms`)
      .send({ tokenAmountAtomic: '9000000000000000001' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'stock_action_sell_exceeds_balance');
    assert.deepEqual(askedAmounts, []);
  });

  test('a sell with no confirmed token amount mints nothing', async () => {
    // The state this surface refused for months. It still refuses — it just no
    // longer refuses every sell.
    const response = await confirm({});
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'stock_action_sell_requires_exact_size');
    assert.equal(response.body.confirmed, false);
    assert.equal(response.body.clearance, undefined);
    assert.match(response.body.detail, /exact number of token atoms/);
  });

  test('a sell larger than the holding is refused, with the holding shown', async () => {
    const response = await confirm({ tokenAmountAtomic: '9000000000000000001' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'stock_action_sell_exceeds_balance');
    assert.equal(response.body.clearance, undefined);
    // Checkable rather than trustworthy: the number and the block it came from.
    assert.equal(response.body.holding.balanceAtomic, HELD_TOKENS_V1);
    assert.equal(response.body.holding.blockTag, '0x1');
  });

  test('selling the exact holding is allowed — "everything" is a number here', async () => {
    const response = await confirm({ tokenAmountAtomic: HELD_TOKENS_V1 });
    assert.equal(response.status, 200);
    assert.equal(response.body.confirmed, true);
    assert.equal(response.body.confirmedSize.sizeBasis, 'exact_token_in');
    assert.equal(response.body.confirmedSize.tokenAmountAtomic, HELD_TOKENS_V1);
  });

  test('a holding this server could not read confirms nothing either way', async () => {
    rwaMarketRealityRuntime.useAccessReader = (() => ({
      async readBlockAnchor() {
        return { ok: false as const, reason: 'endpoint_unavailable' };
      },
      async call() {
        return { ok: false as const, reason: 'endpoint_unavailable' };
      },
    })) as never;
    const response = await confirm();
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'stock_action_balance_unread');
    assert.equal(response.body.clearance, undefined);
    // Our read failed. That is not "you do not hold the tokens".
    assert.doesNotMatch(response.body.detail, /do not hold|insufficient/i);
  });

  test('a wallet the issuer denies gets no clearance at all', async () => {
    // The draft is a SELL, so the sender scope governs.
    rwaMarketRealityRuntime.eligibility = (async () => eligibility({ sender: 'denied' })) as never;
    const response = await confirm();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'issuer_transfer_policy_denied');
    assert.equal(response.body.confirmed, false);
    assert.equal(response.body.executableActionAvailable, false);
    // No clearance is minted, so nothing downstream can be asked for a request.
    assert.equal(response.body.clearance, undefined);
    // The refusal names the issuer as its author and carries the block it was
    // read at, so a reader can check it rather than take our word.
    assert.match(response.body.detail, /issuer/i);
    assert.equal(response.body.transferGate.blockTag, '0x1');
  });

  test('a paused contract refuses everyone, and says the pause is not about them', async () => {
    rwaMarketRealityRuntime.eligibility = (async () => eligibility({ paused: 'paused' })) as never;
    const response = await confirm();
    assert.equal(response.status, 409);
    assert.equal(response.body.transferGate.cause, 'transfers_paused');
    assert.match(response.body.detail, /not a statement about you/);
  });

  test('only the scope that governs this direction can refuse it', async () => {
    // A SELL, and a wallet that may not RECEIVE. Nobody is receiving. Refusing
    // here would refuse on a rule about a transfer that is not happening.
    rwaMarketRealityRuntime.eligibility = (async () => eligibility({ receiver: 'denied' })) as never;
    const response = await confirm();
    assert.equal(response.status, 200);
    assert.equal(response.body.confirmed, true);
    assert.equal(response.body.transferGate.state, 'authorized');
  });

  test('a policy that was never read never refuses', async () => {
    // Every shape of "we did not learn it". Each one proceeds: this gate fails
    // open by construction, because a false denial is indistinguishable from a
    // real one and would be OUR failure wearing the issuer's name.
    const unread = [
      async () => null,
      async () => {
        throw new Error('socket hang up');
      },
      async () => eligibility({ sender: 'not_established' }),
      async () => ({ ...eligibility(), scopes: [] }),
    ];
    for (const impl of unread) {
      rwaMarketRealityRuntime.eligibility = impl as never;
      const response = await confirm();
      assert.equal(response.status, 200, 'an unanswered policy must never refuse');
      assert.equal(response.body.confirmed, true);
      assert.equal(response.body.transferGate.state, 'not_established');
      assert.ok(typeof response.body.clearance === 'string' && response.body.clearance.length > 0);
    }
  });

  test('a confirmation records the verdict, and stays non-executable', async () => {
    const response = await confirm();
    assert.equal(response.status, 200);
    assert.equal(response.body.confirmed, true);
    assert.equal(response.body.transferGate.state, 'authorized');
    assert.equal(response.body.transferGate.governingScope, 'transfer_sender');
    // The notice travels with the confirmation: who issued this is not a UI
    // decoration, it is part of what was confirmed.
    assert.match(response.body.issuerNotice, /issued by Coinbase/);
    // Every standing literal is untouched. Confirming is not approving.
    assert.equal(response.body.approvalRequired, true);
    assert.equal(response.body.executableActionAvailable, false);
    assert.equal(response.body.createsApproval, false);
    assert.equal(response.body.createsCalldata, false);
    assert.equal(response.body.createsTransaction, false);
  });

  test('the policy is asked about this session’s wallet and no executor', async () => {
    const asked: { wallet?: string; executor?: unknown; tokenAddress?: string }[] = [];
    rwaMarketRealityRuntime.eligibility = (async (input: never) => {
      asked.push(input);
      return eligibility();
    }) as never;
    await confirm();
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.wallet, WALLET);
    assert.equal(asked[0]!.tokenAddress, COINBASE);
    // No router has been chosen at this step, so the executor scope is asked
    // about nothing rather than about the wallet — and `not_established` cannot
    // refuse. Passing the wallet here would answer a different question.
    assert.equal(asked[0]!.executor, null);
  });
});

// ---------------------------------------------------------------------------
// Phase 17.5 — a second, independent reading of the price.
//
// Every `full` observation on the tokenized-stock corpus comes from ONE source.
// This route is the first thing that can disagree with it. What it must never
// do is be mistaken for it.
// ---------------------------------------------------------------------------
describe('GET one Aerodrome pool’s own marginal price', () => {
  const POOL = '0x853f5f1b92b16714fe6cda67caad0856b83c7ab9';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const NVDAC = '0xb20000000000000000000078ee7ce2fe4908108c';
  const FACTORY = '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
  const VOTER = '0x16613524e02ad97edfef371bc883f2f5d6c480a5';
  const SQRT = 52029507624582080717065656647n;
  const word = (value: bigint | string) =>
    `0x${(typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0')}`;

  // Keyed by target and selector, so the fake answers what was asked rather
  // than the order the implementation happens to ask in.
  const answers = (over: Record<string, string | null> = {}): Record<string, string | null> => ({
    [`${POOL}:c45a0155`]: word(FACTORY), // factory()
    [`${FACTORY}:46c96aac`]: word(VOTER), // voter()
    [`${POOL}:3850c7bd`]: word(SQRT) + '0'.repeat(64 * 5), // slot0()
    [`${POOL}:0dfe1681`]: word(USDC), // token0()
    [`${POOL}:d21220a7`]: word(NVDAC), // token1()
    [`${USDC}:313ce567`]: word(6n),
    [`${NVDAC}:313ce567`]: word(8n),
    ...over,
  });

  const reader = (over: Record<string, string | null> = {}) => {
    const table = answers(over);
    return {
      async readBlockAnchor() {
        return { ok: true as const, value: { blockTag: '0x2222' } };
      },
      async call(input: { to: string; data: string }) {
        const value = table[`${input.to.toLowerCase()}:${input.data.slice(2, 10)}`];
        return value ? { ok: true as const, value } : { ok: false as const, reason: 'transport' };
      },
      async callMany() {
        return [];
      },
    };
  };

  beforeEach(() => {
    rwaMarketRealityRuntime.clSpotReader = (() => reader()) as never;
  });

  test('a signed-out reader is refused before any chain read', async () => {
    let called = 0;
    rwaMarketRealityRuntime.clSpotReader = (() => {
      called += 1;
      return reader();
    }) as never;
    const response = await request(app(null)).get(
      `/api/route-intelligence/rwa/pool-spot/${POOL}`,
    );
    assert.equal(response.status, 401);
    assert.equal(called, 0);
  });

  test('only an exact address is accepted', async () => {
    const response = await request(app()).get('/api/route-intelligence/rwa/pool-spot/NVDA');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'exact_address_required');
  });

  test('the reading matches what the pool itself says, and carries the raw word', async () => {
    const response = await request(app()).get(`/api/route-intelligence/rwa/pool-spot/${POOL}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'read');
    assert.equal(response.body.token0PerToken1, '231.878101242070949243');
    assert.equal(response.body.sqrtPriceX96, SQRT.toString());
    // One block for every field. Two reads at two blocks are two facts.
    assert.equal(response.body.blockTag, '0x2222');
    // The disclaimer is in the PAYLOAD, not only in a stylesheet: a consumer
    // that renders the number without the sentence is rendering a quote.
    assert.equal(response.body.isQuote, false);
    assert.match(response.body.note, /not a quote/i);
    assert.match(response.body.note, /no size/i);
  });

  test('the payload carries nothing that would make it executable', async () => {
    const response = await request(app()).get(`/api/route-intelligence/rwa/pool-spot/${POOL}`);
    for (const forbidden of [
      'amountIn',
      'amountOut',
      'minimumOut',
      'slippage',
      'route',
      'calls',
      'calldata',
      'expiresAt',
    ]) {
      assert.equal(response.body[forbidden], undefined, `a marginal price must not carry ${forbidden}`);
    }
  });

  test('an address that is not an Aerodrome pool is a finding about the address', async () => {
    const response = await request(app())
      .get(`/api/route-intelligence/rwa/pool-spot/${POOL}`)
      .then(async () => {
        rwaMarketRealityRuntime.clSpotReader = (() =>
          reader({ [`${POOL}:c45a0155`]: word('0x1234567890123456789012345678901234567890') })) as never;
        return request(app()).get(`/api/route-intelligence/rwa/pool-spot/${POOL}`);
      });
    assert.equal(response.status, 200);
    assert.equal(response.body.outcome, 'unavailable');
    assert.equal(response.body.reason, 'not_aerodrome_cl');
    // No price is claimed for it, in either direction.
    assert.equal(response.body.token0PerToken1, undefined);
  });

  test('a read that did not complete is stated as ours, not as the market’s', async () => {
    rwaMarketRealityRuntime.clSpotReader = (() => reader({ [`${POOL}:3850c7bd`]: null })) as never;
    const response = await request(app()).get(`/api/route-intelligence/rwa/pool-spot/${POOL}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.reason, 'unreadable');
    assert.match(response.body.detail, /about Miorail’s read/);
  });

  test('a server with no chain says so rather than offering a reading', async () => {
    rwaMarketRealityRuntime.clSpotReader = (() => null) as never;
    const response = await request(app()).get(`/api/route-intelligence/rwa/pool-spot/${POOL}`);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'market_reality_chain_unavailable');
  });
});

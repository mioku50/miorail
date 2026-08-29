import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, describe } from 'node:test';
import express from 'express';
import request from 'supertest';
import { InMemoryMarketRealityRadarRepositoryV1 } from '@mioagent/rwa-market-reality';

import { rwaMarketRealityRouter, rwaMarketRealityRuntime } from './rwaMarketReality.js';

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
      entries: [
        {
          underlyingKey: UNDERLYING,
          canonicalName: 'NVIDIA Corporation',
          displaySymbol: null,
          assetClass: 'equity' as const,
          identifierScheme: 'isin',
          identifierValue: 'US67066G1040',
          representationCount: 3,
          issuerIds: ['backed' as const, 'coinbase' as const],
          multiIssuer: true,
        },
      ],
      totals: { underlyings: 19, boundRepresentations: 25, multiIssuerUnderlyings: 2 },
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
